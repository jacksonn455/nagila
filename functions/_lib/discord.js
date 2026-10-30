/* Aviso de venda aprovada no Discord (canal da autora), via webhook em DISCORD_WEBHOOK_URL.
   Nunca derruba o paymentWebhook: qualquer falha só vai para o log, sem dados pessoais. */

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

async function notifySale(orderId, payment) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  try {
    const details = await loadDetails(orderId);
    if (!details.order) return;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildMessage(details, payment)),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.error('Discord webhook respondeu', res.status, 'pedido', orderId);
  } catch (err) {
    console.error('Aviso no Discord falhou:', (err && err.name) || 'erro', 'pedido', orderId);
  }
}

module.exports = { notifySale, buildMessage };
