const { test, expect } = require('@playwright/test');
const { createBackend, install, call, mpSignature } = require('./helpers/backend');

// paymentWebhook chamado direto no Node, com Supabase e Mercado Pago simulados.

const SECRET = 'segredo-de-teste';
const ORDER_ID = '11111111-2222-4333-8444-555555555555';
const TOTAL = 39990 + 2575;

let backend;
let restore;

function seedOrder(status = 'pending', total = TOTAL) {
  backend.db.orders.push({ id: ORDER_ID, status, total_cents: total });
}

function mpPayment(id, status, amountCents = TOTAL, extra = {}) {
  backend.mp.payments[id] = {
    id: Number(id),
    status,
    transaction_amount: amountCents / 100,
    external_reference: ORDER_ID,
    payment_method_id: 'pix',
    ...extra
  };
}

// Notificação no formato Webhooks: POST ?type=payment&data.id=<id> com { id, type, data: { id } }
function notify(paymentId, { headers = {}, notificationId = `n-${paymentId}` } = {}) {
  return call('paymentWebhook', {
    httpMethod: 'POST',
    queryStringParameters: { type: 'payment', 'data.id': String(paymentId) },
    headers,
    body: JSON.stringify({ id: notificationId, type: 'payment', data: { id: String(paymentId) } })
  });
}

const orderStatus = () => backend.db.orders[0].status;
const supabaseWrites = () => backend.calls.filter((c) => c.url.includes('supabase.test') && c.method !== 'GET');

test.describe('paymentWebhook', () => {
  test.beforeEach(() => {
    backend = createBackend();
    restore = install(backend);
  });
  test.afterEach(() => restore());

  test.describe('assinatura (x-signature)', () => {
    test('com secret e assinatura válida: processa', async () => {
      process.env.MERCADOPAGO_WEBHOOK_SECRET = SECRET;
      seedOrder();
      mpPayment('123', 'approved');
      const res = await notify('123', { headers: { 'x-signature': mpSignature(SECRET, '123', 'req-1'), 'x-request-id': 'req-1' } });
      expect(res).toEqual({ status: 200, body: { ok: true, status: 'paid' } });
      expect(orderStatus()).toBe('paid');
    });

    test('com secret e assinatura inválida: 401 e nada é gravado', async () => {
      process.env.MERCADOPAGO_WEBHOOK_SECRET = SECRET;
      seedOrder();
      mpPayment('123', 'approved');
      const res = await notify('123', { headers: { 'x-signature': mpSignature('outro-secret', '123', 'req-1'), 'x-request-id': 'req-1' } });
      expect(res).toEqual({ status: 401, body: { error: 'Invalid signature' } });
      expect(orderStatus()).toBe('pending');
      expect(supabaseWrites()).toHaveLength(0);
      expect(backend.calls.some((c) => c.url.includes('mercadopago'))).toBe(false);
    });

    test('com secret e assinatura malformada (sem ts/v1): 401', async () => {
      process.env.MERCADOPAGO_WEBHOOK_SECRET = SECRET;
      seedOrder();
      const res = await notify('123', { headers: { 'x-signature': 'qualquer-coisa', 'x-request-id': 'req-1' } });
      expect(res.status).toBe(401);
    });

    // Comportamento atual (ver relatório): sem o header, a assinatura não é verificável e a
    // notificação segue — o status vem sempre da API do Mercado Pago, nunca do corpo.
    test('com secret e SEM header de assinatura: processa consultando o Mercado Pago', async () => {
      process.env.MERCADOPAGO_WEBHOOK_SECRET = SECRET;
      seedOrder();
      mpPayment('123', 'approved');
      const res = await notify('123');
      expect(res.body).toEqual({ ok: true, status: 'paid' });
    });

    test('sem secret configurado: processa mesmo com assinatura qualquer', async () => {
      seedOrder();
      mpPayment('123', 'approved');
      const res = await notify('123', { headers: { 'x-signature': 'ts=1,v1=abc', 'x-request-id': 'req-1' } });
      expect(res.body).toEqual({ ok: true, status: 'paid' });
    });

    test('o corpo da notificação não decide o status (vem da API)', async () => {
      seedOrder();
      mpPayment('123', 'rejected');
      const res = await call('paymentWebhook', {
        httpMethod: 'POST',
        queryStringParameters: { type: 'payment', 'data.id': '123' },
        body: JSON.stringify({ type: 'payment', data: { id: '123' }, status: 'approved', action: 'payment.updated' })
      });
      expect(res.body.status).toBe('failed');
      expect(orderStatus()).toBe('failed');
    });
  });

  test.describe('tradução de status e transições', () => {
    const cases = [
      // [status do pedido antes, status no Mercado Pago, status do pedido depois]
      ['pending', 'approved', 'paid'],
      ['pending', 'authorized', 'pending'],
      ['pending', 'in_process', 'pending'],
      ['pending', 'in_mediation', 'pending'],
      ['pending', 'rejected', 'failed'],
      ['pending', 'cancelled', 'cancelled'],
      ['pending', 'status_desconhecido', 'pending'],
      ['failed', 'approved', 'paid'], // comprador tentou outro meio na mesma preferência
      ['failed', 'pending', 'pending'],
      ['paid', 'refunded', 'cancelled'],
      ['paid', 'charged_back', 'cancelled'],
      ['paid', 'pending', 'paid'], // não regride
      ['paid', 'rejected', 'paid'],
      ['cancelled', 'approved', 'cancelled'], // cancelado é final
      ['shipped', 'refunded', 'shipped']
    ];
    for (const [before, mpStatus, after] of cases) {
      test(`${before} + ${mpStatus} → ${after}`, async () => {
        seedOrder(before);
        mpPayment('555', mpStatus);
        const res = await notify('555');
        expect(res.status).toBe(200);
        expect(orderStatus()).toBe(after);
        expect(backend.db.payments[0]).toMatchObject({ order_id: ORDER_ID, mercadopago_payment_id: '555', status: mpStatus, amount_cents: TOTAL, method: 'pix' });
      });
    }

    test('a mesma transação atualiza o mesmo registro de pagamento (upsert)', async () => {
      seedOrder();
      mpPayment('777', 'in_process');
      await notify('777', { notificationId: 'n-1' });
      mpPayment('777', 'approved');
      await notify('777', { notificationId: 'n-2' });
      expect(backend.db.payments).toHaveLength(1);
      expect(backend.db.payments[0].status).toBe('approved');
      expect(orderStatus()).toBe('paid');
      expect(backend.db.processed_notifications.map((n) => n.provider_notification_id)).toEqual(['n-1', 'n-2']);
    });

    test('notificação repetida não duplica processed_notifications', async () => {
      seedOrder();
      mpPayment('777', 'approved');
      await notify('777', { notificationId: 'n-1' });
      await notify('777', { notificationId: 'n-1' });
      expect(backend.db.processed_notifications).toHaveLength(1);
    });

    test('formato IPN antigo (?topic=payment&id=...)', async () => {
      seedOrder();
      mpPayment('888', 'approved');
      const res = await call('paymentWebhook', { httpMethod: 'POST', queryStringParameters: { topic: 'payment', id: '888' } });
      expect(res.body).toEqual({ ok: true, status: 'paid' });
    });
  });

  test.describe('valores e pedidos', () => {
    test('valor pago diferente do total: marca amount_mismatch e não muda o pedido', async () => {
      seedOrder();
      mpPayment('123', 'approved', TOTAL - 100);
      const res = await notify('123');
      expect(res).toEqual({ status: 200, body: { ok: true, note: 'amount_mismatch' } });
      expect(orderStatus()).toBe('pending');
      expect(backend.db.payments[0]).toMatchObject({ status: 'amount_mismatch', amount_cents: TOTAL - 100 });
    });

    test('pedido desconhecido: 200 ignorado, sem gravar pagamento', async () => {
      mpPayment('123', 'approved');
      const res = await notify('123');
      expect(res).toEqual({ status: 200, body: { ok: true, ignored: 'order_not_found' } });
      expect(backend.db.payments).toHaveLength(0);
    });

    test('pagamento sem external_reference válido: ignorado', async () => {
      seedOrder();
      mpPayment('123', 'approved', TOTAL, { external_reference: 'nao-e-uuid' });
      expect((await notify('123')).body).toEqual({ ok: true, ignored: 'no_order_reference' });
      expect(orderStatus()).toBe('pending');
    });

    test('pagamento inexistente no Mercado Pago (ex.: teste do painel): ignorado', async () => {
      seedOrder();
      expect((await notify('999')).body).toEqual({ ok: true, ignored: 'payment_not_found' });
    });
  });

  test.describe('erros e entradas inválidas', () => {
    test('sem id de pagamento: 400', async () => {
      const res = await call('paymentWebhook', { httpMethod: 'POST', body: '{}' });
      expect(res).toEqual({ status: 400, body: { error: 'Missing payment id' } });
    });

    test('evento que não é de pagamento: ignorado', async () => {
      const res = await call('paymentWebhook', { httpMethod: 'POST', queryStringParameters: { type: 'merchant_order', 'data.id': '1' } });
      expect(res).toEqual({ status: 200, body: { ok: true, ignored: 'merchant_order' } });
    });

    test('sem token do Mercado Pago: 503', async () => {
      delete process.env.MERCADOPAGO_ACCESS_TOKEN;
      expect(await notify('123')).toEqual({ status: 503, body: { error: 'Not configured' } });
    });

    test('Mercado Pago fora do ar: 500 para o Mercado Pago reenviar', async () => {
      seedOrder();
      backend.mp.paymentFetchFails = true;
      expect(await notify('123')).toEqual({ status: 500, body: { error: 'Webhook processing failed' } });
      expect(orderStatus()).toBe('pending');
    });

    test('método diferente de POST: 405', async () => {
      expect((await call('paymentWebhook', { httpMethod: 'GET' })).status).toBe(405);
    });
  });
});
