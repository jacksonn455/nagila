// Backend simulado para testar as Netlify Functions direto no Node, sem rede.
// - Supabase: tabelas em memória com o subconjunto do PostgREST usado pelas Functions
//   (filtros eq / in / not.is.null, limit, upsert por on_conflict, PATCH)
// - Mercado Pago: criação de preferência e consulta de pagamento
// - Melhor Envio: cotação de frete
// - Discord: webhook de aviso de venda (mensagens em `discord.messages`)
// - Mercado Livre: OAuth (code + PKCE, refresh de uso único), /users/me, /orders, /shipments
// Cada chamada fica registrada em `calls` para as verificações dos testes.

const crypto = require('crypto');

const BOOK_ENV = {
  BOOK_TITLE: 'Pós-operatório e o raciocínio diante da cirurgia plástica',
  BOOK_PRICE_CENTS: '39990',
  BOOK_WEIGHT_GRAMS: '260',
  BOOK_LENGTH_CM: '23',
  BOOK_WIDTH_CM: '16',
  BOOK_HEIGHT_CM: '2',
  BOOK_MAX_QUANTITY: '3',
  SUPABASE_URL: 'https://supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
  MERCADOPAGO_ACCESS_TOKEN: 'test-mp-token',
  MELHOR_ENVIO_TOKEN: 'test-me-token',
  ORIGIN_CEP: '99700-000',
  SITE_URL: 'https://site.test',
  PAYMENT_WEBHOOK_URL: 'https://site.test/.netlify/functions/paymentWebhook'
};

// Variáveis que um teste pode ter definido e que não fazem parte do BOOK_ENV
const OPTIONAL_ENV = [
  'BOOK_STOCK',
  'MERCADOPAGO_WEBHOOK_SECRET',
  'MELHOR_ENVIO_SERVICES',
  'MELHOR_ENVIO_ENV',
  'PICKUP_ENABLED',
  'PICKUP_ADDRESS',
  'URL',
  'ADMIN_EMAIL',
  'ADMIN_PASSWORD_HASH',
  'ADMIN_SESSION_SECRET',
  'DISCORD_WEBHOOK_URL',
  'MERCADO_LIVRE_CLIENT_ID',
  'MERCADO_LIVRE_CLIENT_SECRET',
  'MERCADO_LIVRE_REDIRECT_URI',
  'MERCADO_LIVRE_WEBHOOK_URL',
  'MERCADO_LIVRE_TOKEN_ENCRYPTION_KEY',
  'MERCADO_LIVRE_DISCORD_WEBHOOK_URL',
  'MERCADO_LIVRE_BOOK_ITEM_IDS',
  'MERCADO_LIVRE_BACKGROUND_PROCESSING'
];

// Cotação padrão do Melhor Envio (inclui um serviço fora da lista e um com erro)
const ME_QUOTE = [
  { id: 2, name: 'SEDEX', company: { name: 'Correios' }, price: '49.47', delivery_time: 2 },
  { id: 1, name: 'PAC', company: { name: 'Correios' }, price: '25.75', delivery_time: 6 },
  { id: 3, name: '.Package', company: { name: 'Jadlog' }, price: '29.11', custom_price: '28.00', delivery_time: 8 },
  { id: 17, name: 'Mini Envios', company: { name: 'Correios' }, price: '12.00', delivery_time: 9 },
  { id: 4, name: '.Com', company: { name: 'Jadlog' }, error: 'Serviço indisponível' }
];

function reply(body, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => (body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body))
  };
}

// Filtros do PostgREST: col=eq.v | col=in.(a,b) | col=not.is.null | col=gte.v
function matches(row, params) {
  for (const [key, raw] of params) {
    if (['select', 'order', 'limit', 'on_conflict'].includes(key)) continue;
    // filtro em recurso embutido (ex.: orders.status com select=...,orders!inner(status))
    const value = key.includes('.') ? key.split('.').reduce((v, k) => (v == null ? v : v[k]), row) : row[key];
    if (raw.startsWith('eq.')) {
      if (String(value) !== raw.slice(3)) return false;
    } else if (raw.startsWith('in.(')) {
      if (!raw.slice(4, -1).split(',').includes(String(value))) return false;
    } else if (raw.startsWith('lte.')) {
      if (!(String(value) <= raw.slice(4))) return false;
    } else if (raw === 'not.is.null') {
      if (value == null) return false;
    } else if (raw.startsWith('gte.')) {
      if (!(String(value) >= raw.slice(4))) return false;
    } else if (raw.startsWith('lt.')) {
      if (!(String(value) < raw.slice(3))) return false;
    } else {
      throw new Error(`Filtro não suportado pelo simulador: ${key}=${raw}`);
    }
  }
  return true;
}

function createBackend(options = {}) {
  const db = {
    customers: [],
    orders: [],
    order_items: [],
    addresses: [],
    payments: [],
    shipments: [],
    processed_notifications: [],
    admin_login_attempts: [],
    marketplace_integrations: []
  };
  const calls = [];
  const mp = {
    preferenceFails: false,
    payments: {}, // id -> objeto de pagamento do Mercado Pago
    paymentFetchFails: false
  };
  const me = { quote: ME_QUOTE, fails: false, lastPayload: null };
  const discord = { fails: false, messages: [], urls: [] };
  // Supabase: tabelas cuja escrita falha (simula banco fora do ar)
  const supabase = { failWrites: new Set() };

  // API do Mercado Livre simulada. Refresh token é de uso único, como na API real.
  let mlSeq = 0;
  const ml = {
    clientId: '1234567890',
    clientSecret: 'test-ml-secret',
    seller: { id: 7777, nickname: 'LOJA_NZ' },
    codes: {}, // code -> { challenge, redirect_uri }
    accessTokens: new Set(),
    refreshTokens: new Set(),
    orders: {}, // id -> pedido
    shipments: {}, // id -> envio
    tokenCalls: [],
    apiFails: false,
    tokenFails: false,
    // emite um par de tokens válido (para semear a integração nos testes)
    issue() {
      mlSeq += 1;
      const pair = { access_token: `APP_USR-access-${mlSeq}-${crypto.randomBytes(6).toString('hex')}`, refresh_token: `TG-refresh-${mlSeq}-${crypto.randomBytes(6).toString('hex')}` };
      ml.accessTokens.add(pair.access_token);
      ml.refreshTokens.add(pair.refresh_token);
      return { ...pair, token_type: 'Bearer', expires_in: 21600, scope: 'offline_access read', user_id: ml.seller.id };
    }
  };
  Object.assign(mp, options.mp);
  Object.assign(me, options.me);

  function insert(table, body, onConflict, prefer) {
    const rows = Array.isArray(body) ? body : [body];
    const out = [];
    for (const data of rows) {
      const keys = onConflict ? onConflict.split(',') : null;
      const existing = keys && db[table].find((r) => keys.every((k) => r[k] != null && String(r[k]) === String(data[k])));
      if (existing) {
        if ((prefer || '').includes('ignore-duplicates')) continue;
        Object.assign(existing, data);
        out.push(existing);
        continue;
      }
      const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...data };
      if (table === 'orders' && !row.status) row.status = 'pending';
      db[table].push(row);
      out.push(row);
    }
    return out;
  }

  async function fetchImpl(url, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    let body;
    if (opts.body) {
      try {
        body = JSON.parse(opts.body);
      } catch {
        body = String(opts.body); // form-urlencoded (OAuth do Mercado Livre)
      }
    }
    const u = new URL(String(url));
    calls.push({ url: String(url), method, body, headers: opts.headers || {} });

    // Mercado Pago
    if (u.hostname === 'api.mercadopago.com') {
      if (u.pathname === '/checkout/preferences' && method === 'POST') {
        if (mp.preferenceFails) return reply({ message: 'erro simulado' }, 500);
        const id = `pref-${calls.filter((c) => c.url.includes('/checkout/preferences')).length}`;
        return reply({ id, init_point: `https://mp.test/checkout/${id}` });
      }
      if (u.pathname === '/v1/payments/search' && method === 'GET') {
        if (mp.paymentFetchFails) return reply({ message: 'erro simulado' }, 500);
        const ref = u.searchParams.get('external_reference');
        return reply({ results: Object.values(mp.payments).filter((p) => p.external_reference === ref) });
      }
      const m = u.pathname.match(/^\/v1\/payments\/(.+)$/);
      if (m && method === 'GET') {
        if (mp.paymentFetchFails) return reply({ message: 'erro simulado' }, 500);
        const payment = mp.payments[decodeURIComponent(m[1])];
        return payment ? reply(payment) : reply({ message: 'not found' }, 404);
      }
    }

    // Melhor Envio
    if (u.pathname === '/api/v2/me/shipment/calculate') {
      me.lastPayload = body;
      if (me.fails) return reply('erro simulado', 500);
      return reply(me.quote);
    }

    // Mercado Livre
    if (u.hostname === 'api.mercadolibre.com') {
      if (u.pathname === '/oauth/token' && method === 'POST') {
        const f = Object.fromEntries(new URLSearchParams(body));
        ml.tokenCalls.push(f);
        if (ml.tokenFails) return reply({ error: 'internal_error' }, 500);
        if (f.client_id !== ml.clientId || f.client_secret !== ml.clientSecret) return reply({ error: 'invalid_client' }, 401);
        if (f.grant_type === 'authorization_code') {
          const entry = ml.codes[f.code];
          delete ml.codes[f.code]; // código de uso único
          const challenge = f.code_verifier && crypto.createHash('sha256').update(f.code_verifier).digest('base64url');
          if (!entry || entry.challenge !== challenge || entry.redirect_uri !== f.redirect_uri) return reply({ error: 'invalid_grant' }, 400);
          return reply(ml.issue());
        }
        if (f.grant_type === 'refresh_token') {
          if (!ml.refreshTokens.has(f.refresh_token)) return reply({ error: 'invalid_grant' }, 400);
          ml.refreshTokens.delete(f.refresh_token); // uso único: o antigo deixa de valer
          return reply(ml.issue());
        }
        return reply({ error: 'unsupported_grant_type' }, 400);
      }
      const auth = ((opts.headers && opts.headers.Authorization) || '').replace(/^Bearer /, '');
      if (!ml.accessTokens.has(auth)) return reply({ error: 'invalid_token' }, 401);
      if (ml.apiFails) return reply({ error: 'internal_error' }, 500);
      if (u.pathname === '/users/me') return reply({ id: ml.seller.id, nickname: ml.seller.nickname });
      let m = u.pathname.match(/^\/orders\/(\d+)$/);
      if (m) return ml.orders[m[1]] ? reply(ml.orders[m[1]]) : reply({ error: 'not_found' }, 404);
      m = u.pathname.match(/^\/shipments\/(\d+)$/);
      if (m) return ml.shipments[m[1]] ? reply(ml.shipments[m[1]]) : reply({ error: 'not_found' }, 404);
    }

    // Discord
    if (u.hostname === 'discord.test' && method === 'POST') {
      if (discord.fails) return reply('erro simulado', 500);
      discord.messages.push(body);
      discord.urls.push(String(url));
      return reply(null, 204);
    }

    // Supabase (PostgREST)
    if (u.hostname === 'supabase.test' && u.pathname.startsWith('/rest/v1/')) {
      const table = u.pathname.slice('/rest/v1/'.length);
      if (!db[table]) return reply({ message: `tabela desconhecida ${table}` }, 404);
      const params = [...u.searchParams.entries()];
      const prefer = (opts.headers && opts.headers.Prefer) || '';

      if (method === 'GET') {
        let source = db[table];
        // embed orders!inner(...) em order_items (consulta de estoque)
        if (table === 'order_items' && (u.searchParams.get('select') || '').includes('orders!inner(')) {
          source = source
            .map((item) => ({ ...item, orders: db.orders.find((o) => o.id === item.order_id) }))
            .filter((item) => item.orders);
        }
        let rows = source.filter((r) => matches(r, params));
        const order = u.searchParams.get('order');
        if (order === 'created_at.desc') rows = [...rows].reverse();
        const limit = Number(u.searchParams.get('limit'));
        if (limit) rows = rows.slice(0, limit);
        return reply(rows);
      }
      if (method !== 'GET' && supabase.failWrites.has(table)) return reply({ message: 'erro simulado' }, 503);
      if (method === 'POST') {
        const out = insert(table, body, u.searchParams.get('on_conflict'), prefer);
        return prefer.includes('return=representation') ? reply(out, 201) : reply(null, 201);
      }
      if (method === 'PATCH') {
        // simula o banco antes da migração do admin (colunas inexistentes)
        if (options.missingColumns && Object.keys(body).some((k) => options.missingColumns.includes(k))) {
          return reply({ message: 'column does not exist' }, 400);
        }
        const rows = db[table].filter((r) => matches(r, params));
        rows.forEach((r) => Object.assign(r, body));
        return prefer.includes('return=representation') ? reply(rows, 200) : reply(null, 204);
      }
      if (method === 'DELETE') {
        db[table] = db[table].filter((r) => !matches(r, params));
        return reply(null, 204);
      }
    }

    throw new Error(`Chamada não simulada: ${method} ${url}`);
  }

  return { db, calls, mp, me, discord, ml, supabase, fetchImpl };
}

// Instala o backend simulado e as variáveis do livro; devolve uma função que desfaz tudo
function install(backend, env = {}) {
  const savedEnv = { ...process.env };
  const savedFetch = global.fetch;
  OPTIONAL_ENV.forEach((k) => delete process.env[k]);
  Object.assign(process.env, BOOK_ENV, env);
  global.fetch = backend.fetchImpl;
  return () => {
    process.env = savedEnv;
    global.fetch = savedFetch;
  };
}

function handler(name) {
  return require(`../../functions/${name}/index.js`).handler;
}

async function call(name, event) {
  const res = await handler(name)(event);
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

// Assinatura x-signature do Mercado Pago (mesmo manifesto que o paymentWebhook verifica)
function mpSignature(secret, dataId, requestId, ts = '1700000000') {
  const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${ts};`;
  const v1 = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  return `ts=${ts},v1=${v1}`;
}

module.exports = { BOOK_ENV, ME_QUOTE, createBackend, install, call, mpSignature };
