/*
 Netlify Function: validateCoupon
 POST { code } -> { code, description, discount_cents }
 Usado pela página para mostrar o desconto no resumo. O createOrder valida o cupom de novo.
*/

const { json, readBody } = require('../_lib/http');
const { getBook } = require('../_lib/book');
const { findCoupon, discountFor } = require('../_lib/coupons');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const p = readBody(event);
  if (!p) return json(400, { error: 'Requisição inválida.' });

  const coupon = findCoupon(p.code);
  if (!coupon) return json(404, { error: 'Cupom inválido.' });

  const book = getBook();
  if (!book.priceCents) return json(503, { error: 'Venda do livro ainda não configurada.' });

  return json(200, {
    code: coupon.code,
    description: coupon.description,
    discount_cents: discountFor(coupon, book.priceCents)
  });
};
