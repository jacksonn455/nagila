/* Pedidos para a área administrativa: leitura do Supabase, regra "Pronto para envio",
   filtros, resumo e CSV. Tudo calculado no servidor; o navegador só exibe.
   Nunca registra dados pessoais em log. */

const { sb } = require('./supabase');
const { getBook } = require('./book');
const { availableStock } = require('./stock');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UFS = new Set('AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' '));
const ROW_LIMIT = 5000; // volume de um único livro; acima disso, paginar no banco

const PAYMENT_LABELS = {
  aprovado: 'Aprovado',
  pendente: 'Pendente',
  recusado: 'Recusado',
  estornado: 'Estornado/Chargeback',
  cancelado: 'Cancelado'
};

const READINESS_LABELS = { pronto: 'Pronto para envio', nao_liberar: 'Não liberar', enviado: 'Enviado' };

const SHIPMENT_LABELS = {
  quoted: 'Não enviado',
  awaiting_pickup: 'Aguardando retirada',
  shipped: 'Enviado',
  picked_up: 'Retirado'
};

const MP_STATUS_LABELS = {
  preference_created: 'Pagamento iniciado (preferência criada)',
  approved: 'Aprovado',
  authorized: 'Autorizado',
  pending: 'Pendente',
  in_process: 'Em análise',
  in_mediation: 'Em mediação',
  rejected: 'Recusado',
  cancelled: 'Cancelado',
  refunded: 'Estornado',
  charged_back: 'Chargeback',
  amount_mismatch: 'Valor pago diferente do total'
};

// Mensagem de erro sem o corpo da resposta do Supabase (que pode conter dados)
function safeError(err) {
  return String((err && err.message) || 'erro').replace(/:\s[\s\S]*$/, '');
}

const byOrder = (rows) =>
  rows.reduce((map, row) => {
    (map[row.order_id] = map[row.order_id] || []).push(row);
    return map;
  }, {});

async function loadOrders({ orderId } = {}) {
  const filter = orderId ? `&order_id=eq.${orderId}` : '';
  const [orders, items, addresses, payments, shipments] = await Promise.all([
    sb(`orders?select=*${orderId ? `&id=eq.${orderId}` : ''}&order=created_at.desc&limit=${ROW_LIMIT}`),
    sb(`order_items?select=*${filter}&limit=${ROW_LIMIT}`),
    sb(`addresses?select=*${filter}&limit=${ROW_LIMIT}`),
    sb(`payments?select=*${filter}&order=created_at.asc&limit=${ROW_LIMIT}`),
    sb(`shipments?select=*${filter}&limit=${ROW_LIMIT}`)
  ]);
  const customerIds = [...new Set(orders.map((o) => o.customer_id).filter(Boolean))];
  const customers = customerIds.length
    ? await sb(`customers?select=id,name,email,phone&id=in.(${customerIds.join(',')})&limit=${ROW_LIMIT}`)
    : [];
  const customerById = Object.fromEntries(customers.map((c) => [c.id, c]));
  const itemsBy = byOrder(items);
  const addressesBy = byOrder(addresses);
  const paymentsBy = byOrder(payments);
  const shipmentsBy = byOrder(shipments);
  const title = getBook().title;

  return orders.map((order) =>
    buildView(order, {
      customer: customerById[order.customer_id] || null,
      items: itemsBy[order.id] || [],
      address: (addressesBy[order.id] || [])[0] || null,
      payments: paymentsBy[order.id] || [],
      shipment: (shipmentsBy[order.id] || [])[0] || null,
      title
    })
  );
}

function addressComplete(a) {
  return !!(
    a &&
    /^\d{8}$/.test(String(a.cep || '')) &&
    String(a.street || '').trim() &&
    String(a.number || '').trim() &&
    String(a.neighborhood || '').trim() &&
    String(a.city || '').trim() &&
    UFS.has(String(a.state || '').toUpperCase())
  );
}

function paymentStatus(order, payments) {
  if (payments.some((p) => p.status === 'refunded' || p.status === 'charged_back')) return 'estornado';
  if (order.status === 'paid' || order.status === 'shipped') return 'aprovado';
  if (order.status === 'failed') return 'recusado';
  if (order.status === 'cancelled') return 'cancelado';
  return 'pendente';
}

/* Regra "Pronto para envio": todas as condições precisam ser verdadeiras.
   Devolve { state: 'pronto' | 'nao_liberar' | 'enviado', reasons: [...] } */
function readiness(order, { payments, address, shipment, payStatus }) {
  const reasons = [];
  const add = (r) => !reasons.includes(r) && reasons.push(r);
  const pickup = shipment && shipment.provider === 'pickup';

  const alreadyDone = order.status === 'shipped' || (shipment && (shipment.status === 'shipped' || shipment.status === 'picked_up'));
  if (alreadyDone) {
    if (payStatus === 'estornado') add('Pagamento estornado depois do envio');
    return { state: 'enviado', reasons };
  }

  if (payStatus === 'pendente') add('Pagamento pendente');
  if (payStatus === 'recusado') add('Pagamento recusado');
  if (payStatus === 'cancelado') add('Pedido cancelado');
  if (payStatus === 'estornado') add('Pagamento estornado');

  const approved = payments.filter((p) => p.mercadopago_payment_id && p.status === 'approved');
  if (order.status === 'paid' && !approved.length) add('Pagamento aprovado não encontrado');
  if (approved.some((p) => Number(p.amount_cents) !== Number(order.total_cents))) add('Valor pago diferente do total');
  if (payments.some((p) => p.status === 'amount_mismatch')) add('Valor pago diferente do total');

  if (!shipment) add('Forma de entrega não registrada');
  else if (!pickup && !addressComplete(address)) add('Endereço incompleto');

  return { state: reasons.length ? 'nao_liberar' : 'pronto', reasons };
}

function deliveryLabel(shipment) {
  if (!shipment) return '—';
  if (shipment.provider === 'pickup') return 'Retirada no local';
  const raw = shipment.raw || {};
  return [raw.carrier, raw.service].filter(Boolean).join(' ') || 'Frete';
}

function buildView(order, { customer, items, address, payments, shipment, title }) {
  const payStatus = paymentStatus(order, payments);
  const ready = readiness(order, { payments, address, shipment, payStatus });
  const pickup = !!shipment && shipment.provider === 'pickup';
  const doneLabel = ready.state === 'enviado' ? (pickup ? 'Retirado' : 'Enviado') : READINESS_LABELS[ready.state];
  return {
    id: order.id,
    short_id: order.id.slice(0, 8).toUpperCase(),
    created_at: order.created_at,
    customer: { name: customer?.name || '', email: customer?.email || '', phone: customer?.phone || '' },
    quantity: items.reduce((n, i) => n + (Number(i.quantity) || 0), 0),
    total_cents: Number(order.total_cents) || 0,
    shipping_cents: Number(order.shipping_cents) || 0,
    order_status: order.status,
    delivery: { type: pickup ? 'retirada' : 'frete', label: deliveryLabel(shipment) },
    payment: { status: payStatus, label: PAYMENT_LABELS[payStatus] },
    readiness: { state: ready.state, label: doneLabel, reasons: ready.reasons },
    shipment: shipment
      ? {
          status: shipment.status,
          label: SHIPMENT_LABELS[shipment.status] || '—',
          tracking_code: shipment.tracking_code || null,
          shipped_at: shipment.shipped_at || null,
          marked_by: shipment.marked_by || null
        }
      : null,
    // Só no detalhe:
    _detail: {
      address: pickup ? null : address && {
        cep: address.cep,
        street: address.street,
        number: address.number,
        complement: address.complement,
        neighborhood: address.neighborhood,
        city: address.city,
        state: address.state
      },
      items: items.map((i) => ({
        title: i.product_id === 'book-nagila-zortea' && title ? title : i.product_id,
        quantity: Number(i.quantity) || 0,
        unit_price_cents: Number(i.unit_price_cents) || 0,
        subtotal_cents: Number(i.subtotal_cents) || 0
      })),
      payments: payments.map((p) => ({
        status: p.status,
        label: MP_STATUS_LABELS[p.status] || p.status || '—',
        mercadopago_payment_id: p.mercadopago_payment_id || null,
        method: p.method || null,
        amount_cents: p.amount_cents == null ? null : Number(p.amount_cents),
        date: (p.raw && (p.raw.date_approved || p.raw.date_created)) || p.updated_at || p.created_at || null
      }))
    }
  };
}

function listItem(view) {
  const { _detail, ...rest } = view;
  return rest;
}

function detailItem(view) {
  const { _detail, ...rest } = view;
  return { ...rest, ..._detail };
}

/* ---------- filtros ---------- */

const FILTERS = {
  status: Object.keys(PAYMENT_LABELS),
  situacao: Object.keys(READINESS_LABELS),
  entrega: ['frete', 'retirada']
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Valida os parâmetros; devolve { ok, params } ou { ok: false }
function parseQuery(q = {}) {
  const params = { page: 1, pageSize: 20 };
  for (const key of ['status', 'situacao', 'entrega']) {
    if (q[key] == null || q[key] === '') continue;
    if (!FILTERS[key].includes(q[key])) return { ok: false };
    params[key] = q[key];
  }
  for (const key of ['de', 'ate']) {
    if (q[key] == null || q[key] === '') continue;
    if (!DATE_RE.test(q[key]) || Number.isNaN(Date.parse(`${q[key]}T00:00:00-03:00`))) return { ok: false };
    params[key] = q[key];
  }
  if (q.q != null && q.q !== '') {
    if (typeof q.q !== 'string' || q.q.length > 100) return { ok: false };
    params.q = q.q.trim().toLowerCase();
  }
  if (q.page != null && q.page !== '') {
    const page = Number(q.page);
    if (!Number.isInteger(page) || page < 1 || page > 10000) return { ok: false };
    params.page = page;
  }
  if (q.page_size != null && q.page_size !== '') {
    const size = Number(q.page_size);
    if (!Number.isInteger(size) || size < 1 || size > 100) return { ok: false };
    params.pageSize = size;
  }
  if (q.id != null && q.id !== '') {
    if (!UUID_RE.test(q.id)) return { ok: false };
    params.id = q.id.toLowerCase();
  }
  return { ok: true, params };
}

function applyFilters(views, p) {
  // Datas no fuso de Brasília (UTC−3, sem horário de verão desde 2019)
  const from = p.de ? Date.parse(`${p.de}T00:00:00-03:00`) : null;
  const to = p.ate ? Date.parse(`${p.ate}T23:59:59.999-03:00`) : null;
  return views.filter((v) => {
    if (p.status && v.payment.status !== p.status) return false;
    if (p.situacao && v.readiness.state !== p.situacao) return false;
    if (p.entrega && v.delivery.type !== p.entrega) return false;
    const t = Date.parse(v.created_at);
    if (from != null && !(t >= from)) return false;
    if (to != null && !(t <= to)) return false;
    if (p.q) {
      const haystack = [v.customer.name, v.customer.email, v.id, v.short_id].join(' ').toLowerCase();
      if (!haystack.includes(p.q)) return false;
    }
    return true;
  });
}

async function summarize(views) {
  const count = (fn) => views.filter(fn).length;
  const summary = {
    total: views.length,
    prontos: count((v) => v.readiness.state === 'pronto'),
    pendentes: count((v) => v.payment.status === 'pendente'),
    recusados_cancelados_estornados: count((v) => ['recusado', 'cancelado', 'estornado'].includes(v.payment.status)),
    // pagos ainda não enviados + já enviados; estornados não contam
    exemplares_vendidos: views
      .filter((v) => v.payment.status === 'aprovado')
      .reduce((n, v) => n + v.quantity, 0)
  };
  const book = getBook();
  if (book.stock != null) summary.exemplares_restantes = await availableStock(book.stock);
  return summary;
}

/* ---------- CSV (pedidos prontos para envio por frete) ---------- */

// Neutraliza injeção de fórmula (=, +, -, @, tab, CR) e escapa aspas
function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function toCsv(views) {
  const header = ['Pedido', 'ID completo', 'Nome', 'Telefone', 'Endereço', 'Complemento', 'Bairro', 'Cidade', 'UF', 'CEP', 'Itens', 'Quantidade', 'Serviço'];
  const rows = views
    .filter((v) => v.readiness.state === 'pronto' && v.delivery.type === 'frete')
    .map((v) => {
      const d = detailItem(v);
      const a = d.address || {};
      const cep = String(a.cep || '').replace(/^(\d{5})(\d{3})$/, '$1-$2');
      return [
        v.short_id,
        v.id,
        v.customer.name,
        v.customer.phone,
        [a.street, a.number].filter(Boolean).join(', '),
        a.complement || '',
        a.neighborhood,
        a.city,
        a.state,
        cep,
        d.items.map((i) => `${i.quantity}× ${i.title}`).join(' | '),
        v.quantity,
        v.delivery.label
      ];
    });
  // BOM + ";" para o Excel em português abrir com acentos e colunas certas
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

module.exports = {
  UUID_RE,
  loadOrders,
  readiness,
  parseQuery,
  applyFilters,
  summarize,
  listItem,
  detailItem,
  toCsv,
  csvCell,
  safeError
};
