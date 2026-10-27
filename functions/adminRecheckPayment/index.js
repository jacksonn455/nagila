/*
 Netlify Function: adminRecheckPayment (protegida)
 POST { order_id } (cabeçalho X-Admin-Request: 1)
 Consulta direto na API do Mercado Pago os pagamentos do pedido (external_reference)
 e devolve o status real. NÃO grava nada no banco: serve para conferir quando o
 webhook atrasou. Quem atualiza o pedido continua sendo o paymentWebhook.
*/

const { readBody } = require('../_lib/http');
const { sb } = require('../_lib/supabase');
const { adminJson, requireAdmin } = require('../_lib/adminAuth');
const { UUID_RE, safeError } = require('../_lib/adminOrders');

const STATUS_LABELS = {
  approved: 'Aprovado',
  authorized: 'Autorizado',
  pending: 'Pendente',
  in_process: 'Em análise',
  in_mediation: 'Em mediação',
  rejected: 'Recusado',
  cancelled: 'Cancelado',
  refunded: 'Estornado',
  charged_back: 'Chargeback'
};

exports.handler = async (event) => {
  const guard = requireAdmin(event, { methods: ['POST'] });
  if (guard.response) return guard.response;

  const body = readBody(event) || {};
  const orderId = typeof body.order_id === 'string' ? body.order_id.toLowerCase() : '';
  if (!UUID_RE.test(orderId)) return adminJson(400, { error: 'Pedido inválido.' });
  if (!process.env.MERCADOPAGO_ACCESS_TOKEN) return adminJson(503, { error: 'Mercado Pago não configurado.' });

  try {
    const [order] = await sb(`orders?id=eq.${orderId}&select=id,status,total_cents`);
    if (!order) return adminJson(404, { error: 'Pedido não encontrado.' });

    const res = await fetch(
      `https://api.mercadopago.com/v1/payments/search?external_reference=${orderId}&sort=date_created&criteria=desc`,
      { headers: { Authorization: `Bearer ${process.env.MERCADOPAGO_ACCESS_TOKEN}` } }
    );
    if (!res.ok) {
      console.error('adminRecheckPayment: Mercado Pago respondeu', res.status, 'pedido', orderId);
      return adminJson(502, { error: 'Não foi possível consultar o Mercado Pago agora.' });
    }
    const data = await res.json();
    const payments = (Array.isArray(data.results) ? data.results : [])
      .filter((p) => p.external_reference === orderId)
      .map((p) => {
        const amount = Math.round(Number(p.transaction_amount || 0) * 100);
        return {
          id: String(p.id),
          status: p.status,
          label: STATUS_LABELS[p.status] || p.status,
          status_detail: p.status_detail || null,
          method: p.payment_method_id || p.payment_type_id || null,
          amount_cents: amount,
          amount_matches: amount === Number(order.total_cents),
          date_created: p.date_created || null,
          date_approved: p.date_approved || null
        };
      });
    return adminJson(200, { order_status: order.status, total_cents: Number(order.total_cents), payments, saved: false });
  } catch (err) {
    console.error('adminRecheckPayment failed:', safeError(err), 'pedido', orderId);
    return adminJson(500, { error: 'Não foi possível consultar o pagamento.' });
  }
};
