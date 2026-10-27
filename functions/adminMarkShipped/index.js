/*
 Netlify Function: adminMarkShipped (protegida)
 POST { order_id, tracking_code?, shipped_on? (AAAA-MM-DD) } (cabeçalho X-Admin-Request: 1)
 Só para pedidos "Pronto para envio" (regra recalculada aqui). Grava em shipments
 status shipped/picked_up, código de rastreio, data e quem marcou; o pedido vira "shipped".
 Requer scripts/supabase-admin-migration.sql (colunas shipped_at e marked_by).
*/

const { readBody } = require('../_lib/http');
const { sb } = require('../_lib/supabase');
const { adminJson, requireAdmin } = require('../_lib/adminAuth');
const { UUID_RE, loadOrders, detailItem, safeError } = require('../_lib/adminOrders');

const TRACKING_RE = /^[A-Za-z0-9][A-Za-z0-9 .\-/]{2,39}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

exports.handler = async (event) => {
  const guard = requireAdmin(event, { methods: ['POST'] });
  if (guard.response) return guard.response;

  const body = readBody(event) || {};
  const orderId = typeof body.order_id === 'string' ? body.order_id.toLowerCase() : '';
  if (!UUID_RE.test(orderId)) return adminJson(400, { error: 'Pedido inválido.' });

  const tracking = typeof body.tracking_code === 'string' ? body.tracking_code.trim() : '';
  if (tracking && !TRACKING_RE.test(tracking)) return adminJson(400, { error: 'Código de rastreio inválido.' });

  let shippedAt = new Date();
  if (body.shipped_on) {
    const day = String(body.shipped_on);
    const parsed = DATE_RE.test(day) ? new Date(`${day}T12:00:00-03:00`) : null;
    // não aceita datas inválidas nem no futuro (margem de 1 dia por causa do fuso)
    if (!parsed || Number.isNaN(parsed.getTime()) || parsed.getTime() > Date.now() + 24 * 3600 * 1000) {
      return adminJson(400, { error: 'Data de envio inválida.' });
    }
    shippedAt = parsed;
  }

  try {
    const [view] = await loadOrders({ orderId });
    if (!view) return adminJson(404, { error: 'Pedido não encontrado.' });
    if (view.readiness.state === 'enviado') return adminJson(409, { error: 'Este pedido já foi marcado como enviado ou retirado.' });
    if (view.readiness.state !== 'pronto') {
      return adminJson(409, { error: 'Pedido não liberado para envio.', reasons: view.readiness.reasons });
    }

    const pickup = view.delivery.type === 'retirada';
    // Filtro pelo status atual: duas marcações ao mesmo tempo não duplicam
    const updated = await sb(`shipments?order_id=eq.${orderId}&status=in.(quoted,awaiting_pickup)`, {
      method: 'PATCH',
      prefer: 'return=representation',
      body: {
        status: pickup ? 'picked_up' : 'shipped',
        tracking_code: tracking || null,
        shipped_at: shippedAt.toISOString(),
        marked_by: guard.config.email,
        updated_at: new Date().toISOString()
      }
    });
    if (!updated || !updated.length) return adminJson(409, { error: 'Este pedido já foi marcado como enviado ou retirado.' });

    await sb(`orders?id=eq.${orderId}&status=eq.paid`, { method: 'PATCH', body: { status: 'shipped' } });

    const [after] = await loadOrders({ orderId });
    return adminJson(200, { ok: true, order: detailItem(after) });
  } catch (err) {
    console.error('adminMarkShipped failed:', safeError(err), 'pedido', orderId);
    return adminJson(500, { error: 'Não foi possível registrar o envio.' });
  }
};
