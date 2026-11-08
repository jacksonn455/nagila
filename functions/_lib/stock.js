/* Estoque do livro (opcional, BOOK_STOCK).
   Disponível = estoque − exemplares de pedidos pagos/enviados
              − exemplares de pedidos pendentes criados nas últimas 48 h.
   Pendentes mais antigos (Pix/boleto abandonados) deixam de segurar estoque.

   Canais: conta só os itens do livro do site (product_id 'book-nagila-zortea').
   Vendas do Mercado Livre só entram quando o anúncio está listado em
   MERCADO_LIVRE_BOOK_ITEM_IDS (ex.: "MLB123456789,MLB987654321:111222333" — anúncio ou
   anúncio:variação). Vazio = estoque do site separado do Mercado Livre (comportamento
   anterior à integração). Listado = os dois canais dividem o mesmo BOOK_STOCK. */

const { sb } = require('./supabase');
const { getBook } = require('./book');

const ITEM_ID_RE = /^[A-Z]{3}\d{1,20}(:\d{1,20})?$/;

// product_ids que consomem o BOOK_STOCK
function stockProductIds() {
  const shared = (process.env.MERCADO_LIVRE_BOOK_ITEM_IDS || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => ITEM_ID_RE.test(s));
  return [getBook().productId, ...new Set(shared)];
}

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
  const products = `product_id=in.(${stockProductIds().join(',')})`;
  const [sold, held] = await Promise.all([
    sb(`order_items?select=quantity,orders!inner(status)&orders.status=in.(paid,shipped)&${products}`),
    sb(
      `order_items?select=quantity,orders!inner(status,created_at)&orders.status=eq.pending&orders.created_at=gte.${encodeURIComponent(since)}&${products}`
    )
  ]);
  return Math.max(0, stock - sumQuantity(sold) - sumQuantity(held));
}

function stockMessage(available) {
  if (available <= 0) return 'Livro esgotado no momento.';
  if (available === 1) return 'Resta apenas 1 exemplar.';
  return `Restam apenas ${available} exemplares.`;
}

module.exports = { availableStock, stockMessage, stockProductIds, PENDING_HOLD_HOURS, LOW_STOCK_THRESHOLD };
