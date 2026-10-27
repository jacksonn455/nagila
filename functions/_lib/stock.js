/* Estoque do livro (opcional, BOOK_STOCK).
   Disponível = estoque − exemplares de pedidos pagos/enviados
              − exemplares de pedidos pendentes criados nas últimas 48 h.
   Pendentes mais antigos (Pix/boleto abandonados) deixam de segurar estoque. */

const { sb } = require('./supabase');

const PENDING_HOLD_HOURS = 48;
// Abaixo disso a página mostra "Últimos exemplares" (sem revelar o total)
const LOW_STOCK_THRESHOLD = 5;

function sumQuantity(rows) {
  return (rows || []).reduce((total, row) => total + (Number(row.quantity) || 0), 0);
}

// null = sem controle de estoque (BOOK_STOCK não definido)
async function availableStock(stock, now = Date.now()) {
  if (stock == null) return null;
  const since = new Date(now - PENDING_HOLD_HOURS * 3600 * 1000).toISOString();
  const [sold, held] = await Promise.all([
    sb('order_items?select=quantity,orders!inner(status)&orders.status=in.(paid,shipped)'),
    sb(
      `order_items?select=quantity,orders!inner(status,created_at)&orders.status=eq.pending&orders.created_at=gte.${encodeURIComponent(since)}`
    )
  ]);
  return Math.max(0, stock - sumQuantity(sold) - sumQuantity(held));
}

function stockMessage(available) {
  if (available <= 0) return 'Livro esgotado no momento.';
  if (available === 1) return 'Resta apenas 1 exemplar.';
  return `Restam apenas ${available} exemplares.`;
}

module.exports = { availableStock, stockMessage, PENDING_HOLD_HOURS, LOW_STOCK_THRESHOLD };
