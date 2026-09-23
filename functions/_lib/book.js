/* Configuração autoritativa do livro — lida das variáveis de ambiente.
   O frontend nunca envia preço, peso ou medidas. */

function positiveNumber(name) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function getBook() {
  const price = positiveNumber('BOOK_PRICE_CENTS');
  const max = positiveNumber('BOOK_MAX_QUANTITY');
  return {
    productId: 'book-nagila-zortea',
    title: (process.env.BOOK_TITLE || '').trim() || null,
    priceCents: price ? Math.round(price) : null,
    weightGrams: positiveNumber('BOOK_WEIGHT_GRAMS'),
    lengthCm: positiveNumber('BOOK_LENGTH_CM'),
    widthCm: positiveNumber('BOOK_WIDTH_CM'),
    heightCm: positiveNumber('BOOK_HEIGHT_CM'),
    maxQuantity: max ? Math.floor(max) : null
  };
}

// Lista as variáveis obrigatórias que ainda não foram preenchidas
function missingBookConfig(book) {
  const required = {
    BOOK_TITLE: book.title,
    BOOK_PRICE_CENTS: book.priceCents,
    BOOK_WEIGHT_GRAMS: book.weightGrams,
    BOOK_LENGTH_CM: book.lengthCm,
    BOOK_WIDTH_CM: book.widthCm,
    BOOK_HEIGHT_CM: book.heightCm
  };
  return Object.keys(required).filter((k) => !required[k]);
}

// Retirada no local (sem frete). PICKUP_ENABLED=false desativa.
const PICKUP_ID = 'pickup';

function getPickup() {
  if (process.env.PICKUP_ENABLED === 'false') return null;
  return {
    id: PICKUP_ID,
    service: 'Retirar no local',
    carrier: null,
    price_cents: 0,
    estimated_days: null,
    address:
      (process.env.PICKUP_ADDRESS || '').trim() ||
      'NZ Beauty Clinic — Rua Cezária Matos, 82, Centro, Erechim/RS'
  };
}

module.exports = { getBook, missingBookConfig, getPickup, PICKUP_ID };
