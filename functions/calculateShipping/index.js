/*
 Netlify Function: calculateShipping
 POST { cep, quantity } -> { options: [{ id, service, carrier, price_cents, estimated_days }] }
 Peso e medidas vêm do servidor (BOOK_* env), nunca do cliente.
*/

const { json, readBody } = require('../_lib/http');
const { getBook, missingBookConfig } = require('../_lib/book');
const { quoteShipping, normalizeCep, ShippingError } = require('../_lib/shipping');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const body = readBody(event);
  if (!body) return json(400, { error: 'Requisição inválida.' });

  const cep = normalizeCep(body.cep);
  if (!cep) return json(400, { error: 'CEP inválido.' });

  const book = getBook();
  const quantity = Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity < 1) return json(400, { error: 'Quantidade inválida.' });
  if (book.maxQuantity && quantity > book.maxQuantity) {
    return json(400, { error: `Máximo de ${book.maxQuantity} exemplares por pedido.` });
  }

  const missing = missingBookConfig(book);
  if (missing.length) {
    console.error('Book config missing:', missing.join(', '));
    return json(503, { error: 'Venda do livro ainda não configurada.' });
  }

  try {
    const options = await quoteShipping(cep, quantity, book);
    if (!options.length) return json(422, { error: 'Nenhuma opção de entrega disponível para este CEP.' });
    return json(200, { options });
  } catch (err) {
    if (err instanceof ShippingError) return json(err.status, { error: err.message });
    console.error(err);
    return json(500, { error: 'Erro ao calcular o frete.' });
  }
};
