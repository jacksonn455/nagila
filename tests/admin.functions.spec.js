const { test, expect } = require('@playwright/test');
const crypto = require('crypto');
const { createBackend, install } = require('./helpers/backend');
const auth = require('../functions/_lib/adminAuth');

// Área administrativa: Functions chamadas direto no Node, com Supabase e Mercado Pago simulados.

const EMAIL = 'admin@example.com';
const PASSWORD = 'senha-de-teste-muito-segura';
const SECRET = 'x'.repeat(48);
let HASH; // gerado uma vez (scrypt com custo baixo para o teste ser rápido)

let backend;
let restore;

test.beforeAll(async () => {
  HASH = await auth.hashPassword(PASSWORD, { N: 1024 });
});

function adminEnv(extra = {}) {
  return { ADMIN_EMAIL: EMAIL, ADMIN_PASSWORD_HASH: HASH, ADMIN_SESSION_SECRET: SECRET, ...extra };
}

async function run(name, { method = 'GET', body, query, cookie, csrf = true, ip = '203.0.113.7', headers = {} } = {}) {
  const res = await require(`../functions/${name}/index.js`).handler({
    httpMethod: method,
    queryStringParameters: query || {},
    headers: {
      ...(csrf ? { 'x-admin-request': '1' } : {}),
      ...(cookie ? { cookie: `${auth.COOKIE_NAME}=${cookie}` } : {}),
      'x-nf-client-connection-ip': ip,
      host: 'site.test',
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    // CSV
  }
  return { status: res.statusCode, headers: res.headers, body: json, raw: res.body };
}

const session = (now) => auth.createSession(auth.adminConfig(), now);
const login = (email = EMAIL, password = PASSWORD, opts = {}) => run('adminLogin', { method: 'POST', body: { email, password }, ...opts });

/* ---------- pedidos de exemplo ---------- */

const ADDRESS = { cep: '01001000', street: 'Praça da Sé', number: '100', complement: null, neighborhood: 'Sé', city: 'São Paulo', state: 'SP', country: 'BR' };
let seq = 0; // único entre testes (ids)
let day = 0; // reinicia a cada teste: datas em setembro/2026, sempre no passado

// Cria um pedido completo no banco simulado. Por padrão: pago, aprovado, frete, endereço completo.
function seed(o = {}) {
  seq += 1;
  const id = crypto.randomUUID();
  const total = o.total ?? 39990 + 2575;
  const customerId = `c-${seq}`;
  const created = o.created_at || new Date(Date.UTC(2026, 8, 1 + day++, 15)).toISOString();
  backend.db.customers.push({ id: customerId, name: o.name ?? `Cliente ${seq}`, email: o.email ?? `cliente${seq}@example.com`, phone: o.phone ?? '54999990000' });
  backend.db.orders.push({ id, customer_id: customerId, status: o.status ?? 'paid', total_cents: total, shipping_cents: o.pickup ? 0 : 2575, currency: 'BRL', created_at: created });
  backend.db.order_items.push({ order_id: id, product_id: 'book-nagila-zortea', quantity: o.quantity ?? 1, unit_price_cents: 39990, subtotal_cents: 39990 * (o.quantity ?? 1) });
  if (!o.pickup && o.address !== null) backend.db.addresses.push({ id: `a-${seq}`, order_id: id, ...ADDRESS, ...(o.address || {}) });
  if (o.shipment !== null) {
    backend.db.shipments.push({
      id: `s-${seq}`,
      order_id: id,
      provider: o.pickup ? 'pickup' : 'melhorenvio',
      status: o.shipmentStatus ?? (o.pickup ? 'awaiting_pickup' : 'quoted'),
      raw: o.pickup ? { service: 'Retirar no local' } : { service: 'PAC', carrier: 'Correios' }
    });
  }
  backend.db.payments.push({ id: `pp-${seq}`, order_id: id, status: 'preference_created', mercadopago_preference_id: `pref-${seq}`, amount_cents: total });
  for (const p of o.payments ?? [{ status: 'approved', amount: total }]) {
    backend.db.payments.push({ id: `p-${seq}-${p.status}`, order_id: id, mercadopago_payment_id: `${9000 + seq}`, status: p.status, amount_cents: p.amount, method: 'pix' });
  }
  return id;
}

test.beforeEach(() => {
  day = 0;
  backend = createBackend();
  restore = install(backend, adminEnv());
});
test.afterEach(() => restore());

/* ===================================================================== */

test.describe('adminLogin', () => {
  test('sucesso: cookie assinado com os atributos de segurança e sem dados pessoais', async () => {
    const res = await login();
    expect(res.status).toBe(200);
    expect(res.headers['Cache-Control']).toBe('no-store');
    const cookie = res.headers['Set-Cookie'];
    expect(cookie).toMatch(/^__Host-nz_admin=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800$/);
    const token = cookie.split(';')[0].split('=')[1];
    const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'sid', 'v']);
    expect(payload.exp - payload.iat).toBe(8 * 3600);
    expect(token).not.toContain('admin');
    expect(auth.verifySession(auth.adminConfig(), token)).toBeTruthy();
  });

  test('e-mail com maiúsculas e espaços é aceito', async () => {
    expect((await login('  Admin@Example.COM ')).status).toBe(200);
  });

  test('senha errada e e-mail errado: mesma mensagem genérica', async () => {
    const wrongPassword = await login(EMAIL, 'errada-errada');
    const wrongEmail = await login('outro@example.com', PASSWORD);
    expect(wrongPassword).toMatchObject({ status: 401, body: { error: 'E-mail ou senha incorretos.' } });
    expect(wrongEmail).toMatchObject({ status: 401, body: { error: 'E-mail ou senha incorretos.' } });
    expect(wrongPassword.headers['Set-Cookie']).toBeUndefined();
  });

  test('tentativas guardam só hashes (sem IP nem e-mail em texto)', async () => {
    await login(EMAIL, 'errada');
    expect(backend.db.admin_login_attempts).toHaveLength(2);
    for (const row of backend.db.admin_login_attempts) {
      expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row)).not.toMatch(/admin@|203\.0\.113/);
    }
  });

  test('variáveis ausentes ou inválidas: área não configurada', async () => {
    for (const missing of ['ADMIN_EMAIL', 'ADMIN_PASSWORD_HASH', 'ADMIN_SESSION_SECRET']) {
      const saved = process.env[missing];
      delete process.env[missing];
      expect(await login()).toMatchObject({ status: 503, body: { error: 'Área administrativa não configurada.' } });
      process.env[missing] = saved;
    }
    process.env.ADMIN_SESSION_SECRET = 'curto';
    expect((await login()).status).toBe(503);
    process.env.ADMIN_SESSION_SECRET = SECRET;
    process.env.ADMIN_PASSWORD_HASH = 'texto-puro';
    expect((await login()).status).toBe(503);
  });

  test('sem o cabeçalho X-Admin-Request ou de outra origem: recusado (CSRF)', async () => {
    expect((await login(EMAIL, PASSWORD, { csrf: false })).status).toBe(403);
    expect((await login(EMAIL, PASSWORD, { headers: { origin: 'https://ataque.test' } })).status).toBe(403);
    expect((await login(EMAIL, PASSWORD, { headers: { origin: 'https://site.test' } })).status).toBe(200);
  });

  test('bloqueio: 5 falhas em 15 min bloqueiam até a senha certa (por IP e por e-mail)', async () => {
    for (let i = 0; i < 5; i += 1) expect((await login(EMAIL, `errada-${i}`)).status).toBe(401);
    const blocked = await login();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/^Muitas tentativas\. Tente novamente em \d+ minutos?\.$/);
    expect(Number(blocked.headers['Retry-After'])).toBeGreaterThan(0);
    // outro IP, mesmo e-mail: continua bloqueado
    expect((await login(EMAIL, PASSWORD, { ip: '198.51.100.9' })).status).toBe(429);
    // mesmo IP, outro e-mail: bloqueado pelo IP
    expect((await login('outro@example.com', 'x')).status).toBe(429);
  });

  test('falhas antigas (mais de 15 min) não bloqueiam; 10 em 24 h bloqueiam por 1 h', async () => {
    const [ipKey] = auth.attemptKeys(auth.adminConfig(), { headers: { 'x-nf-client-connection-ip': '203.0.113.7' } }, EMAIL);
    const ago = (min) => new Date(Date.now() - min * 60 * 1000).toISOString();
    for (let i = 0; i < 5; i += 1) backend.db.admin_login_attempts.push({ id: `old-${i}`, key_hash: ipKey, created_at: ago(30 + i) });
    expect((await login()).status).toBe(200); // e o sucesso limpa as falhas
    expect(backend.db.admin_login_attempts.filter((r) => r.key_hash === ipKey)).toHaveLength(0);

    for (let i = 0; i < 10; i += 1) backend.db.admin_login_attempts.push({ id: `day-${i}`, key_hash: ipKey, created_at: ago(20 + i * 30) });
    const res = await login();
    expect(res.status).toBe(429);
    expect(Number(res.headers['Retry-After'])).toBeGreaterThan(30 * 60);
  });

  test('sem acesso à tabela de tentativas: recusa o login (falha fechada)', async () => {
    global.fetch = async () => ({ ok: false, status: 500, text: async () => 'erro' });
    expect(await login()).toMatchObject({ status: 503, body: { error: 'Login indisponível no momento. Tente novamente em instantes.' } });
  });
});

test.describe('proteção das Functions admin', () => {
  const PROTECTED = [
    ['adminSession', 'GET'],
    ['adminLogout', 'POST'],
    ['adminOrders', 'GET'],
    ['adminRecheckPayment', 'POST'],
    ['adminMarkShipped', 'POST'],
    ['adminExport', 'GET']
  ];

  for (const [name, method] of PROTECTED) {
    test(`${name}: 401 sem sessão, adulterada, expirada ou com segredo trocado`, async () => {
      const id = seed();
      const body = method === 'POST' ? { order_id: id } : undefined;
      expect((await run(name, { method, body })).status).toBe(401);

      const valid = session();
      const [payload, sig] = valid.split('.');
      const forged = Buffer.from(JSON.stringify({ v: 1, iat: 0, exp: 4102444800, sid: 'x' })).toString('base64url');
      for (const cookie of [`${payload}.${sig.slice(0, -2)}aa`, `${forged}.${sig}`, 'lixo', session(Date.now() - 9 * 3600 * 1000)]) {
        const res = await run(name, { method, body, cookie });
        expect(res.status, cookie).toBe(401);
        expect(res.body).toEqual({ error: 'Sessão expirada. Entre novamente.' });
      }

      process.env.ADMIN_SESSION_SECRET = 'y'.repeat(48); // trocar o segredo derruba as sessões
      expect((await run(name, { method, body, cookie: valid })).status).toBe(401);
      process.env.ADMIN_SESSION_SECRET = SECRET;
      process.env.ADMIN_PASSWORD_HASH = await auth.hashPassword('outra-senha-qualquer', { N: 1024 }); // trocar a senha também
      expect((await run(name, { method, body, cookie: valid })).status).toBe(401);
    });

    test(`${name}: sem o cabeçalho anti-CSRF é recusado mesmo com sessão`, async () => {
      const res = await run(name, { method, body: method === 'POST' ? {} : undefined, cookie: session(), csrf: false });
      expect(res.status).toBe(403);
    });

    test(`${name}: sem configuração não expõe nada`, async () => {
      delete process.env.ADMIN_SESSION_SECRET;
      const res = await run(name, { method, cookie: 'qualquer' });
      expect(res).toMatchObject({ status: 503, body: { error: 'Área administrativa não configurada.' } });
    });
  }

  test('adminSession com sessão válida e logout apaga o cookie', async () => {
    const cookie = session();
    const s = await run('adminSession', { cookie });
    expect(s.status).toBe(200);
    expect(s.body.authenticated).toBe(true);
    const out = await run('adminLogout', { method: 'POST', cookie });
    expect(out.status).toBe(200);
    expect(out.headers['Set-Cookie']).toMatch(/^__Host-nz_admin=; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=0$/);
  });

  test('método errado: 405', async () => {
    expect((await run('adminOrders', { method: 'POST', cookie: session() })).status).toBe(405);
    expect((await run('adminMarkShipped', { method: 'GET', cookie: session() })).status).toBe(405);
  });
});

test.describe('regra “Pronto para envio”', () => {
  async function detail(id) {
    const res = await run('adminOrders', { query: { id }, cookie: session() });
    expect(res.status).toBe(200);
    return res.body.order;
  }

  test('pronto: frete com endereço completo', async () => {
    const o = await detail(seed());
    expect(o.readiness).toEqual({ state: 'pronto', label: 'Pronto para envio', reasons: [] });
    expect(o.payment).toEqual({ status: 'aprovado', label: 'Aprovado' });
    expect(o.delivery).toEqual({ type: 'frete', label: 'Correios PAC' });
  });

  test('pronto: retirada no local não exige endereço', async () => {
    const o = await detail(seed({ pickup: true, total: 39990 }));
    expect(o.readiness.state).toBe('pronto');
    expect(o.delivery).toEqual({ type: 'retirada', label: 'Retirada no local' });
    expect(o.address).toBeNull();
  });

  const BLOCKS = [
    ['Pagamento pendente', { status: 'pending', payments: [] }],
    ['Pagamento recusado', { status: 'failed', payments: [{ status: 'rejected', amount: 42565 }] }],
    ['Pedido cancelado', { status: 'cancelled', payments: [{ status: 'cancelled', amount: 42565 }] }],
    ['Pagamento estornado', { status: 'cancelled', payments: [{ status: 'refunded', amount: 42565 }] }],
    ['Pagamento estornado', { status: 'cancelled', payments: [{ status: 'charged_back', amount: 42565 }] }],
    ['Valor pago diferente do total', { payments: [{ status: 'approved', amount: 100 }] }],
    ['Valor pago diferente do total', { status: 'pending', payments: [{ status: 'amount_mismatch', amount: 100 }] }],
    ['Pagamento aprovado não encontrado', { payments: [] }],
    ['Endereço incompleto', { address: { number: '' } }],
    ['Endereço incompleto', { address: { cep: '0100' } }],
    ['Endereço incompleto', { address: { state: 'XX' } }],
    ['Endereço incompleto', { address: null }],
    ['Forma de entrega não registrada', { shipment: null }]
  ];
  for (const [reason, setup] of BLOCKS) {
    test(`não liberar: ${reason} (${JSON.stringify(setup).slice(0, 60)})`, async () => {
      const o = await detail(seed(setup));
      expect(o.readiness.state).toBe('nao_liberar');
      expect(o.readiness.label).toBe('Não liberar');
      expect(o.readiness.reasons).toContain(reason);
    });
  }

  test('pendente nunca aparece como pronto, mesmo com endereço e entrega válidos', async () => {
    const o = await detail(seed({ status: 'pending', payments: [{ status: 'in_process', amount: 42565 }] }));
    expect(o.readiness.state).toBe('nao_liberar');
    expect(o.payment.status).toBe('pendente');
  });

  test('já enviado ou retirado: situação “Enviado”/“Retirado”', async () => {
    expect((await detail(seed({ status: 'shipped', shipmentStatus: 'shipped' }))).readiness).toMatchObject({ state: 'enviado', label: 'Enviado' });
    expect((await detail(seed({ pickup: true, total: 39990, shipmentStatus: 'picked_up' }))).readiness).toMatchObject({ state: 'enviado', label: 'Retirado' });
  });
});

test.describe('adminOrders: lista, filtros e paginação', () => {
  const list = (query = {}) => run('adminOrders', { query, cookie: session() });

  test.beforeEach(() => {
    seed({ name: 'Ana Pronta' }); // pronto
    seed({ name: 'Bia Pendente', status: 'pending', payments: [] });
    seed({ name: 'Caio Retira', pickup: true, total: 39990, quantity: 1 });
    seed({ name: 'Duda Estorno', status: 'cancelled', payments: [{ status: 'refunded', amount: 42565 }] });
    seed({ name: 'Edu Enviado', status: 'shipped', shipmentStatus: 'shipped', quantity: 2, total: 82555 });
  });

  test('resumo, ordem (mais recentes primeiro) e sem endereço na lista', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.body.summary).toEqual({ total: 5, prontos: 2, pendentes: 1, recusados_cancelados_estornados: 1, exemplares_vendidos: 4 });
    expect(res.body.orders.map((o) => o.customer.name)).toEqual(['Edu Enviado', 'Duda Estorno', 'Caio Retira', 'Bia Pendente', 'Ana Pronta']);
    expect(JSON.stringify(res.body.orders)).not.toContain('Praça da Sé');
  });

  test('exemplares restantes só aparece com BOOK_STOCK', async () => {
    process.env.BOOK_STOCK = '85';
    const res = await list();
    expect(res.body.summary.exemplares_restantes).toBe(85 - 4); // pagos e enviados; o pendente é antigo (mais de 48 h)
  });

  test('filtros por pagamento, situação, entrega, período e busca', async () => {
    const names = async (q) => (await list(q)).body.orders.map((o) => o.customer.name).sort();
    expect(await names({ status: 'pendente' })).toEqual(['Bia Pendente']);
    expect(await names({ status: 'estornado' })).toEqual(['Duda Estorno']);
    expect(await names({ situacao: 'pronto' })).toEqual(['Ana Pronta', 'Caio Retira']);
    expect(await names({ situacao: 'enviado' })).toEqual(['Edu Enviado']);
    expect(await names({ entrega: 'retirada' })).toEqual(['Caio Retira']);
    expect(await names({ q: 'BIA' })).toEqual(['Bia Pendente']);
    const anyId = backend.db.orders[0].id;
    expect(await names({ q: anyId.slice(0, 8) })).toEqual(['Ana Pronta']);
    const day = (o) => new Date(Date.parse(o.created_at) - 3 * 3600 * 1000).toISOString().slice(0, 10);
    const d = day(backend.db.orders[2]);
    expect(await names({ de: d, ate: d })).toEqual(['Caio Retira']);
  });

  test('paginação', async () => {
    const p1 = await list({ page: 1, page_size: 2 });
    const p3 = await list({ page: 3, page_size: 2 });
    expect(p1.body).toMatchObject({ page: 1, page_size: 2, total: 5 });
    expect(p1.body.orders).toHaveLength(2);
    expect(p3.body.orders).toHaveLength(1);
  });

  test('parâmetros inválidos: 400 sem detalhes', async () => {
    for (const q of [{ page: '0' }, { page: 'abc' }, { page_size: '500' }, { status: 'pago' }, { situacao: 'x' }, { entrega: 'drone' }, { de: '2026-13-45' }, { ate: 'ontem' }, { q: 'x'.repeat(101) }, { id: 'nao-e-uuid' }]) {
      expect(await list(q), JSON.stringify(q)).toMatchObject({ status: 400, body: { error: 'Parâmetros inválidos.' } });
    }
  });

  test('detalhe: 404 para pedido inexistente', async () => {
    expect((await list({ id: crypto.randomUUID() })).status).toBe(404);
  });

  test('erro no Supabase: mensagem genérica e log sem dados pessoais', async () => {
    const logs = [];
    const original = console.error;
    console.error = (...args) => logs.push(args.join(' '));
    global.fetch = async () => ({ ok: false, status: 500, text: async () => '{"message":"Ana Pronta ana@example.com"}' });
    try {
      expect(await list()).toMatchObject({ status: 500, body: { error: 'Não foi possível carregar os pedidos.' } });
    } finally {
      console.error = original;
    }
    expect(logs.join('\n')).not.toMatch(/Ana|@example|Praça/);
  });
});

test.describe('adminMarkShipped', () => {
  const mark = (body) => run('adminMarkShipped', { method: 'POST', body, cookie: session() });

  test('pedido pronto (frete): grava envio, rastreio, data e quem marcou; o pedido vira shipped', async () => {
    const id = seed();
    const res = await mark({ order_id: id, tracking_code: 'AB123456789BR', shipped_on: '2026-10-20' });
    expect(res.status).toBe(200);
    const shipment = backend.db.shipments.find((s) => s.order_id === id);
    expect(shipment).toMatchObject({ status: 'shipped', tracking_code: 'AB123456789BR', marked_by: EMAIL });
    expect(shipment.shipped_at).toBe('2026-10-20T15:00:00.000Z');
    expect(backend.db.orders.find((o) => o.id === id).status).toBe('shipped');
    expect(res.body.order.readiness.state).toBe('enviado');
  });

  test('retirada: vira picked_up', async () => {
    const id = seed({ pickup: true, total: 39990 });
    expect((await mark({ order_id: id })).status).toBe(200);
    expect(backend.db.shipments.find((s) => s.order_id === id).status).toBe('picked_up');
  });

  test('não duplica: a segunda marcação é recusada', async () => {
    const id = seed();
    expect((await mark({ order_id: id })).status).toBe(200);
    const again = await mark({ order_id: id, tracking_code: 'OUTRO123' });
    expect(again).toMatchObject({ status: 409, body: { error: 'Este pedido já foi marcado como enviado ou retirado.' } });
    expect(backend.db.shipments.find((s) => s.order_id === id).tracking_code).toBeNull();
  });

  test('pedido não pronto: 409 com os motivos e nada é gravado', async () => {
    const id = seed({ status: 'pending', payments: [] });
    const res = await mark({ order_id: id });
    expect(res.status).toBe(409);
    expect(res.body.reasons).toContain('Pagamento pendente');
    expect(backend.db.shipments.find((s) => s.order_id === id).status).toBe('quoted');
    expect(backend.db.orders.find((o) => o.id === id).status).toBe('pending');
  });

  test('entradas inválidas: 400', async () => {
    const id = seed();
    expect((await mark({ order_id: 'x' })).status).toBe(400);
    expect((await mark({ order_id: id, tracking_code: '<script>' })).status).toBe(400);
    expect((await mark({ order_id: id, shipped_on: '2099-01-01' })).status).toBe(400);
    expect((await mark({ order_id: id, shipped_on: '20/10/2026' })).status).toBe(400);
  });

  test('banco sem a migração (colunas novas ausentes): erro genérico, pedido intacto', async () => {
    restore();
    backend = createBackend({ missingColumns: ['shipped_at', 'marked_by'] });
    restore = install(backend, adminEnv());
    const id = seed();
    const res = await mark({ order_id: id });
    expect(res).toMatchObject({ status: 500, body: { error: 'Não foi possível registrar o envio.' } });
    expect(backend.db.orders.find((o) => o.id === id).status).toBe('paid');
    expect(backend.db.shipments.find((s) => s.order_id === id).status).toBe('quoted');
  });
});

test.describe('adminRecheckPayment', () => {
  test('consulta o Mercado Pago e não grava nada', async () => {
    const id = seed({ status: 'pending', payments: [] });
    backend.mp.payments['777'] = { id: 777, status: 'approved', transaction_amount: 425.65, external_reference: id, payment_method_id: 'pix', date_approved: '2026-10-20T10:00:00Z' };
    backend.mp.payments['778'] = { id: 778, status: 'approved', transaction_amount: 1, external_reference: crypto.randomUUID() };
    const before = JSON.stringify(backend.db);
    const res = await run('adminRecheckPayment', { method: 'POST', body: { order_id: id }, cookie: session() });
    expect(res.status).toBe(200);
    expect(res.body.saved).toBe(false);
    expect(res.body.payments).toEqual([
      expect.objectContaining({ id: '777', status: 'approved', label: 'Aprovado', amount_cents: 42565, amount_matches: true, method: 'pix' })
    ]);
    expect(JSON.stringify(backend.db)).toBe(before);
    expect(backend.calls.filter((c) => c.url.includes('supabase.test') && c.method !== 'GET')).toHaveLength(0);
  });

  test('pedido inválido, inexistente, sem token e Mercado Pago fora do ar', async () => {
    const recheck = (order_id) => run('adminRecheckPayment', { method: 'POST', body: { order_id }, cookie: session() });
    expect((await recheck('x')).status).toBe(400);
    expect((await recheck(crypto.randomUUID())).status).toBe(404);
    const id = seed();
    backend.mp.paymentFetchFails = true;
    expect((await recheck(id)).status).toBe(502);
    delete process.env.MERCADOPAGO_ACCESS_TOKEN;
    expect((await recheck(id)).status).toBe(503);
  });
});

test.describe('adminExport (CSV)', () => {
  test('só pedidos prontos por frete, com neutralização de fórmulas', async () => {
    seed({ name: '=HYPERLINK("http://x","clique")', phone: '+5554999', address: { street: '@SUM(A1)', complement: '-1+2', city: '\tTab' } });
    seed({ name: 'Pendente', status: 'pending', payments: [] });
    seed({ name: 'Retirada', pickup: true, total: 39990 });
    const res = await run('adminExport', { cookie: session() });
    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.headers['Content-Disposition']).toMatch(/^attachment; filename="pedidos-prontos-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.raw.startsWith('﻿')).toBe(true);
    const lines = res.raw.slice(1).trim().split('\r\n');
    expect(lines).toHaveLength(2); // cabeçalho + 1 pedido pronto por frete
    expect(lines[0]).toBe('"Pedido";"ID completo";"Nome";"Telefone";"Endereço";"Complemento";"Bairro";"Cidade";"UF";"CEP";"Itens";"Quantidade";"Serviço"');
    const row = lines[1];
    expect(row).toContain(`"'=HYPERLINK(""http://x"",""clique"")"`);
    expect(row).toContain(`"'+5554999"`);
    expect(row).toContain(`"'@SUM(A1), 100"`);
    expect(row).toContain(`"'-1+2"`);
    expect(row).toContain(`"'\tTab"`);
    expect(row).toContain('"01001-000"');
    expect(row).toContain('"Correios PAC"');
    expect(row).not.toContain('Pendente');
    expect(row).not.toContain('Retirada');
  });

  test('csvCell: =, +, -, @ recebem apóstrofo; aspas são escapadas', () => {
    const { csvCell } = require('../functions/_lib/adminOrders');
    expect(csvCell('=1+1')).toBe(`"'=1+1"`);
    expect(csvCell('@x')).toBe(`"'@x"`);
    expect(csvCell('normal "aspas"')).toBe('"normal ""aspas"""');
    expect(csvCell(null)).toBe('""');
  });
});
