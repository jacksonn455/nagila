const { test, expect } = require('@playwright/test');

// orderStatus com o Supabase simulado por um fetch falso — nada é gravado.

const ORDER_ID = '11111111-2222-4333-8444-555555555555';

let savedEnv;
let savedFetch;

test.beforeEach(() => {
  savedEnv = { ...process.env };
  savedFetch = global.fetch;
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  delete process.env.MERCADOPAGO_ACCESS_TOKEN;
});

test.afterEach(() => {
  process.env = savedEnv;
  global.fetch = savedFetch;
});

async function orderStatus(orderStatusValue, payments) {
  global.fetch = async (url) => {
    const u = new URL(String(url));
    let rows = [];
    if (u.pathname.endsWith('/orders')) rows = [{ id: ORDER_ID, status: orderStatusValue, total_cents: 42565 }];
    if (u.pathname.endsWith('/payments')) {
      const allowed = u.searchParams.get('status').slice(4, -1).split(',');
      rows = payments.filter((p) => allowed.includes(p.status));
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
  };
  const { handler } = require('../functions/orderStatus/index.js');
  const res = await handler({ httpMethod: 'GET', queryStringParameters: { order_id: ORDER_ID } });
  return JSON.parse(res.body).status;
}

test.describe('orderStatus — estorno', () => {
  test('cancelado por estorno vira "refunded"', async () => {
    expect(await orderStatus('cancelled', [{ id: 'p1', status: 'refunded' }])).toBe('refunded');
  });

  test('cancelado por chargeback vira "refunded"', async () => {
    expect(await orderStatus('cancelled', [{ id: 'p1', status: 'charged_back' }])).toBe('refunded');
  });

  test('cancelado sem cobrança continua "cancelled"', async () => {
    expect(await orderStatus('cancelled', [{ id: 'p1', status: 'cancelled' }])).toBe('cancelled');
  });

  test('pago continua "paid"', async () => {
    expect(await orderStatus('paid', [{ id: 'p1', status: 'approved' }])).toBe('paid');
  });
});
