/*
 Netlify Function: orderStatus
 GET ?order_id=<uuid>[&payment_id=<id>] -> { status }
 Usado pela página de retorno do Mercado Pago para mostrar o status real do pedido.
 Somente leitura: quem atualiza o pedido é o paymentWebhook.
*/

const { json } = require('../_lib/http');
const { sb } = require('../_lib/supabase');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Se o webhook ainda não chegou, consulta o pagamento direto no Mercado Pago
async function paymentStatus(paymentId, order) {
  if (!/^\d+$/.test(paymentId) || !process.env.MERCADOPAGO_ACCESS_TOKEN) return null;
  const res = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${process.env.MERCADOPAGO_ACCESS_TOKEN}` }
  });
  if (!res.ok) return null;
  const payment = await res.json();
  if (payment.external_reference !== order.id) return null;
  if (Math.round(Number(payment.transaction_amount || 0) * 100) !== Number(order.total_cents)) return null;
  if (payment.status === 'approved') return 'paid';
  if (payment.status === 'rejected') return 'failed';
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  const q = event.queryStringParameters || {};
  const orderId = String(q.order_id || '');
  if (!UUID_RE.test(orderId)) return json(400, { error: 'Pedido inválido.' });

  try {
    const [order] = await sb(`orders?id=eq.${orderId}&select=id,status,total_cents`);
    if (!order) return json(404, { error: 'Pedido não encontrado.' });

    let status = order.status;
    if ((status === 'pending' || status === 'failed') && q.payment_id) {
      status = (await paymentStatus(String(q.payment_id), order)) || status;
    }
    return json(200, { status });
  } catch (err) {
    console.error(err);
    return json(500, { error: 'Erro ao consultar o pedido.' });
  }
};
