/* Cupons de desconto — tabela autoritativa no servidor.
   O navegador só envia o código; o valor do desconto é sempre calculado aqui.
   Para criar um cupom, adicione uma entrada abaixo (código em maiúsculas). */

const COUPONS = {
  '50OFF': { discountCents: 5000, description: 'R$ 50,00 de desconto no livro' }
};

function normalizeCode(code) {
  return typeof code === 'string' ? code.trim().toUpperCase().slice(0, 40) : '';
}

// Devolve { code, description, discountCents } ou null se o código não existir
function findCoupon(code) {
  const key = normalizeCode(code);
  const coupon = key && Object.prototype.hasOwnProperty.call(COUPONS, key) ? COUPONS[key] : null;
  return coupon ? { code: key, ...coupon } : null;
}

// Desconto fixo por pedido, limitado ao preço de um exemplar: o Mercado Pago não aceita
// item com valor zero ou negativo, e o desconto entra como um exemplar mais barato
function discountFor(coupon, unitPriceCents) {
  if (!coupon || !unitPriceCents) return 0;
  return Math.min(coupon.discountCents, unitPriceCents - 1);
}

module.exports = { findCoupon, discountFor };
