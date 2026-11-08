/* Mercado Livre: fila de notificações (processed_notifications) e sincronização de pedidos.

 Fluxo: mercadoLivreWebhook grava a notificação (status pending) e responde 200;
 processPending() — chamado pela Background Function e pela Scheduled Function — pega
 as pendentes, busca o recurso na API do Mercado Livre (fonte da verdade, nunca o corpo
 da notificação) e faz upsert em orders / order_items / payments / shipments.

 Idempotência:
 - notificação: unique (provider, provider_notification_id) + "claim" por PATCH condicional
 - pedido: unique (channel, external_order_id); itens: unique (order_id, product_id);
   pagamentos: unique mercadopago_payment_id; envio: unique (provider, external_shipment_id)
 - status: PATCH condicional pelo status atual; só quem faz a transição avisa no Discord
*/

const { sb } = require('./supabase');
const ml = require('./mercadoLivre');
const { notifyMarketplaceSale, notifyIntegrationAlert } = require('./discord');

const CHANNEL = 'mercadolivre';
const TOPICS = ['orders_v2', 'shipments'];
const MAX_ATTEMPTS = 8;
const STUCK_AFTER_MS = 10 * 60 * 1000;
const REAUTH_RETRY_MS = 30 * 60 * 1000;

/* ---------- validação do recurso ---------- */

const RESOURCE_RE = {
  orders_v2: /^\/orders\/(\d{1,20})$/,
  shipments: /^\/(?:marketplace\/)?shipments\/(\d{1,20})$/
};

// Devolve o id numérico do recurso ou null (caminho fora do formato esperado)
function parseResource(topic, resource) {
  const re = RESOURCE_RE[topic];
  if (!re || typeof resource !== 'string' || resource.length > 100) return null;
  const m = resource.match(re);
  return m ? m[1] : null;
}

/* ---------- mapeamento de status ----------

 orders.status aceita só: pending, paid, failed, cancelled, shipped (CHECK do schema v2).

 Status do pedido no Mercado Livre -> status interno:
 - paid, partially_refunded            -> paid      (estorno parcial fica registrado em payments)
 - confirmed, payment_required,
   payment_in_process, partially_paid  -> pending
 - cancelled, invalid                  -> cancelled
 - pending_cancel e desconhecidos      -> (sem mudança)
 Envio (shipments.status) shipped/delivered em pedido pago -> shipped.
 "failed" não é usado: o Mercado Livre não tem pagamento recusado no pedido em si
 (recusas aparecem em payments e o pedido segue payment_required até cancelar).
*/
const ORDER_STATUS_MAP = {
  paid: 'paid',
  partially_refunded: 'paid',
  confirmed: 'pending',
  payment_required: 'pending',
  payment_in_process: 'pending',
  partially_paid: 'pending',
  cancelled: 'cancelled',
  invalid: 'cancelled'
};

const SHIPPED_STATUSES = ['shipped', 'delivered'];

// Transições permitidas (mesma ideia do paymentWebhook: nunca regride, shipped é final)
const TRANSITIONS = {
  pending: ['paid', 'cancelled'],
  failed: ['paid', 'pending', 'cancelled'],
  paid: ['shipped', 'cancelled'],
  cancelled: [],
  shipped: []
};

function targetStatus(mlOrder, shipment) {
  const mapped = ORDER_STATUS_MAP[mlOrder && mlOrder.status] || null;
  if (mapped === 'paid' && shipment && SHIPPED_STATUSES.includes(shipment.status)) return 'shipped';
  return mapped;
}

// Caminho de transições do status atual até o alvo (pending -> shipped passa por paid)
function transitionPath(current, target) {
  if (!target || current === target) return [];
  if ((TRANSITIONS[current] || []).includes(target)) return [target];
  if (target === 'shipped' && (TRANSITIONS[current] || []).includes('paid')) return ['paid', 'shipped'];
  return [];
}

/* ---------- conversões ---------- */

const cents = (value) => Math.round(Number(value || 0) * 100);

function productId(item) {
  const id = String((item && item.id) || 'desconhecido').slice(0, 60);
  return item && item.variation_id ? `${id}:${item.variation_id}` : id;
}

function buyerName(buyer) {
  if (!buyer) return null;
  const full = [buyer.first_name, buyer.last_name].filter(Boolean).join(' ').trim();
  return full || buyer.nickname || null;
}

// Só o necessário para o painel e o Discord (sem documento, e-mail, telefone ou endereço)
function externalData(mlOrder) {
  const buyer = mlOrder.buyer || {};
  return {
    status: mlOrder.status || null,
    status_detail: mlOrder.status_detail || null,
    tags: Array.isArray(mlOrder.tags) ? mlOrder.tags.slice(0, 20) : [],
    date_closed: mlOrder.date_closed || null,
    buyer: { id: buyer.id != null ? String(buyer.id) : null, nickname: buyer.nickname || null, name: buyerName(buyer) },
    seller_id: mlOrder.seller && mlOrder.seller.id != null ? String(mlOrder.seller.id) : null
  };
}

function paymentRaw(p) {
  const keep = [
    'id', 'order_id', 'status', 'status_detail', 'payment_type', 'payment_method_id', 'transaction_amount',
    'total_paid_amount', 'shipping_cost', 'installments', 'currency_id', 'date_approved', 'date_created', 'date_last_modified'
  ];
  return Object.fromEntries(keep.filter((k) => p[k] !== undefined).map((k) => [k, p[k]]));
}

function shipmentRaw(s) {
  const address = s.receiver_address || s.destination?.shipping_address || {};
  return {
    status: s.status || null,
    substatus: s.substatus || null,
    mode: s.mode || null,
    logistic_type: s.logistic_type || s.logistic?.type || null,
    tracking_method: s.tracking_method || null,
    service: s.shipping_option?.name || null,
    // só cidade/UF, para o painel
    city: address.city?.name || null,
    state: address.state?.id ? String(address.state.id).replace(/^BR-/, '') : address.state?.name || null
  };
}

const LOGISTIC_LABELS = {
  fulfillment: 'Mercado Envios Full',
  self_service: 'Mercado Envios Flex',
  cross_docking: 'Mercado Envios (coleta)',
  xd_drop_off: 'Mercado Envios (agência)',
  drop_off: 'Mercado Envios (agência)'
};

function shippingLabel(raw) {
  if (!raw) return null;
  const base = LOGISTIC_LABELS[raw.logistic_type] || (raw.mode === 'me2' ? 'Mercado Envios' : raw.mode === 'custom' ? 'Envio próprio' : 'Mercado Livre');
  const where = [raw.city, raw.state].filter(Boolean).join('/');
  return where ? `${base} — ${where}` : base;
}

/* ---------- sincronização de um pedido ---------- */

async function findOrder(externalOrderId) {
  const [row] = await sb(
    `orders?channel=eq.${CHANNEL}&external_order_id=eq.${encodeURIComponent(externalOrderId)}&select=id,status`
  );
  return row || null;
}

async function upsertOrderRow(mlOrder, paidShippingCents) {
  const externalId = String(mlOrder.id);
  const fields = {
    external_pack_id: mlOrder.pack_id != null ? String(mlOrder.pack_id) : null,
    total_cents: cents(mlOrder.total_amount),
    shipping_cents: paidShippingCents,
    currency: mlOrder.currency_id || 'BRL',
    external_data: externalData(mlOrder)
  };

  let row = await findOrder(externalId);
  if (!row) {
    // Entra sempre como pending: a transição para paid é a mesma para pedido novo ou antigo
    const inserted = await sb('orders?on_conflict=channel,external_order_id', {
      method: 'POST',
      prefer: 'resolution=ignore-duplicates,return=representation',
      body: {
        channel: CHANNEL,
        external_order_id: externalId,
        status: 'pending',
        customer_id: null,
        ...(mlOrder.date_created && { created_at: mlOrder.date_created }),
        ...fields
      }
    });
    row = (inserted && inserted[0]) || (await findOrder(externalId)); // corrida: outro processo inseriu
    if (!row) throw new Error('Pedido do Mercado Livre não gravado');
  } else {
    // Atualiza só os dados descritivos; o status muda abaixo, por transição
    await sb(`orders?id=eq.${row.id}`, { method: 'PATCH', body: fields });
  }
  return row;
}

async function upsertItems(orderId, mlOrder) {
  const rows = (mlOrder.order_items || []).map((oi) => {
    const quantity = Math.max(1, Number(oi.quantity) || 1);
    const unit = cents(oi.unit_price);
    return {
      order_id: orderId,
      product_id: productId(oi.item),
      title: oi.item && oi.item.title ? String(oi.item.title).slice(0, 200) : null,
      quantity,
      unit_price_cents: unit,
      subtotal_cents: unit * quantity
    };
  });
  if (!rows.length) return;
  await sb('order_items?on_conflict=order_id,product_id', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates',
    body: rows
  });
}

async function upsertPayments(orderId, mlOrder) {
  const payments = (mlOrder.payments || []).filter((p) => p && p.id != null);
  if (!payments.length) return;
  const ids = payments.map((p) => String(p.id));
  // Nunca sobrescreve um pagamento de outro pedido (ex.: um pagamento do checkout do site)
  const existing = await sb(`payments?mercadopago_payment_id=in.(${ids.join(',')})&select=mercadopago_payment_id,order_id`);
  const foreign = new Set(existing.filter((r) => r.order_id !== orderId).map((r) => String(r.mercadopago_payment_id)));
  const rows = payments
    .filter((p) => !foreign.has(String(p.id)))
    .map((p) => ({
      order_id: orderId,
      provider: CHANNEL,
      mercadopago_payment_id: String(p.id),
      method: p.payment_method_id || p.payment_type || null,
      status: p.status || null,
      amount_cents: cents(p.total_paid_amount ?? p.transaction_amount),
      raw: paymentRaw(p),
      updated_at: new Date().toISOString()
    }));
  if (foreign.size) console.warn('Mercado Livre: pagamento já ligado a outro pedido ignorado, pedido', orderId);
  if (!rows.length) return;
  await sb('payments?on_conflict=mercadopago_payment_id', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates',
    body: rows
  });
}

async function upsertShipment(orderId, shipment) {
  if (!shipment || shipment.id == null) return null;
  const raw = shipmentRaw(shipment);
  await sb('shipments?on_conflict=provider,external_shipment_id', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates',
    body: {
      order_id: orderId,
      provider: CHANNEL,
      external_shipment_id: String(shipment.id),
      tracking_code: shipment.tracking_number || null,
      status: shipment.status || null,
      raw,
      updated_at: new Date().toISOString()
    }
  });
  return raw;
}

async function applyTransitions(row, target) {
  let current = row.status;
  const done = [];
  for (const next of transitionPath(current, target)) {
    const updated = await sb(`orders?id=eq.${row.id}&status=eq.${current}`, {
      method: 'PATCH',
      prefer: 'return=representation',
      body: { status: next }
    });
    if (!updated || !updated.length) break; // outro processo mudou o status antes
    done.push(next);
    current = next;
  }
  return done;
}

/* syncOrder: busca o pedido (e o envio) no Mercado Livre e grava tudo.
   Devolve { result: 'synced' | 'ignored', reason?, orderId?, transitions? } */
async function syncOrder(sellerId, externalOrderId, ctx = {}) {
  const token = await ml.getAccessToken(sellerId, { onReauthorization: ctx.onReauthorization });
  const mlOrder = await ml.apiGet(`/orders/${externalOrderId}`, token);
  if (!mlOrder) return { result: 'ignored', reason: 'order_not_found' };
  if (!mlOrder.seller || String(mlOrder.seller.id) !== String(sellerId)) return { result: 'ignored', reason: 'other_seller' };

  const shippingId = mlOrder.shipping && mlOrder.shipping.id;
  const shipment = shippingId ? await ml.apiGet(`/shipments/${shippingId}`, token, { 'x-format-new': 'true' }) : null;

  const paidShipping = (mlOrder.payments || [])
    .filter((p) => p.status === 'approved')
    .reduce((sum, p) => sum + cents(p.shipping_cost), 0);

  const row = await upsertOrderRow(mlOrder, paidShipping);
  await upsertItems(row.id, mlOrder);
  await upsertPayments(row.id, mlOrder);
  const shipRaw = await upsertShipment(row.id, shipment);

  const transitions = await applyTransitions(row, targetStatus(mlOrder, shipment));

  // Só o processo que levou o pedido a "paid" avisa: reprocessar não duplica o aviso
  if (transitions.includes('paid')) {
    const approved = (mlOrder.payments || []).find((p) => p.status === 'approved') || (mlOrder.payments || [])[0] || null;
    await notifyMarketplaceSale({
      externalOrderId: String(mlOrder.id),
      packId: mlOrder.pack_id != null ? String(mlOrder.pack_id) : null,
      buyerName: buyerName(mlOrder.buyer),
      items: (mlOrder.order_items || []).map((oi) => ({ title: oi.item && oi.item.title, quantity: oi.quantity })),
      totalCents: cents(mlOrder.paid_amount ?? mlOrder.total_amount),
      payment: approved,
      shipping: shippingLabel(shipRaw)
    });
  }
  return { result: 'synced', orderId: row.id, transitions };
}

/* ---------- fila ---------- */

const errorText = (err) =>
  String((err && (err.code ? `${err.name}:${err.code}` : err.message)) || 'erro')
    .replace(/:\s[\s\S]*$/, '') // corta corpo de resposta do Supabase, se houver
    .slice(0, 200);

async function finish(row, patch) {
  await sb(`processed_notifications?id=eq.${row.id}&status=eq.processing`, {
    method: 'PATCH',
    body: { locked_at: null, ...patch }
  });
}

async function handleNotification(row, ctx) {
  const payload = row.payload || {};
  const sellerId = String(payload.user_id || '');
  const resourceId = parseResource(row.topic, row.resource);
  if (!sellerId || !resourceId) return { result: 'ignored', reason: 'invalid_resource' };

  let orderId = resourceId;
  if (row.topic === 'shipments') {
    const token = await ml.getAccessToken(sellerId, { onReauthorization: ctx.onReauthorization });
    const shipment = await ml.apiGet(`/shipments/${resourceId}`, token, { 'x-format-new': 'true' });
    orderId = shipment && shipment.order_id != null ? String(shipment.order_id) : null;
    if (!orderId) return { result: 'ignored', reason: 'shipment_without_order' };
  }

  // Várias notificações do mesmo pedido no mesmo lote: busca uma vez só
  const key = `${sellerId}:${orderId}`;
  if (!ctx.synced.has(key)) ctx.synced.set(key, syncOrder(sellerId, orderId, ctx));
  return ctx.synced.get(key);
}

async function releaseStuck(now) {
  await sb(
    `processed_notifications?provider=eq.${CHANNEL}&status=eq.processing&locked_at=lt.${encodeURIComponent(new Date(now - STUCK_AFTER_MS).toISOString())}`,
    { method: 'PATCH', body: { status: 'pending', locked_at: null } }
  );
}

/* processPending({ limit, budgetMs }) -> { processed, done, ignored, retried, failed }
   Seguro para rodar em paralelo (Background + Scheduled): cada linha é "reivindicada"
   por PATCH condicional status=pending -> processing. */
async function processPending({ limit = 25, budgetMs = 20000, now = Date.now } = {}) {
  const started = now();
  const stats = { processed: 0, done: 0, ignored: 0, retried: 0, failed: 0 };
  let alerted = false;
  const ctx = {
    synced: new Map(),
    onReauthorization: async (integration) => {
      if (alerted) return;
      alerted = true;
      await notifyIntegrationAlert(
        `A conta do Mercado Livre${integration.seller_nickname ? ` (${integration.seller_nickname})` : ''} precisa ser reconectada no painel: a renovação do acesso foi recusada. As vendas novas ficam na fila até lá.`
      );
    }
  };

  await releaseStuck(started);
  const rows = await sb(
    `processed_notifications?provider=eq.${CHANNEL}&status=eq.pending&next_attempt_at=lt.${encodeURIComponent(new Date(started + 1000).toISOString())}&select=id,topic,resource,payload,attempts&order=created_at.asc&limit=${limit}`
  );

  for (const row of rows) {
    if (now() - started > budgetMs) break;
    const claimed = await sb(`processed_notifications?id=eq.${row.id}&status=eq.pending`, {
      method: 'PATCH',
      prefer: 'return=representation',
      body: { status: 'processing', locked_at: new Date(now()).toISOString(), attempts: Number(row.attempts || 0) + 1 }
    });
    if (!claimed || !claimed.length) continue; // outro processo pegou
    stats.processed += 1;
    const attempts = Number(row.attempts || 0) + 1;

    try {
      const out = await handleNotification(row, ctx);
      const ignored = out.result === 'ignored';
      await finish(row, {
        status: ignored ? 'ignored' : 'done',
        processed_at: new Date(now()).toISOString(),
        last_error: ignored ? out.reason : null
      });
      stats[ignored ? 'ignored' : 'done'] += 1;
    } catch (err) {
      const reauth = err instanceof ml.IntegrationError || err instanceof ml.ConfigError;
      // Sem conta conectada a venda não se perde: fica na fila, sem gastar tentativas
      const giveUp = !reauth && attempts >= MAX_ATTEMPTS;
      const delay = reauth ? REAUTH_RETRY_MS : Math.min(60, 2 ** attempts) * 60 * 1000;
      await finish(row, {
        status: giveUp ? 'failed' : 'pending',
        attempts: reauth ? Math.max(0, attempts - 1) : attempts,
        next_attempt_at: new Date(now() + delay).toISOString(),
        last_error: errorText(err)
      }).catch(() => {});
      console.error('Mercado Livre: notificação', row.id, giveUp ? 'falhou de vez' : 'volta para a fila', '-', errorText(err));
      stats[giveUp ? 'failed' : 'retried'] += 1;
    }
  }
  return stats;
}

module.exports = {
  CHANNEL,
  TOPICS,
  MAX_ATTEMPTS,
  ORDER_STATUS_MAP,
  TRANSITIONS,
  parseResource,
  targetStatus,
  transitionPath,
  productId,
  buyerName,
  shippingLabel,
  syncOrder,
  processPending
};
