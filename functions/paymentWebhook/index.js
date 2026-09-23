/*
 Netlify Function: paymentWebhook
 - Recebe notificações do Mercado Pago (Webhooks e IPN)
 - Valida a assinatura x-signature quando MERCADOPAGO_WEBHOOK_SECRET está configurado
 - Busca o pagamento na API do Mercado Pago (fonte da verdade — nunca confia no corpo)
 - Atualiza payments e o status do pedido no Supabase

 Respostas 2xx encerram as tentativas do Mercado Pago; 5xx fazem ele reenviar.
*/

const crypto = require('crypto');
const { json, readBody } = require('../_lib/http');
const { sb } = require('../_lib/supabase');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Status do Mercado Pago -> status do pedido
const STATUS_MAP = {
  approved: 'paid',
  authorized: 'pending',
  pending: 'pending',
  in_process: 'pending',
  in_mediation: 'pending',
  rejected: 'failed',
  cancelled: 'cancelled',
  refunded: 'cancelled',
  charged_back: 'cancelled'
};

// Transições permitidas (evita regressões, ex.: paid -> pending).
// failed -> paid/pending: o comprador pode tentar outro meio na mesma preferência.
const TRANSITIONS = {
  pending: ['paid', 'failed', 'cancelled'],
  failed: ['paid', 'pending', 'cancelled'],
  paid: ['cancelled'],
  cancelled: [],
  shipped: []
};

// true = válida, false = inválida, null = não verificável (sem secret ou sem header)
// https://www.mercadopago.com.br/developers/pt/docs/your-integrations/notifications/webhooks
function verifySignature(headers, dataId) {
  const secret = process.env.MERCADOPAGO_WEBHOOK_SECRET;
  const signature = headers['x-signature'];
  if (!secret || !signature) return null;

  const parts = Object.fromEntries(
    signature.split(',').map((kv) => kv.split('=').map((s) => s.trim()))
  );
  if (!parts.ts || !parts.v1) return false;

  const requestId = headers['x-request-id'];
  let manifest = '';
  if (dataId) manifest += `id:${/^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId};`;
  if (requestId) manifest += `request-id:${requestId};`;
  manifest += `ts:${parts.ts};`;

  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function fetchPayment(paymentId) {
  const res = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Bearer ${process.env.MERCADOPAGO_ACCESS_TOKEN}` }
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Mercado Pago payment fetch failed (${res.status})`);
  return res.json();
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const body = readBody(event) || {};
  const query = event.queryStringParameters || {};
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));

  const type = body.type || query.type || query.topic || body.topic || null;
  if (type && type !== 'payment') return json(200, { ok: true, ignored: type });

  const paymentId = String(query['data.id'] || (body.data && body.data.id) || query.id || '').trim();
  if (!paymentId) return json(400, { error: 'Missing payment id' });

  if (verifySignature(headers, paymentId) === false) {
    console.warn('Webhook with invalid signature for payment', paymentId);
    return json(401, { error: 'Invalid signature' });
  }

  if (!process.env.MERCADOPAGO_ACCESS_TOKEN) {
    console.error('MERCADOPAGO_ACCESS_TOKEN not configured');
    return json(503, { error: 'Not configured' });
  }

  try {
    const payment = await fetchPayment(paymentId);
    // Ex.: notificação de teste do painel com id fictício
    if (!payment) return json(200, { ok: true, ignored: 'payment_not_found' });

    const orderId = payment.external_reference;
    if (!orderId || !UUID_RE.test(orderId)) return json(200, { ok: true, ignored: 'no_order_reference' });

    const [order] = await sb(`orders?id=eq.${orderId}&select=id,status,total_cents`);
    if (!order) {
      console.warn('Webhook for unknown order', orderId);
      return json(200, { ok: true, ignored: 'order_not_found' });
    }

    const paidCents = Math.round(Number(payment.transaction_amount || 0) * 100);
    const amountOk = paidCents === Number(order.total_cents);
    const mapped = STATUS_MAP[payment.status] || 'pending';

    // Upsert pelo id do pagamento: a mesma transação muda de status ao longo do tempo
    await sb('payments?on_conflict=mercadopago_payment_id', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates',
      body: {
        order_id: order.id,
        provider: 'mercadopago',
        mercadopago_payment_id: String(payment.id),
        method: payment.payment_method_id || payment.payment_type_id || null,
        status: amountOk ? payment.status : 'amount_mismatch',
        amount_cents: paidCents,
        raw: payment,
        updated_at: new Date().toISOString()
      }
    });

    if (body.id) {
      await sb('processed_notifications?on_conflict=provider,provider_notification_id', {
        method: 'POST',
        prefer: 'resolution=ignore-duplicates',
        body: { provider: 'mercadopago', provider_notification_id: String(body.id), payload: body }
      });
    }

    if (!amountOk) {
      console.warn(`Amount mismatch on order ${order.id}: paid ${paidCents}, expected ${order.total_cents}`);
      return json(200, { ok: true, note: 'amount_mismatch' });
    }

    if ((TRANSITIONS[order.status] || []).includes(mapped)) {
      // Filtra pelo status atual para não sobrescrever uma atualização concorrente
      await sb(`orders?id=eq.${order.id}&status=eq.${order.status}`, { method: 'PATCH', body: { status: mapped } });
    }

    return json(200, { ok: true, status: mapped });
  } catch (err) {
    console.error(err);
    return json(500, { error: 'Webhook processing failed' });
  }
};
