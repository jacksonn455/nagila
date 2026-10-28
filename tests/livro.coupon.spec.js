const { test, expect } = require('@playwright/test');
const { createBackend, install, call } = require('./helpers/backend');

// Cupom de desconto: validateCoupon e createOrder no Node (serviços simulados) e o campo na página.

const ADDRESS = { cep: '01001-000', street: 'Praça da Sé', number: '100', neighborhood: 'Sé', city: 'São Paulo', state: 'SP' };

let backend;
let restore;

function order(overrides = {}) {
  return {
    client_token: `ct-${Math.random().toString(36).slice(2, 12)}`,
    name: 'Maria Teste',
    email: 'maria@example.com',
    quantity: 1,
    address: ADDRESS,
    shipping_option_id: '1', // PAC R$ 25,75
    ...overrides
  };
}

const createOrder = (payload) => call('createOrder', { httpMethod: 'POST', body: JSON.stringify(payload) });
const validateCoupon = (payload) => call('validateCoupon', { httpMethod: 'POST', body: JSON.stringify(payload) });
const preference = () => backend.calls.filter((c) => c.url.endsWith('/checkout/preferences'))[0].body;

test.describe('cupom — servidor', () => {
  test.beforeEach(() => {
    backend = createBackend();
    restore = install(backend);
  });
  test.afterEach(() => restore());

  test('validateCoupon: 50OFF vale R$ 50, sem diferenciar maiúsculas', async () => {
    for (const code of ['50OFF', ' 50off ']) {
      expect(await validateCoupon({ code })).toEqual({
        status: 200,
        body: { code: '50OFF', description: 'R$ 50,00 de desconto no livro', discount_cents: 5000 }
      });
    }
  });

  test('validateCoupon: código inexistente é recusado', async () => {
    expect(await validateCoupon({ code: 'NAOEXISTE' })).toEqual({ status: 404, body: { error: 'Cupom inválido.' } });
    expect(await validateCoupon({})).toEqual({ status: 404, body: { error: 'Cupom inválido.' } });
    expect((await call('validateCoupon', { httpMethod: 'GET' })).status).toBe(405);
  });

  test('createOrder com 50OFF: desconta R$ 50 do total e da preferência', async () => {
    const res = await createOrder(order({ coupon: '50off' }));
    expect(res.status).toBe(200);

    const [o] = backend.db.orders;
    expect(o).toMatchObject({ total_cents: 39990 - 5000 + 2575, coupon_code: '50OFF', discount_cents: 5000 });
    expect(backend.db.order_items[0]).toMatchObject({ quantity: 1, unit_price_cents: 39990, subtotal_cents: 39990 });
    expect(backend.db.payments[0].amount_cents).toBe(o.total_cents);
    expect(preference().items).toEqual([
      { id: 'book-nagila-zortea-50off', title: 'Pós-operatório e o raciocínio diante da cirurgia plástica (cupom 50OFF)', quantity: 1, unit_price: 349.9, currency_id: 'BRL' },
      { id: 'frete-1', title: 'Frete — Correios PAC', quantity: 1, unit_price: 25.75, currency_id: 'BRL' }
    ]);
  });

  test('createOrder com 50OFF e 2 exemplares: desconto uma vez por pedido', async () => {
    const res = await createOrder(order({ coupon: '50OFF', quantity: 2 }));
    expect(res.status).toBe(200);
    expect(backend.db.orders[0].total_cents).toBe(2 * 39990 - 5000 + 2575);

    const items = preference().items;
    expect(items.map((i) => [i.quantity, i.unit_price])).toEqual([[1, 399.9], [1, 349.9], [1, 25.75]]);
    const sum = items.reduce((n, i) => n + Math.round(i.unit_price * 100) * i.quantity, 0);
    expect(sum).toBe(backend.db.orders[0].total_cents);
  });

  test('createOrder sem cupom não grava colunas de cupom', async () => {
    expect((await createOrder(order())).status).toBe(200);
    expect(backend.db.orders[0]).not.toHaveProperty('coupon_code');
    expect(backend.db.orders[0]).not.toHaveProperty('discount_cents');
  });

  test('createOrder com cupom inválido é recusado sem gravar nada', async () => {
    expect(await createOrder(order({ coupon: 'FALSO' }))).toEqual({ status: 400, body: { error: 'Cupom inválido.' } });
    expect(backend.db.orders).toHaveLength(0);
  });
});

test.describe('cupom — página', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/.netlify/functions/bookInfo', (route) =>
      route.fulfill({
        status: 200,
        body: JSON.stringify({ title: 'Livro', price_cents: 39990, max_quantity: 3, available: true, sold_out: false, low_stock: false, pickup: null })
      })
    );
    await page.route('**/.netlify/functions/calculateShipping', (route) =>
      route.fulfill({ status: 200, body: JSON.stringify({ options: [{ id: '1', service: 'PAC', carrier: 'Correios', price_cents: 2575, estimated_days: 6 }] }) })
    );
    await page.route('**/.netlify/functions/validateCoupon', (route) => {
      const { code } = route.request().postDataJSON();
      route.fulfill(
        code === '50OFF'
          ? { status: 200, body: JSON.stringify({ code: '50OFF', description: 'R$ 50,00 de desconto no livro', discount_cents: 5000 }) }
          : { status: 404, body: JSON.stringify({ error: 'Cupom inválido.' }) }
      );
    });
    await page.goto('/livro.html');
    await expect(page.locator('#product-price')).toHaveText('R$ 399,90');
    await page.fill('#cep', '01001-000');
    await page.click('#calc-shipping');
    await expect(page.locator('#summary-total')).toHaveText('R$ 425,65');
  });

  test('aplica 50OFF no resumo e envia o cupom no pedido', async ({ page }) => {
    await page.fill('#coupon', '50off');
    await page.click('#apply-coupon');
    await expect(page.locator('#coupon-status')).toHaveText('Cupom aplicado: R$ 50,00 de desconto no livro.');
    await expect(page.locator('#summary-discount-row')).toBeVisible();
    await expect(page.locator('#summary-discount')).toHaveText('− R$ 50,00');
    await expect(page.locator('#summary-total')).toHaveText('R$ 375,65');

    let sent;
    await page.route('**/.netlify/functions/createOrder', (route) => {
      sent = route.request().postDataJSON();
      route.fulfill({ status: 400, body: JSON.stringify({ error: 'parado no teste' }) });
    });
    await page.fill('#name', 'Maria');
    await page.fill('#email', 'maria@example.com');
    await page.fill('#street', 'Praça da Sé');
    await page.fill('#number', '100');
    await page.fill('#neighborhood', 'Sé');
    await page.fill('#city', 'São Paulo');
    await page.selectOption('#state', 'SP');
    await page.click('#buy');
    await expect(page.locator('#messages')).toHaveText('parado no teste');
    expect(sent.coupon).toBe('50OFF');
  });

  test('cupom inválido mostra erro; editar o código remove o desconto', async ({ page }) => {
    await page.fill('#coupon', 'FALSO');
    await page.click('#apply-coupon');
    await expect(page.locator('#coupon-status')).toHaveText('Cupom inválido.');
    await expect(page.locator('#summary-discount-row')).toBeHidden();

    await page.fill('#coupon', '50OFF');
    await page.press('#coupon', 'Enter');
    await expect(page.locator('#summary-total')).toHaveText('R$ 375,65');
    await page.fill('#coupon', '50OF');
    await expect(page.locator('#summary-discount-row')).toBeHidden();
    await expect(page.locator('#summary-total')).toHaveText('R$ 425,65');
  });
});
