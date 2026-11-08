/* Avisos no Discord (canal da autora), via webhook.
   - Venda do site: DISCORD_WEBHOOK_URL (paymentWebhook)
   - Venda no Mercado Livre e alertas da integração: MERCADO_LIVRE_DISCORD_WEBHOOK_URL,
     ou DISCORD_WEBHOOK_URL quando ela não estiver configurada
   Nunca derruba quem chamou: qualquer falha só vai para o log, sem dados pessoais. */

const { sb } = require('./supabase');

const brl = (cents) =>
  (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const PAYMENT_TYPES = {
  credit_card: 'Cartão de crédito',
  debit_card: 'Cartão de débito',
  bank_transfer: 'Pix',
  ticket: 'Boleto',
  account_money: 'Saldo Mercado Pago',
};

async function loadDetails(orderId) {
  const [[order], items, addresses, shipments] = await Promise.all([
    sb(`orders?id=eq.${orderId}&select=*`),
    sb(`order_items?order_id=eq.${orderId}&select=quantity`),
    sb(`addresses?order_id=eq.${orderId}&select=city,state`),
    sb(`shipments?order_id=eq.${orderId}&select=provider,raw`),
  ]);
  const [customer] =
    order && order.customer_id ? await sb(`customers?id=eq.${order.customer_id}&select=name`) : [];
  return { order, items, address: addresses[0], shipment: shipments[0], customer };
}

function buildMessage({ order, items, address, shipment, customer }, payment) {
  const quantity = items.reduce((sum, i) => sum + Number(i.quantity || 0), 0);
  const raw = (shipment && shipment.raw) || {};
  const delivery =
    shipment && shipment.provider === 'pickup'
      ? 'Retirada no local'
      : [
          [raw.carrier, raw.service].filter(Boolean).join(' '),
          address && [address.city, address.state].filter(Boolean).join('/'),
        ]
          .filter(Boolean)
          .join(' — ') || 'Envio';
  const method = PAYMENT_TYPES[payment.payment_type_id] || payment.payment_method_id || '—';

  const fields = [
    { name: 'Cliente', value: (customer && customer.name) || '—', inline: true },
    { name: 'Exemplares', value: String(quantity || '—'), inline: true },
    { name: 'Total', value: brl(order.total_cents), inline: true },
    { name: 'Entrega', value: delivery, inline: true },
    { name: 'Pagamento', value: method, inline: true },
  ];
  if (order.coupon_code)
    fields.push({
      name: 'Cupom',
      value: `${order.coupon_code} (−${brl(order.discount_cents)})`,
      inline: true,
    });

  return {
    username: 'Venda do livro',
    embeds: [
      {
        title: '📚 Nova venda aprovada!',
        color: 0x2e7d32,
        fields,
        footer: { text: `Pedido ${order.id.slice(0, 8)}` },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

// Envia um payload ao webhook; devolve true se o Discord aceitou. Nunca lança erro.
async function postDiscord(url, payload, context = '') {
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.error('Discord webhook respondeu', res.status, context);
    return res.ok;
  } catch (err) {
    console.error('Aviso no Discord falhou:', (err && err.name) || 'erro', context);
    return false;
  }
}

async function notifySale(orderId, payment) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  try {
    const details = await loadDetails(orderId);
    if (!details.order) return;
    await postDiscord(url, buildMessage(details, payment), `pedido ${orderId}`);
  } catch (err) {
    console.error('Aviso no Discord falhou:', (err && err.name) || 'erro', 'pedido', orderId);
  }
}

/* ---------- Mercado Livre ---------- */

const marketplaceWebhookUrl = () =>
  process.env.MERCADO_LIVRE_DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL || '';

const PAYMENT_STATUS_LABELS = {
  approved: 'Aprovado',
  pending: 'Pendente',
  in_process: 'Em análise',
  rejected: 'Recusado',
  refunded: 'Estornado',
  cancelled: 'Cancelado',
};

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/* sale: { externalOrderId, packId, buyerName, items: [{ title, quantity }], totalCents,
           payment: { status, payment_type, payment_method_id } | null, shipping: string | null } */
function buildMarketplaceMessage(sale) {
  const items = (sale.items || [])
    .map((i) => `${i.quantity}× ${i.title || 'Item'}`)
    .join('\n');
  const payment = sale.payment || {};
  const paymentText = [
    PAYMENT_STATUS_LABELS[payment.status] || payment.status,
    PAYMENT_TYPES[payment.payment_type] || payment.payment_method_id,
  ]
    .filter(Boolean)
    .join(' · ');
  const fields = [
    { name: 'Canal', value: 'Mercado Livre', inline: true },
    { name: 'Pedido', value: `#${sale.externalOrderId}`, inline: true },
    { name: 'Comprador', value: sale.buyerName || '—', inline: true },
    { name: 'Itens', value: truncate(items || '—', 1000), inline: false },
    { name: 'Total', value: brl(sale.totalCents), inline: true },
    { name: 'Pagamento', value: paymentText || '—', inline: true },
  ];
  if (sale.packId) fields.push({ name: 'Carrinho (pack)', value: `#${sale.packId}`, inline: true });
  if (sale.shipping) fields.push({ name: 'Entrega', value: sale.shipping, inline: true });
  return {
    username: 'Venda no Mercado Livre',
    embeds: [
      {
        title: '🛒 Nova venda no Mercado Livre!',
        color: 0xffe600,
        fields,
        footer: { text: `Mercado Livre ${sale.externalOrderId}` },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

function notifyMarketplaceSale(sale) {
  return postDiscord(marketplaceWebhookUrl(), buildMarketplaceMessage(sale), `mercadolivre ${sale.externalOrderId}`);
}

// Alerta operacional (ex.: conta precisa ser reconectada). Sem dados do comprador.
function notifyIntegrationAlert(text) {
  return postDiscord(
    marketplaceWebhookUrl(),
    { username: 'Integração Mercado Livre', content: `⚠️ ${text}` },
    'alerta mercadolivre'
  );
}

module.exports = {
  notifySale,
  buildMessage,
  postDiscord,
  buildMarketplaceMessage,
  notifyMarketplaceSale,
  notifyIntegrationAlert,
};
