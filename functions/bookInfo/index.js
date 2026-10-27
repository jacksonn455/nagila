/*
 Netlify Function: bookInfo
 GET -> { title, price_cents, max_quantity, available, sold_out, low_stock, pickup }
 Usado pela página para exibir o preço configurado no servidor.
 Com BOOK_STOCK, max_quantity é o menor entre BOOK_MAX_QUANTITY e o disponível
 (o total do estoque nunca é exposto).
*/

const { json } = require('../_lib/http');
const { getBook, missingBookConfig, getPickup } = require('../_lib/book');
const { availableStock, LOW_STOCK_THRESHOLD } = require('../_lib/stock');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  const book = getBook();

  let stock = null;
  try {
    stock = await availableStock(book.stock);
  } catch (err) {
    // A página continua funcionando; o createOrder confere o estoque de novo antes de gravar
    console.error('Stock check failed:', err);
  }

  const limits = [book.maxQuantity, stock].filter((n) => n != null);
  return json(200, {
    title: book.title,
    price_cents: book.priceCents,
    max_quantity: limits.length ? Math.min(...limits) : null,
    available: missingBookConfig(book).length === 0 && stock !== 0,
    sold_out: stock === 0,
    low_stock: stock != null && stock > 0 && stock <= LOW_STOCK_THRESHOLD,
    pickup: getPickup()
  });
};
