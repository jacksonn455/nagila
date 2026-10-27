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

// Webhook ainda não chegou: orderStatus consulta o pagamento direto no Mercado Pago
test.describe('orderStatus — consulta ao Mercado Pago', () => {
  const { createBackend, install, call } = require('./helpers/backend');
  const TOTAL = 42565;
  let backend;
  let restore;

  test.beforeEach(() => {
    backend = createBackend();
    restore = install(backend);
    backend.db.orders.push({ id: ORDER_ID, status: 'pending', total_cents: TOTAL });
  });
  test.afterEach(() => restore());

  const status = async (query) => (await call('orderStatus', { httpMethod: 'GET', queryStringParameters: { order_id: ORDER_ID, ...query } })).body.status;
  const payment = (status, extra = {}) => {
    backend.mp.payments['321'] = { id: 321, status, transaction_amount: TOTAL / 100, external_reference: ORDER_ID, ...extra };
  };

  test('aprovado no Mercado Pago: devolve "paid" sem gravar nada', async () => {
    payment('approved');
    expect(await status({ payment_id: '321' })).toBe('paid');
    expect(backend.db.orders[0].status).toBe('pending'); // quem grava é o webhook
    expect(backend.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  test('recusado no Mercado Pago: devolve "failed"', async () => {
    payment('rejected');
    expect(await status({ payment_id: '321' })).toBe('failed');
  });

  test('ainda pendente no Mercado Pago: continua "pending"', async () => {
    payment('in_process');
    expect(await status({ payment_id: '321' })).toBe('pending');
  });

  test('pagamento de outro pedido ou com valor diferente: ignorado', async () => {
    payment('approved', { external_reference: '99999999-2222-4333-8444-555555555555' });
    expect(await status({ payment_id: '321' })).toBe('pending');
    payment('approved', { transaction_amount: 1 });
    expect(await status({ payment_id: '321' })).toBe('pending');
  });

  test('sem payment_id, id não numérico ou sem token: não consulta o Mercado Pago', async () => {
    payment('approved');
    expect(await status({})).toBe('pending');
    expect(await status({ payment_id: 'abc' })).toBe('pending');
    delete process.env.MERCADOPAGO_ACCESS_TOKEN;
    expect(await status({ payment_id: '321' })).toBe('pending');
    expect(backend.calls.some((c) => c.url.includes('mercadopago'))).toBe(false);
  });

  test('pedido inválido ou inexistente', async () => {
    expect(await call('orderStatus', { httpMethod: 'GET', queryStringParameters: { order_id: 'x' } })).toEqual({ status: 400, body: { error: 'Pedido inválido.' } });
    expect(
      await call('orderStatus', { httpMethod: 'GET', queryStringParameters: { order_id: '99999999-2222-4333-8444-555555555555' } })
    ).toEqual({ status: 404, body: { error: 'Pedido não encontrado.' } });
  });
});
