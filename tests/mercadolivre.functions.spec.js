const { test, expect } = require('@playwright/test');
const crypto = require('crypto');
const { createBackend, install, call } = require('./helpers/backend');
const auth = require('../functions/_lib/adminAuth');
const ml = require('../functions/_lib/mercadoLivre');
const sync = require('../functions/_lib/mercadoLivreSync');
const { availableStock } = require('../functions/_lib/stock');

// Integração com o Mercado Livre: Functions chamadas direto no Node, com Supabase,
// API do Mercado Livre e Discord simulados (nenhuma requisição real).

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_SECRET = 'y'.repeat(48);
const KEY = Buffer.alloc(32, 7).toString('base64');
const REDIRECT = 'https://site.test/.netlify/functions/mercadoLivreOAuthCallback';
const SELLER = '7777';

let HASH;
let backend;
let restore;
let logs;
let restoreConsole;

test.beforeAll(async () => {
  HASH = await auth.hashPassword('senha-de-teste-muito-segura', { N: 1024 });
  Object.assign(ml.timing, { leaseWaitMs: 5, leaseWaitTries: 40, retryDelayMs: 1 });
});

function env(extra = {}) {
  return {
    ADMIN_EMAIL,
    ADMIN_PASSWORD_HASH: HASH,
    ADMIN_SESSION_SECRET: ADMIN_SECRET,
    MERCADO_LIVRE_CLIENT_ID: '1234567890',
    MERCADO_LIVRE_CLIENT_SECRET: 'test-ml-secret',
    MERCADO_LIVRE_REDIRECT_URI: REDIRECT,
    MERCADO_LIVRE_TOKEN_ENCRYPTION_KEY: KEY,
    DISCORD_WEBHOOK_URL: 'https://discord.test/site',
    ...extra
  };
}

// Guarda tudo o que vai para o log, para conferir que nenhum segredo aparece
function captureConsole() {
  logs = [];
  const saved = {};
  for (const k of ['log', 'warn', 'error']) {
    saved[k] = console[k];
    console[k] = (...args) => logs.push(args.map(String).join(' '));
  }
  return () => Object.assign(console, saved);
}

test.beforeEach(() => {
  backend = createBackend();
  restore = install(backend, env());
  restoreConsole = captureConsole();
});
test.afterEach(() => {
  restoreConsole();
  restore();
});

const session = () => auth.createSession(auth.adminConfig());

async function run(name, { method = 'GET', body, query, cookies = {}, headers = {}, rawBody } = {}) {
  const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await require(`../functions/${name}/index.js`).handler({
    httpMethod: method,
    queryStringParameters: query || {},
    headers: { host: 'site.test', ...(cookie ? { cookie } : {}), ...headers },
    body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try {
    json = res.body ? JSON.parse(res.body) : null;
  } catch {
    // CSV / vazio
  }
  return { status: res.statusCode, headers: res.headers || {}, body: json };
}

const adminCall = (name, opts = {}) =>
  run(name, { ...opts, cookies: { [auth.COOKIE_NAME]: session(), ...(opts.cookies || {}) }, headers: { 'x-admin-request': '1', ...(opts.headers || {}) } });

// Conecta a conta direto pela biblioteca (tokens emitidos pelo simulador)
async function seedIntegration({ expiresIn = 21600 } = {}) {
  const tokens = { ...backend.ml.issue(), expires_in: expiresIn };
  await ml.saveAuthorization(ml.requireConfig(), { id: SELLER, nickname: 'LOJA_NZ' }, tokens);
  return tokens;
}

const integration = () => backend.db.marketplace_integrations[0];

function mlOrder(id, o = {}) {
  const order = {
    id: Number(id),
    status: o.status || 'paid',
    status_detail: null,
    date_created: '2026-11-01T12:00:00.000-03:00',
    pack_id: o.pack_id ?? null,
    total_amount: 120,
    paid_amount: 135.5,
    currency_id: 'BRL',
    order_items: [{ item: { id: 'MLB111222333', title: 'Pós-operatório (livro)', variation_id: null }, quantity: 2, unit_price: 60 }],
    buyer: { id: 999, nickname: 'COMPRADOR123', first_name: 'Maria', last_name: 'Silva' },
    seller: { id: Number(o.seller ?? SELLER) },
    payments: o.payments ?? [
      { id: Number(id) + 5000, status: 'approved', transaction_amount: 120, total_paid_amount: 135.5, shipping_cost: 15.5, payment_type: 'credit_card', payment_method_id: 'visa' }
    ],
    shipping: { id: Number(id) + 9000 },
    tags: ['paid']
  };
  backend.ml.orders[String(id)] = order;
  backend.ml.shipments[String(order.shipping.id)] = {
    id: order.shipping.id,
    order_id: Number(id),
    status: o.shipmentStatus || 'ready_to_ship',
    mode: 'me2',
    logistic_type: 'cross_docking',
    tracking_number: o.tracking || null,
    receiver_address: { city: { name: 'Erechim' }, state: { id: 'BR-RS' }, street_name: 'Rua Secreta' }
  };
  return order;
}

let nseq = 0;
function notification(topic, resource, extra = {}) {
  nseq += 1;
  return {
    _id: `n-${nseq}-${crypto.randomBytes(3).toString('hex')}`,
    resource,
    user_id: Number(SELLER),
    topic,
    application_id: 1234567890,
    attempts: 1,
    sent: '2026-11-08T12:00:00.000Z',
    received: '2026-11-08T12:00:00.000Z',
    ...extra
  };
}

const webhook = (body) => run('mercadoLivreWebhook', { method: 'POST', body });
const mlOrders = () => backend.db.orders.filter((o) => o.channel === 'mercadolivre');

// Nenhum token, código ou segredo pode aparecer em log
function expectCleanLogs(secrets) {
  const all = logs.join('\n');
  for (const s of secrets.filter(Boolean)) expect(all).not.toContain(s);
}

/* ===================================================================== */

test.describe('configuração', () => {
  test('mlConfig lista só os NOMES das variáveis que faltam', () => {
    delete process.env.MERCADO_LIVRE_CLIENT_SECRET;
    process.env.MERCADO_LIVRE_TOKEN_ENCRYPTION_KEY = 'curta';
    const c = ml.mlConfig();
    expect(c.ok).toBe(false);
    expect(c.missing).toEqual(['MERCADO_LIVRE_CLIENT_SECRET', 'MERCADO_LIVRE_TOKEN_ENCRYPTION_KEY (32 bytes em base64)']);
    expect(JSON.stringify(c)).not.toContain('curta');
  });

  test('redirect URI precisa ser https e sem query', () => {
    process.env.MERCADO_LIVRE_REDIRECT_URI = 'http://site.test/cb';
    expect(ml.mlConfig().missing).toEqual(['MERCADO_LIVRE_REDIRECT_URI (https, sem query)']);
    process.env.MERCADO_LIVRE_REDIRECT_URI = `${REDIRECT}?x=1`;
    expect(ml.mlConfig().ok).toBe(false);
  });
});

test.describe('criptografia dos tokens (AES-256-GCM)', () => {
  test('ida e volta, IV único, formato versionado', () => {
    const cfg = ml.requireConfig();
    const a = ml.encryptToken(cfg, SELLER, 'access_token', 'APP_USR-segredo');
    const b = ml.encryptToken(cfg, SELLER, 'access_token', 'APP_USR-segredo');
    expect(a).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b); // IV aleatório por cifragem
    expect(a).not.toContain('segredo');
    expect(ml.decryptToken(cfg, SELLER, 'access_token', a)).toBe('APP_USR-segredo');
  });

  test('AAD: outro vendedor ou outro campo não abre; dado adulterado não abre', () => {
    const cfg = ml.requireConfig();
    const sealed = ml.encryptToken(cfg, SELLER, 'refresh_token', 'TG-segredo');
    expect(ml.decryptToken(cfg, '8888', 'refresh_token', sealed)).toBeNull();
    expect(ml.decryptToken(cfg, SELLER, 'access_token', sealed)).toBeNull();
    const parts = sealed.split('.');
    parts[3] = Buffer.from('outra-coisa').toString('base64url');
    expect(ml.decryptToken(cfg, SELLER, 'refresh_token', parts.join('.'))).toBeNull();
    expect(ml.decryptToken(cfg, SELLER, 'refresh_token', 'texto-puro')).toBeNull();
  });

  test('chave trocada não abre tokens antigos', () => {
    const sealed = ml.encryptToken(ml.requireConfig(), SELLER, 'access_token', 'x');
    process.env.MERCADO_LIVRE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
    expect(ml.decryptToken(ml.requireConfig(), SELLER, 'access_token', sealed)).toBeNull();
  });
});

test.describe('OAuth: state e PKCE', () => {
  test('PKCE: verifier no formato da RFC 7636 e challenge = SHA-256 em base64url', () => {
    const { verifier, challenge } = ml.pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(crypto.createHash('sha256').update(verifier).digest('base64url'));
    expect(ml.pkcePair().verifier).not.toBe(verifier);
  });

  test('mercadoLivreConnect exige administrador e cabeçalho anti-CSRF', async () => {
    expect((await run('mercadoLivreConnect', { method: 'POST', headers: { 'x-admin-request': '1' } })).status).toBe(401);
    expect((await run('mercadoLivreConnect', { method: 'POST', cookies: { [auth.COOKIE_NAME]: session() } })).status).toBe(403);
    expect((await adminCall('mercadoLivreConnect')).status).toBe(405); // GET
  });

  test('mercadoLivreConnect: URL de autorização com PKCE S256 e cookie Lax cifrado', async () => {
    const res = await adminCall('mercadoLivreConnect', { method: 'POST' });
    expect(res.status).toBe(200);
    const url = new URL(res.body.authorization_url);
    expect(`${url.origin}${url.pathname}`).toBe('https://auth.mercadolivre.com.br/authorization');
    const q = Object.fromEntries(url.searchParams);
    expect(q).toMatchObject({ response_type: 'code', client_id: '1234567890', redirect_uri: REDIRECT, code_challenge_method: 'S256' });
    expect(q.state).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const setCookie = res.headers['Set-Cookie'];
    expect(setCookie).toMatch(/^__Host-nz_ml_oauth=v1\.[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/);
    const value = setCookie.split(';')[0].split('=')[1];
    expect(value).not.toContain(q.state); // cifrado: o state não aparece em claro

    const check = ml.verifyOAuthState(ml.requireConfig(), value, q.state);
    expect(check.verifier).toBeTruthy();
    expect(crypto.createHash('sha256').update(check.verifier).digest('base64url')).toBe(q.code_challenge);
  });

  test('verifyOAuthState: ausente, adulterado, expirado e diferente são recusados', () => {
    const cfg = ml.requireConfig();
    const o = ml.createOAuthState(cfg);
    expect(ml.verifyOAuthState(cfg, null, o.state)).toEqual({ error: 'missing' });
    expect(ml.verifyOAuthState(cfg, `${o.cookieValue.slice(0, -2)}AA`, o.state)).toEqual({ error: 'invalid' });
    expect(ml.verifyOAuthState(cfg, o.cookieValue, `${o.state.slice(0, -1)}x`)).toEqual({ error: 'mismatch' });
    expect(ml.verifyOAuthState(cfg, o.cookieValue, undefined)).toEqual({ error: 'mismatch' });
    const old = ml.createOAuthState(cfg, Date.now() - 11 * 60 * 1000);
    expect(ml.verifyOAuthState(cfg, old.cookieValue, old.state)).toEqual({ error: 'expired' });
    expect(ml.verifyOAuthState(cfg, o.cookieValue, o.state).verifier).toBe(o.verifier);
  });

  async function startFlow() {
    const res = await adminCall('mercadoLivreConnect', { method: 'POST' });
    const url = new URL(res.body.authorization_url);
    const cookie = res.headers['Set-Cookie'].split(';')[0].split('=')[1];
    const state = url.searchParams.get('state');
    const code = `TG-code-${crypto.randomBytes(4).toString('hex')}`;
    backend.ml.codes[code] = { challenge: url.searchParams.get('code_challenge'), redirect_uri: REDIRECT };
    return { cookie, state, code };
  }

  const callback = (query, cookie) =>
    run('mercadoLivreOAuthCallback', { query, cookies: cookie ? { [ml.OAUTH_COOKIE]: cookie } : {} });

  test('callback: troca o código com o verifier, grava tokens cifrados e redireciona ao painel', async () => {
    const { cookie, state, code } = await startFlow();
    const res = await callback({ code, state }, cookie);
    expect(res.status).toBe(303);
    expect(res.headers.Location).toBe('/admin/pedidos.html?ml=conectado');
    expect(res.headers['Set-Cookie']).toMatch(/^__Host-nz_ml_oauth=; .*Max-Age=0$/);

    const tokenCall = backend.ml.tokenCalls[0];
    expect(tokenCall).toMatchObject({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT });
    expect(tokenCall.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);

    const row = integration();
    expect(row).toMatchObject({ provider: 'mercadolivre', seller_id: SELLER, seller_nickname: 'LOJA_NZ', status: 'active', version: 1 });
    const access = [...backend.ml.accessTokens][0];
    const refresh = [...backend.ml.refreshTokens][0];
    expect(JSON.stringify(row)).not.toContain(access);
    expect(JSON.stringify(row)).not.toContain(refresh);
    expect(ml.decryptToken(ml.requireConfig(), SELLER, 'access_token', row.access_token_enc)).toBe(access);
    expect(ml.decryptToken(ml.requireConfig(), SELLER, 'refresh_token', row.refresh_token_enc)).toBe(refresh);
    expect(Date.parse(row.token_expires_at) - Date.now()).toBeGreaterThan(5.9 * 3600 * 1000);
    expectCleanLogs([access, refresh, code, cookie, 'test-ml-secret']);
  });

  test('callback: state diferente, sem cookie, cookie de outro fluxo ou expirado não trocam código', async () => {
    const { cookie, state, code } = await startFlow();
    expect((await callback({ code, state: 'forjado' }, cookie)).headers.Location).toBe('/admin/pedidos.html?ml=estado_invalido');
    expect((await callback({ code, state })).headers.Location).toBe('/admin/pedidos.html?ml=estado_invalido');
    const other = ml.createOAuthState(ml.requireConfig());
    expect((await callback({ code, state }, other.cookieValue)).headers.Location).toBe('/admin/pedidos.html?ml=estado_invalido');
    const old = ml.createOAuthState(ml.requireConfig(), Date.now() - 20 * 60 * 1000);
    expect((await callback({ code, state: old.state }, old.cookieValue)).headers.Location).toBe('/admin/pedidos.html?ml=expirado');
    expect(backend.ml.tokenCalls).toHaveLength(0);
    expect(backend.db.marketplace_integrations).toHaveLength(0);
  });

  test('callback: recusa no Mercado Livre, código inválido e falha na troca', async () => {
    let f = await startFlow();
    expect((await callback({ error: 'access_denied', state: f.state }, f.cookie)).headers.Location).toBe('/admin/pedidos.html?ml=recusado');
    f = await startFlow();
    expect((await callback({ code: 'código com espaço', state: f.state }, f.cookie)).headers.Location).toBe('/admin/pedidos.html?ml=erro');
    f = await startFlow();
    delete backend.ml.codes[f.code]; // código já usado / inválido -> invalid_grant
    expect((await callback({ code: f.code, state: f.state }, f.cookie)).headers.Location).toBe('/admin/pedidos.html?ml=erro');
    expect(backend.db.marketplace_integrations).toHaveLength(0);
  });

  test('reconectar regrava a mesma conta com versão nova', async () => {
    await seedIntegration();
    const f = await startFlow();
    await callback({ code: f.code, state: f.state }, f.cookie);
    expect(backend.db.marketplace_integrations).toHaveLength(1);
    expect(integration()).toMatchObject({ version: 2, status: 'active' });
  });
});

test.describe('getAccessToken: renovação e rotação do refresh token', () => {
  test('token com folga: devolve sem chamar o Mercado Livre', async () => {
    const t = await seedIntegration();
    expect(await ml.getAccessToken(SELLER)).toBe(t.access_token);
    expect(backend.ml.tokenCalls).toHaveLength(0);
  });

  test('faltando menos de 10 min: renova, grava par novo e incrementa a versão', async () => {
    const t = await seedIntegration({ expiresIn: 5 * 60 });
    const token = await ml.getAccessToken(SELLER);
    expect(token).not.toBe(t.access_token);
    expect(backend.ml.tokenCalls).toEqual([expect.objectContaining({ grant_type: 'refresh_token', refresh_token: t.refresh_token })]);
    const row = integration();
    expect(row.version).toBe(2);
    expect(row.refresh_lock_until).toBe('1970-01-01T00:00:00.000Z');
    const cfg = ml.requireConfig();
    expect(ml.decryptToken(cfg, SELLER, 'access_token', row.access_token_enc)).toBe(token);
    const newRefresh = ml.decryptToken(cfg, SELLER, 'refresh_token', row.refresh_token_enc);
    expect(newRefresh).not.toBe(t.refresh_token);
    expect(backend.ml.refreshTokens.has(t.refresh_token)).toBe(false); // uso único

    // Rotação: a próxima renovação usa o refresh token novo
    row.token_expires_at = new Date(Date.now() - 1000).toISOString();
    await ml.getAccessToken(SELLER);
    expect(backend.ml.tokenCalls[1].refresh_token).toBe(newRefresh);
    expect(integration().version).toBe(3);
    expectCleanLogs([t.access_token, t.refresh_token, token, newRefresh]);
  });

  test('concorrência com token ainda válido: uma única renovação; os outros usam o token atual', async () => {
    await seedIntegration({ expiresIn: 5 * 60 });
    const tokens = await Promise.all([ml.getAccessToken(SELLER), ml.getAccessToken(SELLER), ml.getAccessToken(SELLER)]);
    expect(backend.ml.tokenCalls).toHaveLength(1);
    tokens.forEach((t) => expect(backend.ml.accessTokens.has(t)).toBe(true));
    expect(integration().version).toBe(2);
  });

  test('concorrência com token vencido: uma única renovação e todos recebem o token novo', async () => {
    await seedIntegration({ expiresIn: 0 });
    const tokens = await Promise.all([ml.getAccessToken(SELLER), ml.getAccessToken(SELLER), ml.getAccessToken(SELLER)]);
    expect(backend.ml.tokenCalls).toHaveLength(1);
    expect(new Set(tokens).size).toBe(1);
    expect(ml.decryptToken(ml.requireConfig(), SELLER, 'access_token', integration().access_token_enc)).toBe(tokens[0]);
  });

  test('invalid_grant: marca "reconectar", avisa no Discord uma vez e não tenta de novo', async () => {
    const t = await seedIntegration({ expiresIn: 0 });
    backend.ml.refreshTokens.delete(t.refresh_token); // revogado no Mercado Livre
    const alerts = [];
    const onReauthorization = async () => alerts.push(1);
    const results = await Promise.allSettled([ml.getAccessToken(SELLER, { onReauthorization }), ml.getAccessToken(SELLER, { onReauthorization })]);
    results.forEach((r) => expect(r.status).toBe('rejected'));
    expect(results[0].reason).toBeInstanceOf(ml.IntegrationError);
    expect(integration()).toMatchObject({ status: 'reauthorization_required', last_error: 'invalid_grant' });
    expect(alerts).toHaveLength(1);
    await expect(ml.getAccessToken(SELLER)).rejects.toMatchObject({ code: 'reauthorization_required' });
    expect(backend.ml.tokenCalls).toHaveLength(1);
  });

  test('falha transitória na renovação libera o lease e mantém o refresh token', async () => {
    const t = await seedIntegration({ expiresIn: 0 });
    backend.ml.tokenFails = true;
    await expect(ml.getAccessToken(SELLER)).rejects.toBeInstanceOf(ml.ApiError);
    expect(integration()).toMatchObject({ status: 'active', version: 1, refresh_lock_until: '1970-01-01T00:00:00.000Z' });
    backend.ml.tokenFails = false;
    await ml.getAccessToken(SELLER);
    expect(backend.ml.tokenCalls.at(-1).refresh_token).toBe(t.refresh_token);
  });

  test('sem conta conectada: IntegrationError not_connected', async () => {
    await expect(ml.getAccessToken(SELLER)).rejects.toMatchObject({ code: 'not_connected' });
  });
});

test.describe('mercadoLivreWebhook', () => {
  test.beforeEach(async () => {
    await seedIntegration();
  });

  test('notificação válida: grava pendente e responde 200 sem processar', async () => {
    mlOrder('2000000001');
    const res = await webhook(notification('orders_v2', '/orders/2000000001'));
    expect(res).toEqual({ status: 200, headers: expect.anything(), body: { ok: true } });
    const [row] = backend.db.processed_notifications;
    expect(row).toMatchObject({ provider: 'mercadolivre', topic: 'orders_v2', resource: '/orders/2000000001', status: 'pending', attempts: 0 });
    expect(mlOrders()).toHaveLength(0); // processamento é assíncrono
    expect(backend.calls.some((c) => c.url.includes('api.mercadolibre.com/orders'))).toBe(false);
  });

  test('application_id diferente: 403 e nada gravado', async () => {
    const res = await webhook(notification('orders_v2', '/orders/1', { application_id: 999 }));
    expect(res.status).toBe(403);
    expect(backend.db.processed_notifications).toHaveLength(0);
  });

  test('vendedor não conectado: 403 e nada gravado', async () => {
    const res = await webhook(notification('orders_v2', '/orders/1', { user_id: 123 }));
    expect(res.status).toBe(403);
    expect(backend.db.processed_notifications).toHaveLength(0);
  });

  test('tópico não assinado: 200 ignorado, sem gravar', async () => {
    const res = await webhook(notification('questions', '/questions/1'));
    expect(res.body).toEqual({ ok: true, ignored: 'topic' });
    expect(backend.db.processed_notifications).toHaveLength(0);
  });

  test('resource fora do formato e _id inválido: 400', async () => {
    for (const resource of ['/orders/../users/me', '/orders/12?x=1', 'https://evil.test/orders/1', '/users/1', '/orders/abc']) {
      expect((await webhook(notification('orders_v2', resource))).status).toBe(400);
    }
    expect((await webhook(notification('orders_v2', '/orders/1', { _id: '../x' }))).status).toBe(400);
    expect((await run('mercadoLivreWebhook', { method: 'POST', rawBody: '{nao-json' })).status).toBe(400);
    expect(backend.db.processed_notifications).toHaveLength(0);
  });

  test('notificação repetida (mesmo _id): 200 e uma linha só', async () => {
    const n = notification('orders_v2', '/orders/2000000001');
    expect((await webhook(n)).body).toEqual({ ok: true });
    expect((await webhook(n)).body).toEqual({ ok: true, duplicate: true });
    expect(backend.db.processed_notifications).toHaveLength(1);
  });

  test('falha ao gravar: 503 para o Mercado Livre reenviar', async () => {
    backend.supabase.failWrites.add('processed_notifications');
    expect((await webhook(notification('orders_v2', '/orders/1'))).status).toBe(503);
  });

  test('sem configuração: 503; método diferente de POST: 405', async () => {
    expect((await run('mercadoLivreWebhook')).status).toBe(405);
    delete process.env.MERCADO_LIVRE_CLIENT_ID;
    expect((await webhook(notification('orders_v2', '/orders/1'))).status).toBe(503);
  });

  test('shipments com /marketplace/shipments/<id> também é aceito', async () => {
    expect((await webhook(notification('shipments', '/marketplace/shipments/123'))).status).toBe(200);
    expect((await webhook(notification('shipments', '/shipments/124'))).status).toBe(200);
  });
});

test.describe('processamento da fila e sincronização de pedidos', () => {
  test.beforeEach(async () => {
    await seedIntegration();
  });

  async function receiveAndProcess(topic, resource) {
    await webhook(notification(topic, resource));
    return sync.processPending();
  }

  test('pedido pago: grava pedido, itens, pagamento e envio; avisa no Discord uma vez', async () => {
    mlOrder('2000000001', { pack_id: 3000000001 });
    const stats = await receiveAndProcess('orders_v2', '/orders/2000000001');
    expect(stats).toMatchObject({ processed: 1, done: 1 });

    const [order] = mlOrders();
    expect(order).toMatchObject({
      channel: 'mercadolivre',
      external_order_id: '2000000001',
      external_pack_id: '3000000001',
      status: 'paid',
      total_cents: 12000,
      shipping_cents: 1550,
      customer_id: null
    });
    expect(order.external_data.buyer).toEqual({ id: '999', nickname: 'COMPRADOR123', name: 'Maria Silva' });
    expect(JSON.stringify(order)).not.toContain('Rua Secreta'); // endereço não é guardado

    expect(backend.db.order_items).toEqual([
      expect.objectContaining({ order_id: order.id, product_id: 'MLB111222333', title: 'Pós-operatório (livro)', quantity: 2, unit_price_cents: 6000, subtotal_cents: 12000 })
    ]);
    expect(backend.db.payments).toEqual([
      expect.objectContaining({ order_id: order.id, provider: 'mercadolivre', mercadopago_payment_id: '2000005001', status: 'approved', amount_cents: 13550, method: 'visa' })
    ]);
    expect(backend.db.shipments).toEqual([
      expect.objectContaining({ order_id: order.id, provider: 'mercadolivre', external_shipment_id: '2000009001', status: 'ready_to_ship' })
    ]);
    expect(backend.db.shipments[0].raw).toMatchObject({ city: 'Erechim', state: 'RS', logistic_type: 'cross_docking' });

    expect(backend.discord.messages).toHaveLength(1);
    const embed = backend.discord.messages[0].embeds[0];
    expect(backend.discord.messages[0].username).toBe('Venda no Mercado Livre');
    const fields = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
    expect(fields).toMatchObject({ Canal: 'Mercado Livre', Pedido: '#2000000001', Comprador: 'Maria Silva', Itens: '2× Pós-operatório (livro)', Total: expect.stringMatching(/^R\$\s135,50$/), Pagamento: 'Aprovado · Cartão de crédito', 'Carrinho (pack)': '#3000000001' });
    expect(backend.discord.urls).toEqual(['https://discord.test/site']); // sem webhook próprio: usa o do site

    expect(backend.db.processed_notifications[0]).toMatchObject({ status: 'done', attempts: 1, last_error: null });
  });

  test('reprocessar o mesmo pedido (outra notificação) não duplica linhas nem avisos', async () => {
    mlOrder('2000000001');
    await receiveAndProcess('orders_v2', '/orders/2000000001');
    await receiveAndProcess('orders_v2', '/orders/2000000001');
    await sync.syncOrder(SELLER, '2000000001');
    expect(mlOrders()).toHaveLength(1);
    expect(backend.db.order_items).toHaveLength(1);
    expect(backend.db.payments).toHaveLength(1);
    expect(backend.db.shipments).toHaveLength(1);
    expect(backend.discord.messages).toHaveLength(1);
  });

  test('duas notificações do mesmo pedido no mesmo lote: uma consulta só', async () => {
    mlOrder('2000000001');
    await webhook(notification('orders_v2', '/orders/2000000001'));
    await webhook(notification('orders_v2', '/orders/2000000001'));
    const stats = await sync.processPending();
    expect(stats).toMatchObject({ processed: 2, done: 2 });
    expect(backend.calls.filter((c) => c.url.endsWith('/orders/2000000001'))).toHaveLength(1);
    expect(backend.discord.messages).toHaveLength(1);
  });

  test('pedido aguardando pagamento e depois pago: avisa só na transição', async () => {
    mlOrder('2000000002', { status: 'payment_required', payments: [] });
    await receiveAndProcess('orders_v2', '/orders/2000000002');
    expect(mlOrders()[0].status).toBe('pending');
    expect(backend.discord.messages).toHaveLength(0);
    mlOrder('2000000002');
    await receiveAndProcess('orders_v2', '/orders/2000000002');
    expect(mlOrders()[0].status).toBe('paid');
    expect(backend.discord.messages).toHaveLength(1);
  });

  test('notificação de envio: pedido pago passa a enviado, com código de rastreio', async () => {
    mlOrder('2000000003');
    await receiveAndProcess('orders_v2', '/orders/2000000003');
    mlOrder('2000000003', { shipmentStatus: 'shipped', tracking: 'BR123456789BR' });
    await receiveAndProcess('shipments', '/shipments/2000009003');
    expect(mlOrders()[0].status).toBe('shipped');
    expect(backend.db.shipments[0]).toMatchObject({ status: 'shipped', tracking_code: 'BR123456789BR' });
    expect(backend.discord.messages).toHaveLength(1);
  });

  test('primeira sincronização já enviado: passa por "paid" (com aviso) e chega a "shipped"', async () => {
    mlOrder('2000000004', { shipmentStatus: 'delivered' });
    await receiveAndProcess('orders_v2', '/orders/2000000004');
    expect(mlOrders()[0].status).toBe('shipped');
    expect(backend.discord.messages).toHaveLength(1);
  });

  test('cancelado no Mercado Livre: pago -> cancelado; cancelado não volta a pago', async () => {
    mlOrder('2000000005');
    await receiveAndProcess('orders_v2', '/orders/2000000005');
    mlOrder('2000000005', { status: 'cancelled', payments: [{ id: 2000005005, status: 'refunded', transaction_amount: 120, payment_type: 'credit_card' }] });
    await receiveAndProcess('orders_v2', '/orders/2000000005');
    expect(mlOrders()[0].status).toBe('cancelled');
    expect(backend.db.payments[0].status).toBe('refunded');
    mlOrder('2000000005'); // dado antigo chegando atrasado
    await receiveAndProcess('orders_v2', '/orders/2000000005');
    expect(mlOrders()[0].status).toBe('cancelled');
    expect(backend.discord.messages).toHaveLength(1);
  });

  test('pedido de outro vendedor ou inexistente: notificação ignorada, nada gravado', async () => {
    mlOrder('2000000006', { seller: 1234 });
    await receiveAndProcess('orders_v2', '/orders/2000000006');
    await receiveAndProcess('orders_v2', '/orders/2000000099');
    expect(mlOrders()).toHaveLength(0);
    expect(backend.db.processed_notifications.map((n) => [n.status, n.last_error])).toEqual([
      ['ignored', 'other_seller'],
      ['ignored', 'order_not_found']
    ]);
  });

  test('pagamento já ligado a pedido do site não é sobrescrito', async () => {
    const siteOrderId = crypto.randomUUID();
    backend.db.payments.push({ id: 'p-site', order_id: siteOrderId, provider: 'mercadopago', mercadopago_payment_id: '2000005007', status: 'approved' });
    mlOrder('2000000007');
    await receiveAndProcess('orders_v2', '/orders/2000000007');
    expect(backend.db.payments).toHaveLength(1);
    expect(backend.db.payments[0]).toMatchObject({ order_id: siteOrderId, provider: 'mercadopago' });
  });

  test('erro na API: volta para a fila com espera crescente e erro sem segredos', async () => {
    mlOrder('2000000008');
    backend.ml.apiFails = true;
    const stats = await receiveAndProcess('orders_v2', '/orders/2000000008');
    expect(stats).toMatchObject({ processed: 1, retried: 1 });
    const [row] = backend.db.processed_notifications;
    expect(row).toMatchObject({ status: 'pending', attempts: 1, locked_at: null });
    expect(Date.parse(row.next_attempt_at)).toBeGreaterThan(Date.now() + 60 * 1000);
    expect(row.last_error).toBe('ApiError:internal_error');

    // ainda não é hora: nada acontece
    expect((await sync.processPending()).processed).toBe(0);
    // na hora certa (e com a API de volta) processa
    backend.ml.apiFails = false;
    row.next_attempt_at = new Date(Date.now() - 1000).toISOString();
    expect((await sync.processPending()).done).toBe(1);
    expect(mlOrders()[0].status).toBe('paid');
    expectCleanLogs([...backend.ml.accessTokens, ...backend.ml.refreshTokens]);
  });

  test('esgota as tentativas: status failed', async () => {
    mlOrder('2000000009');
    backend.ml.apiFails = true;
    await webhook(notification('orders_v2', '/orders/2000000009'));
    const row = backend.db.processed_notifications[0];
    for (let i = 0; i < sync.MAX_ATTEMPTS; i += 1) {
      row.next_attempt_at = new Date(Date.now() - 1000).toISOString();
      await sync.processPending();
    }
    expect(row).toMatchObject({ status: 'failed', attempts: sync.MAX_ATTEMPTS });
  });

  test('conta precisa reconectar: venda fica na fila sem gastar tentativas; um alerta no Discord', async () => {
    const t = integration();
    backend.ml.refreshTokens.clear();
    t.token_expires_at = new Date(Date.now() - 1000).toISOString();
    mlOrder('2000000010');
    await webhook(notification('orders_v2', '/orders/2000000010'));
    await webhook(notification('orders_v2', '/orders/2000000011'));
    await sync.processPending();
    expect(integration().status).toBe('reauthorization_required');
    expect(backend.db.processed_notifications.map((n) => [n.status, n.attempts])).toEqual([
      ['pending', 0],
      ['pending', 0]
    ]);
    expect(backend.discord.messages).toHaveLength(1);
    expect(backend.discord.messages[0].content).toContain('reconectada');
  });

  test('notificação travada em "processing" há mais de 10 min volta para a fila', async () => {
    mlOrder('2000000012');
    await webhook(notification('orders_v2', '/orders/2000000012'));
    Object.assign(backend.db.processed_notifications[0], { status: 'processing', locked_at: new Date(Date.now() - 11 * 60 * 1000).toISOString() });
    expect((await sync.processPending()).done).toBe(1);
  });

  test('MERCADO_LIVRE_DISCORD_WEBHOOK_URL tem prioridade sobre o webhook do site', async () => {
    process.env.MERCADO_LIVRE_DISCORD_WEBHOOK_URL = 'https://discord.test/ml';
    mlOrder('2000000013');
    await receiveAndProcess('orders_v2', '/orders/2000000013');
    expect(backend.discord.urls).toEqual(['https://discord.test/ml']);
  });

  test('falha no Discord não impede a sincronização', async () => {
    backend.discord.fails = true;
    mlOrder('2000000014');
    expect((await receiveAndProcess('orders_v2', '/orders/2000000014')).done).toBe(1);
    expect(mlOrders()[0].status).toBe('paid');
  });
});

test.describe('mapeamento de status', () => {
  test('status do Mercado Livre -> status interno', () => {
    const cases = {
      paid: 'paid',
      partially_refunded: 'paid',
      confirmed: 'pending',
      payment_required: 'pending',
      payment_in_process: 'pending',
      partially_paid: 'pending',
      cancelled: 'cancelled',
      invalid: 'cancelled',
      pending_cancel: null,
      algo_novo: null
    };
    for (const [mlStatus, expected] of Object.entries(cases)) expect(sync.targetStatus({ status: mlStatus }, null)).toBe(expected);
    expect(sync.targetStatus({ status: 'paid' }, { status: 'shipped' })).toBe('shipped');
    expect(sync.targetStatus({ status: 'paid' }, { status: 'delivered' })).toBe('shipped');
    expect(sync.targetStatus({ status: 'payment_required' }, { status: 'shipped' })).toBe('pending');
  });

  test('transições: nunca regride; pending -> shipped passa por paid', () => {
    expect(sync.transitionPath('pending', 'paid')).toEqual(['paid']);
    expect(sync.transitionPath('pending', 'shipped')).toEqual(['paid', 'shipped']);
    expect(sync.transitionPath('paid', 'pending')).toEqual([]);
    expect(sync.transitionPath('shipped', 'paid')).toEqual([]);
    expect(sync.transitionPath('cancelled', 'paid')).toEqual([]);
    expect(sync.transitionPath('paid', 'paid')).toEqual([]);
    expect(sync.transitionPath('paid', null)).toEqual([]);
  });

  test('parseResource aceita só caminhos esperados', () => {
    expect(sync.parseResource('orders_v2', '/orders/123')).toBe('123');
    expect(sync.parseResource('shipments', '/shipments/9')).toBe('9');
    expect(sync.parseResource('shipments', '/marketplace/shipments/9')).toBe('9');
    expect(sync.parseResource('orders_v2', '/shipments/9')).toBeNull();
    expect(sync.parseResource('items', '/items/MLB1')).toBeNull();
  });
});

test.describe('Background e Scheduled Functions', () => {
  test('background exige o token interno', async () => {
    await seedIntegration();
    mlOrder('2000000020');
    await webhook(notification('orders_v2', '/orders/2000000020'));
    expect((await run('mercadoLivreProcess-background', { method: 'POST' })).status).toBe(403);
    expect((await run('mercadoLivreProcess-background', { method: 'POST', headers: { 'x-nz-internal': 'x' } })).status).toBe(403);
    expect(mlOrders()).toHaveLength(0);
    const ok = await run('mercadoLivreProcess-background', { method: 'POST', headers: { 'x-nz-internal': ml.internalToken(ml.requireConfig()) } });
    expect(ok.status).toBe(200);
    expect(mlOrders()[0].status).toBe('paid');
  });

  test('webhook aciona a background só com MERCADO_LIVRE_BACKGROUND_PROCESSING=true', async () => {
    await seedIntegration();
    process.env.URL = 'https://site.test';
    await webhook(notification('orders_v2', '/orders/1'));
    expect(backend.calls.some((c) => c.url.includes('mercadoLivreProcess-background'))).toBe(false);
    process.env.MERCADO_LIVRE_BACKGROUND_PROCESSING = 'true';
    const res = await webhook(notification('orders_v2', '/orders/2'));
    // a chamada falha no simulador, mas a notificação já está gravada: continua 200
    expect(res.status).toBe(200);
    const kick = backend.calls.find((c) => c.url === 'https://site.test/.netlify/functions/mercadoLivreProcess-background');
    expect(kick.headers['x-nz-internal']).toBe(ml.internalToken(ml.requireConfig()));
  });

  test('scheduler: processa a fila e renova o token perto do vencimento', async () => {
    await seedIntegration({ expiresIn: 5 * 60 });
    mlOrder('2000000021');
    await webhook(notification('orders_v2', '/orders/2000000021'));
    expect((await run('mercadoLivreScheduler', { method: 'POST' })).status).toBe(200);
    expect(mlOrders()[0].status).toBe('paid');
    expect(backend.ml.tokenCalls).toHaveLength(1);
    expect(integration().version).toBe(2);
  });

  test('scheduler sem configuração não faz nada', async () => {
    delete process.env.MERCADO_LIVRE_CLIENT_ID;
    expect((await run('mercadoLivreScheduler', { method: 'POST' })).status).toBe(200);
    expect(backend.calls).toHaveLength(0);
  });
});

test.describe('painel administrativo', () => {
  async function seedMarketplaceOrder(id = '2000000030', o = {}) {
    await seedIntegration();
    mlOrder(id, o);
    await sync.syncOrder(SELLER, id);
    return mlOrders().find((x) => x.external_order_id === id);
  }

  function seedSiteOrder() {
    const id = crypto.randomUUID();
    backend.db.customers.push({ id: 'c-site', name: 'Cliente Site', email: 'site@example.com', phone: '54999990000' });
    backend.db.orders.push({ id, customer_id: 'c-site', status: 'paid', total_cents: 42565, shipping_cents: 2575, created_at: '2026-09-01T15:00:00.000Z' });
    backend.db.order_items.push({ order_id: id, product_id: 'book-nagila-zortea', quantity: 1, unit_price_cents: 39990, subtotal_cents: 39990 });
    backend.db.addresses.push({ order_id: id, cep: '01001000', street: 'Praça da Sé', number: '100', neighborhood: 'Sé', city: 'São Paulo', state: 'SP' });
    backend.db.shipments.push({ order_id: id, provider: 'melhorenvio', status: 'quoted', raw: { service: 'PAC', carrier: 'Correios' } });
    backend.db.payments.push({ order_id: id, mercadopago_payment_id: '1', status: 'approved', amount_cents: 42565, method: 'pix' });
    return id;
  }

  test('lista mostra o canal; filtro por canal; resumo separa as vendas', async () => {
    const ml1 = await seedMarketplaceOrder();
    const siteId = seedSiteOrder();
    const res = await adminCall('adminOrders');
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.orders.map((o) => [o.id, o]));
    expect(byId[siteId]).toMatchObject({ channel: 'site', channel_label: 'Site', external: null });
    expect(byId[ml1.id]).toMatchObject({
      channel: 'mercadolivre',
      channel_label: 'Mercado Livre',
      external: { order_id: '2000000030', buyer_nickname: 'COMPRADOR123' },
      customer: { name: 'Maria Silva', email: '', phone: '' },
      delivery: { type: 'mercadolivre', label: 'Mercado Envios (coleta) — Erechim/RS' },
      payment: { status: 'aprovado' },
      readiness: { state: 'mercadolivre', label: 'Envio pelo Mercado Livre' }
    });
    expect(res.body.summary).toMatchObject({ total: 2, exemplares_vendidos: 1, vendas_mercadolivre: 1, prontos: 1 });

    const onlyMl = await adminCall('adminOrders', { query: { canal: 'mercadolivre' } });
    expect(onlyMl.body.orders.map((o) => o.id)).toEqual([ml1.id]);
    const search = await adminCall('adminOrders', { query: { q: '2000000030' } });
    expect(search.body.total).toBe(1);
    expect((await adminCall('adminOrders', { query: { canal: 'outro' } })).status).toBe(400);

    const detail = await adminCall('adminOrders', { query: { id: ml1.id } });
    expect(detail.body.order.items).toEqual([{ title: 'Pós-operatório (livro)', quantity: 2, unit_price_cents: 6000, subtotal_cents: 12000 }]);
    expect(detail.body.order.payments[0]).toMatchObject({ status: 'approved', mercadopago_payment_id: '2000005030' });
  });

  test('pedido do Mercado Livre não pode ser marcado como enviado nem reverificado no Mercado Pago', async () => {
    const order = await seedMarketplaceOrder();
    const ship = await adminCall('adminMarkShipped', { method: 'POST', body: { order_id: order.id } });
    expect(ship.status).toBe(409);
    expect(ship.body.error).toContain('Mercado Livre');
    const recheck = await adminCall('adminRecheckPayment', { method: 'POST', body: { order_id: order.id } });
    expect(recheck.status).toBe(409);
    expect(backend.calls.some((c) => c.url.includes('api.mercadopago.com'))).toBe(false);
  });

  test('CSV: só pedidos do site prontos para envio, com a coluna Canal', async () => {
    await seedMarketplaceOrder();
    seedSiteOrder();
    const res = await run('adminExport', { cookies: { [auth.COOKIE_NAME]: session() }, headers: { 'x-admin-request': '1' } });
    const raw = await require('../functions/adminExport/index.js').handler({
      httpMethod: 'GET',
      queryStringParameters: {},
      headers: { host: 'site.test', 'x-admin-request': '1', cookie: `${auth.COOKIE_NAME}=${session()}` }
    });
    expect(res.status).toBe(200);
    const lines = raw.body.slice(1).trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[0].endsWith('"Serviço";"Canal"')).toBe(true);
    expect(lines[1].endsWith('"Site"')).toBe(true);
  });

  test('status da integração: sem tokens na resposta', async () => {
    const t = await seedIntegration();
    await webhook(notification('orders_v2', '/orders/1'));
    const res = await adminCall('adminMercadoLivreStatus');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      configured: true,
      accounts: [{ seller_id: SELLER, seller_nickname: 'LOJA_NZ', status: 'active' }],
      queue: { pending: 1, failed: 0 }
    });
    const text = JSON.stringify(res.body);
    for (const secret of [t.access_token, t.refresh_token, 'access_token_enc', 'refresh_token_enc', 'v1.', 'test-ml-secret']) {
      expect(text).not.toContain(secret);
    }
    expect((await run('adminMercadoLivreStatus', { headers: { 'x-admin-request': '1' } })).status).toBe(401);
  });

  test('status sem configuração: informa só os nomes das variáveis', async () => {
    delete process.env.MERCADO_LIVRE_TOKEN_ENCRYPTION_KEY;
    const res = await adminCall('adminMercadoLivreStatus');
    expect(res.body).toEqual({ configured: false, missing: ['MERCADO_LIVRE_TOKEN_ENCRYPTION_KEY (32 bytes em base64)'], accounts: [], queue: null });
  });
});

test.describe('estoque entre canais (BOOK_STOCK)', () => {
  test('sem MERCADO_LIVRE_BOOK_ITEM_IDS: vendas do Mercado Livre não consomem o estoque do site', async () => {
    await seedIntegration();
    mlOrder('2000000040');
    await sync.syncOrder(SELLER, '2000000040');
    expect(await availableStock(10)).toBe(10);
  });

  test('com o anúncio listado: o estoque é compartilhado', async () => {
    process.env.MERCADO_LIVRE_BOOK_ITEM_IDS = 'MLB111222333, lixo';
    await seedIntegration();
    mlOrder('2000000041');
    await sync.syncOrder(SELLER, '2000000041');
    expect(await availableStock(10)).toBe(8);
  });
});

test.describe('regressão: checkout do site', () => {
  test('paymentWebhook ignora pagamento de venda do Mercado Livre (sem gravar nada)', async () => {
    backend.mp.payments['2000005050'] = { id: 2000005050, status: 'approved', transaction_amount: 120, external_reference: '2000000050' };
    const res = await call('paymentWebhook', {
      httpMethod: 'POST',
      queryStringParameters: { type: 'payment', 'data.id': '2000005050' },
      headers: {},
      body: JSON.stringify({ id: 'n-1', type: 'payment', data: { id: '2000005050' } })
    });
    expect(res).toEqual({ status: 200, body: { ok: true, ignored: 'no_order_reference' } });
    expect(backend.calls.filter((c) => c.url.includes('supabase.test') && c.method !== 'GET')).toHaveLength(0);
  });

  test('paymentWebhook não mexe em pedido do canal mercadolivre', async () => {
    const id = crypto.randomUUID();
    backend.db.orders.push({ id, channel: 'mercadolivre', status: 'pending', total_cents: 12000 });
    backend.mp.payments['77'] = { id: 77, status: 'approved', transaction_amount: 120, external_reference: id };
    const res = await call('paymentWebhook', {
      httpMethod: 'POST',
      queryStringParameters: { type: 'payment', 'data.id': '77' },
      headers: {},
      body: JSON.stringify({ id: 'n-2', type: 'payment', data: { id: '77' } })
    });
    expect(res.body).toEqual({ ok: true, ignored: 'marketplace_order' });
    expect(backend.db.orders[0].status).toBe('pending');
  });
});
