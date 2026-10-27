const { test, expect } = require('@playwright/test');

// Controle de estoque (BOOK_STOCK). As Functions rodam direto no Node com o
// Supabase e o Mercado Pago simulados por um fetch falso — nada é gravado.

const HOUR = 3600 * 1000;
const ORDER_ID = '11111111-2222-4333-8444-555555555555';

const BOOK_ENV = {
  BOOK_TITLE: 'Livro de teste',
  BOOK_PRICE_CENTS: '39990',
  BOOK_WEIGHT_GRAMS: '260',
  BOOK_LENGTH_CM: '23',
  BOOK_WIDTH_CM: '16',
  BOOK_HEIGHT_CM: '2',
  BOOK_MAX_QUANTITY: '3',
  SUPABASE_URL: 'https://supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  MERCADOPAGO_ACCESS_TOKEN: 'test-token'
};

// Linhas de order_items com o status e a data do pedido (como o embed orders!inner devolve)
function item(quantity, status, hoursAgo = 1) {
  return { quantity, orders: { status, created_at: new Date(Date.now() - hoursAgo * HOUR).toISOString() } };
}

// Simula o PostgREST: aplica os filtros de status e created_at da consulta de estoque
function fakeFetch(items, { failSupabase = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ url: String(url), method });
    const u = new URL(String(url));
    const reply = (body, status = 200) => ({
      ok: status < 400,
      status,
      json: async () => body,
      text: async () => (body == null ? '' : JSON.stringify(body))
    });

    if (u.hostname === 'api.mercadopago.com') return reply({ id: 'pref-test', init_point: 'https://mp.test/checkout' });
    if (failSupabase) return reply({ message: 'down' }, 503);

    const table = u.pathname.replace('/rest/v1/', '');
    if (table === 'order_items' && method === 'GET') {
      const statusFilter = u.searchParams.get('orders.status');
      const since = u.searchParams.get('orders.created_at');
      const statuses = statusFilter.startsWith('in.') ? statusFilter.slice(4, -1).split(',') : [statusFilter.slice(3)];
      const rows = items.filter(
        (r) => statuses.includes(r.orders.status) && (!since || r.orders.created_at >= since.replace(/^gte\./, ''))
      );
      return reply(rows);
    }
    if (table === 'orders' && method === 'GET') return reply([]); // sem pedido repetido (idempotência)
    if (table === 'customers') return reply([{ id: 'customer-test' }]);
    if (table === 'orders' && method === 'POST') return reply([{ id: ORDER_ID }]);
    return reply(null);
  };
  return { fetchImpl, calls };
}

function load(name) {
  const path = require.resolve(`../functions/${name}/index.js`);
  return require(path).handler;
}

let savedEnv;
let savedFetch;

test.beforeEach(() => {
  savedEnv = { ...process.env };
  savedFetch = global.fetch;
  Object.assign(process.env, BOOK_ENV);
  delete process.env.BOOK_STOCK;
});

test.afterEach(() => {
  process.env = savedEnv;
  global.fetch = savedFetch;
});

async function bookInfo(items, opts) {
  const { fetchImpl, calls } = fakeFetch(items, opts);
  global.fetch = fetchImpl;
  const res = await load('bookInfo')({ httpMethod: 'GET' });
  return { status: res.statusCode, body: JSON.parse(res.body), calls };
}

async function createOrder(items, quantity) {
  const { fetchImpl, calls } = fakeFetch(items);
  global.fetch = fetchImpl;
  const res = await load('createOrder')({
    httpMethod: 'POST',
    body: JSON.stringify({
      client_token: `ct-${Math.random().toString(36).slice(2)}`,
      name: 'Teste',
      email: 'teste@example.com',
      quantity,
      address: {},
      shipping_option_id: 'pickup'
    })
  });
  const orderInserted = calls.some((c) => c.method === 'POST' && c.url.endsWith('/rest/v1/orders'));
  return { status: res.statusCode, body: JSON.parse(res.body), orderInserted };
}

test.describe('estoque — servidor', () => {
  test('sem BOOK_STOCK: comportamento atual, sem consultar estoque', async () => {
    const info = await bookInfo([item(99, 'paid')]);
    expect(info.body).toMatchObject({ available: true, sold_out: false, low_stock: false, max_quantity: 3 });
    expect(info.calls.some((c) => c.url.includes('order_items'))).toBe(false);

    const order = await createOrder([item(99, 'paid')], 3);
    expect(order.status).toBe(200);
    expect(order.body.init_point).toBe('https://mp.test/checkout');
  });

  test('estoque suficiente: vende normalmente', async () => {
    process.env.BOOK_STOCK = '85';
    const items = [item(10, 'paid'), item(2, 'pending')];
    const info = await bookInfo(items);
    expect(info.body).toMatchObject({ available: true, sold_out: false, low_stock: false, max_quantity: 3 });
    expect(JSON.stringify(info.body)).not.toContain('73'); // o total disponível não é exposto

    const order = await createOrder(items, 3);
    expect(order.status).toBe(200);
    expect(order.orderInserted).toBe(true);
  });

  test('estoque parcial: limita a quantidade e recusa o excedente', async () => {
    process.env.BOOK_STOCK = '10';
    const items = [item(5, 'paid'), item(3, 'shipped')]; // enviados também contam como vendidos
    const info = await bookInfo(items);
    expect(info.body).toMatchObject({ available: true, sold_out: false, low_stock: true, max_quantity: 2 });

    const tooMany = await createOrder(items, 3);
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error).toBe('Restam apenas 2 exemplares.');
    expect(tooMany.orderInserted).toBe(false);

    expect((await createOrder(items, 2)).status).toBe(200);

    const one = await createOrder([...items, item(1, 'paid')], 2);
    expect(one.body.error).toBe('Resta apenas 1 exemplar.');
  });

  test('esgotado: bookInfo indica e createOrder recusa', async () => {
    process.env.BOOK_STOCK = '10';
    const items = [item(8, 'paid'), item(2, 'pending')];
    const info = await bookInfo(items);
    expect(info.body).toMatchObject({ available: false, sold_out: true, low_stock: false, max_quantity: 0 });

    const order = await createOrder(items, 1);
    expect(order.status).toBe(409);
    expect(order.body.error).toBe('Livro esgotado no momento.');
    expect(order.orderInserted).toBe(false);
  });

  test('BOOK_STOCK=0 significa esgotado', async () => {
    process.env.BOOK_STOCK = '0';
    const info = await bookInfo([]);
    expect(info.body).toMatchObject({ available: false, sold_out: true });
  });

  test('pendente com mais de 48 h não segura estoque', async () => {
    process.env.BOOK_STOCK = '10';
    const old = await bookInfo([item(8, 'paid'), item(2, 'pending', 49)]);
    expect(old.body).toMatchObject({ sold_out: false, max_quantity: 2 });

    const recent = await bookInfo([item(8, 'paid'), item(2, 'pending', 47)]);
    expect(recent.body).toMatchObject({ sold_out: true });

    // pedidos recusados/cancelados nunca seguram estoque
    const failed = await bookInfo([item(8, 'paid'), item(2, 'failed'), item(2, 'cancelled')]);
    expect(failed.body).toMatchObject({ sold_out: false, max_quantity: 2 });
  });

  test('BOOK_STOCK inválido desativa o controle (com log)', async () => {
    process.env.BOOK_STOCK = '85,';
    const info = await bookInfo([item(99, 'paid')]);
    expect(info.body).toMatchObject({ available: true, sold_out: false, max_quantity: 3 });
  });

  test('Supabase fora do ar: bookInfo não derruba a página', async () => {
    process.env.BOOK_STOCK = '85';
    const info = await bookInfo([], { failSupabase: true });
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ available: true, sold_out: false, max_quantity: 3 });
  });
});

test.describe('estoque — página', () => {
  async function mockBookInfo(page, extra) {
    await page.route('**/.netlify/functions/bookInfo', (route) =>
      route.fulfill({
        status: 200,
        body: JSON.stringify({ title: 'Livro', price_cents: 39990, max_quantity: 3, available: true, sold_out: false, low_stock: false, pickup: null, ...extra })
      })
    );
  }

  test('esgotado: desativa a compra e avisa', async ({ page }) => {
    await mockBookInfo(page, { available: false, sold_out: true, max_quantity: 0 });
    await page.goto('/livro.html');
    await expect(page.locator('#buy')).toBeDisabled();
    await expect(page.locator('#buy')).toHaveText('Esgotado');
    await expect(page.locator('#calc-shipping')).toBeDisabled();
    await expect(page.locator('#hero-cta')).toHaveText('Esgotado');
    await expect(page.locator('#messages')).toContainText('Livro esgotado no momento.');
    await expect(page.locator('.book-price .stock-flag')).toHaveText('Esgotado');
  });

  test('poucos exemplares: mostra aviso e mantém a compra', async ({ page }) => {
    await mockBookInfo(page, { low_stock: true, max_quantity: 2 });
    await page.goto('/livro.html');
    await expect(page.locator('.book-price .stock-flag')).toHaveText('Últimos exemplares');
    await expect(page.locator('#buy')).toBeEnabled();
    await expect(page.locator('#quantity')).toHaveAttribute('max', '2');
  });

  test('com estoque normal: nenhum aviso', async ({ page }) => {
    await mockBookInfo(page, {});
    await page.goto('/livro.html');
    await expect(page.locator('#product-price')).toHaveText('R$ 399,90');
    await expect(page.locator('.stock-flag')).toHaveCount(0);
  });
});
