/*
 Netlify Function: bookInfo
 GET -> { title, price_cents, max_quantity, available, pickup }
 Usado pela página para exibir o preço configurado no servidor.
*/

const { json } = require('../_lib/http');
const { getBook, missingBookConfig, getPickup } = require('../_lib/book');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  const book = getBook();
  return json(200, {
    title: book.title,
    price_cents: book.priceCents,
    max_quantity: book.maxQuantity,
    available: missingBookConfig(book).length === 0,
    pickup: getPickup()
  });
};
