/* Cotação de frete no Melhor Envio.
   Docs: https://docs.menv.io/ — POST /api/v2/me/shipment/calculate */

const ME_BASE_URL =
  process.env.MELHOR_ENVIO_ENV === 'sandbox'
    ? 'https://sandbox.melhorenvio.com.br'
    : 'https://www.melhorenvio.com.br';

// Serviços oferecidos ao comprador (ids do Melhor Envio). MELHOR_ENVIO_SERVICES permite trocar sem deploy de código.
// 1 Correios PAC · 2 Correios SEDEX · 3 Jadlog .Package
const DEFAULT_SERVICES = '1,2,3';

function allowedServices() {
  return (process.env.MELHOR_ENVIO_SERVICES || DEFAULT_SERVICES)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Erro com mensagem segura para exibir ao comprador
class ShippingError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function normalizeCep(cep) {
  const digits = String(cep || '').replace(/\D/g, '');
  return digits.length === 8 ? digits : null;
}

async function quoteShipping(destinationCep, quantity, book) {
  const token = process.env.MELHOR_ENVIO_TOKEN;
  const originCep = normalizeCep(process.env.ORIGIN_CEP);
  if (!token || !originCep) throw new ShippingError('Cálculo de frete ainda não configurado.', 503);

  const payload = {
    from: { postal_code: originCep },
    to: { postal_code: destinationCep },
    products: [
      {
        id: book.productId,
        width: book.widthCm,
        height: book.heightCm,
        length: book.lengthCm,
        weight: book.weightGrams / 1000, // kg
        insurance_value: book.priceCents / 100, // valor declarado por exemplar
        quantity
      }
    ],
    options: { receipt: false, own_hand: false },
    services: allowedServices().join(',')
  };

  const res = await fetch(`${ME_BASE_URL}/api/v2/me/shipment/calculate`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      // O Melhor Envio exige um User-Agent identificando a aplicação e um contato
      'User-Agent': process.env.MELHOR_ENVIO_USER_AGENT || 'Site Nagila Zortea (nagilazortea.com.br)'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    console.error('Melhor Envio calculate failed:', res.status, await res.text());
    throw new ShippingError('Não foi possível calcular o frete agora. Tente novamente em instantes.', 502);
  }

  const services = await res.json();
  const allowed = new Set(allowedServices());
  return (Array.isArray(services) ? services : [])
    .filter((s) => allowed.has(String(s.id)) && !s.error && Number(s.custom_price || s.price) > 0)
    .map((s) => ({
      id: String(s.id),
      service: s.name,
      carrier: (s.company && s.company.name) || null,
      price_cents: Math.round(Number(s.custom_price || s.price) * 100),
      estimated_days: Number(s.custom_delivery_time || s.delivery_time) || null
    }))
    .sort((a, b) => a.price_cents - b.price_cents);
}

module.exports = { quoteShipping, normalizeCep, ShippingError };
