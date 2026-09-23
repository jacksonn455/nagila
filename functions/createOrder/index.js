/*
 Netlify Function: createOrder
 - Valida o pedido e recalcula preço e frete no servidor
 - Grava cliente, pedido, item, endereço e frete escolhido no Supabase
 - Cria a preferência do Mercado Pago (Checkout Pro) e retorna o init_point
*/

const { json, readBody } = require('../_lib/http');
const { sb } = require('../_lib/supabase');
const { getBook, missingBookConfig, getPickup, PICKUP_ID } = require('../_lib/book');
const { quoteShipping, normalizeCep, ShippingError } = require('../_lib/shipping');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UFS = new Set('AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' '));

function clean(value, max = 120) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function siteUrl() {
  // URL é definida automaticamente pelo Netlify; SITE_URL permite sobrescrever
  return (process.env.SITE_URL || process.env.URL || '').replace(/\/$/, '');
}

async function createPreference(pref, idempotencyKey) {
  const res = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.MERCADOPAGO_ACCESS_TOKEN}`,
      'X-Idempotency-Key': idempotencyKey
    },
    body: JSON.stringify(pref)
  });
  if (!res.ok) {
    console.error('Mercado Pago create preference failed:', res.status, await res.text());
    return null;
  }
  return res.json();
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const p = readBody(event);
  if (!p) return json(400, { error: 'Requisição inválida.' });

  const clientToken = clean(p.client_token, 64);
  if (clientToken.length < 8) return json(400, { error: 'Requisição inválida (client_token).' });

  const name = clean(p.name);
  const email = clean(p.email, 254).toLowerCase();
  const phone = clean(p.phone, 30);
  if (!name || !EMAIL_RE.test(email)) return json(400, { error: 'Informe nome e e-mail válidos.' });

  const pickup = String(p.shipping_option_id) === PICKUP_ID ? getPickup() : null;
  if (String(p.shipping_option_id) === PICKUP_ID && !pickup) {
    return json(400, { error: 'Retirada no local indisponível.' });
  }

  // Somente os campos conhecidos do endereço são aceitos (dispensado na retirada)
  const a = p.address || {};
  const address = {
    cep: normalizeCep(a.cep),
    street: clean(a.street),
    number: clean(a.number, 20),
    complement: clean(a.complement) || null,
    neighborhood: clean(a.neighborhood),
    city: clean(a.city),
    state: clean(a.state, 2).toUpperCase(),
    country: 'BR'
  };
  if (!pickup && (!address.cep || !address.street || !address.number || !address.neighborhood || !address.city || !UFS.has(address.state))) {
    return json(400, { error: 'Endereço de entrega incompleto.' });
  }

  const book = getBook();
  const quantity = Number(p.quantity);
  if (!Number.isInteger(quantity) || quantity < 1) return json(400, { error: 'Quantidade inválida.' });
  if (book.maxQuantity && quantity > book.maxQuantity) {
    return json(400, { error: `Máximo de ${book.maxQuantity} exemplares por pedido.` });
  }

  const missing = missingBookConfig(book);
  if (missing.length) {
    console.error('Book config missing:', missing.join(', '));
    return json(503, { error: 'Venda do livro ainda não configurada.' });
  }
  if (!process.env.MERCADOPAGO_ACCESS_TOKEN) {
    console.error('MERCADOPAGO_ACCESS_TOKEN not configured');
    return json(503, { error: 'Pagamento ainda não configurado.' });
  }

  try {
    // Idempotência: o mesmo client_token devolve o mesmo pagamento
    const [existing] = await sb(`orders?client_token=eq.${encodeURIComponent(clientToken)}&select=id`);
    if (existing) {
      const [payment] = await sb(
        `payments?order_id=eq.${existing.id}&mercadopago_preference_id=not.is.null&select=raw&order=created_at.desc&limit=1`
      );
      const initPoint = payment && payment.raw && payment.raw.init_point;
      if (initPoint) return json(200, { init_point: initPoint, order_id: existing.id });
      return json(409, { error: 'Este pedido já foi registrado. Recarregue a página e tente novamente.' });
    }

    // Recalcula o frete e confere se a opção escolhida ainda existe
    let shipping = pickup;
    if (!shipping) {
      const options = await quoteShipping(address.cep, quantity, book);
      shipping = options.find((o) => o.id === String(p.shipping_option_id));
    }
    if (!shipping) {
      return json(409, { error: 'A opção de frete escolhida não está mais disponível. Calcule o frete novamente.' });
    }

    const subtotal = book.priceCents * quantity;
    const total = subtotal + shipping.price_cents;

    const [customer] = await sb('customers?on_conflict=email', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: { name, email, phone: phone || null }
    });

    const [order] = await sb('orders', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        client_token: clientToken,
        customer_id: customer.id,
        status: 'pending',
        total_cents: total,
        shipping_cents: shipping.price_cents,
        currency: 'BRL'
      }
    });

    await sb('order_items', {
      method: 'POST',
      body: {
        order_id: order.id,
        product_id: book.productId,
        quantity,
        unit_price_cents: book.priceCents,
        subtotal_cents: subtotal
      }
    });
    if (!pickup) await sb('addresses', { method: 'POST', body: { order_id: order.id, ...address } });
    // Guarda o serviço de entrega escolhido (PAC, SEDEX, retirada...) para a postagem
    await sb('shipments', {
      method: 'POST',
      body: {
        order_id: order.id,
        provider: pickup ? 'pickup' : 'melhorenvio',
        status: pickup ? 'awaiting_pickup' : 'quoted',
        raw: shipping
      }
    });

    const items = [
      {
        id: book.productId,
        title: book.title,
        quantity,
        unit_price: book.priceCents / 100,
        currency_id: 'BRL'
      }
    ];
    // O Mercado Pago não aceita item com valor zero: a retirada não gera item de frete
    if (shipping.price_cents > 0) {
      items.push({
        id: `frete-${shipping.id}`,
        title: `Frete — ${shipping.carrier ? `${shipping.carrier} ${shipping.service}` : shipping.service}`,
        quantity: 1,
        unit_price: shipping.price_cents / 100,
        currency_id: 'BRL'
      });
    }

    const base = siteUrl();
    const pref = { items, payer: { name, email }, external_reference: order.id };
    if (process.env.PAYMENT_WEBHOOK_URL) pref.notification_url = process.env.PAYMENT_WEBHOOK_URL;
    if (base) {
      const extra = pickup ? '&entrega=retirada' : '';
      pref.back_urls = {
        success: `${base}/livro.html?pagamento=aprovado${extra}#comprar`,
        pending: `${base}/livro.html?pagamento=pendente${extra}#comprar`,
        failure: `${base}/livro.html?pagamento=falhou${extra}#comprar`
      };
      pref.auto_return = 'approved';
    }

    const prefData = await createPreference(pref, order.id);
    if (!prefData) {
      await sb(`orders?id=eq.${order.id}`, { method: 'PATCH', body: { status: 'cancelled' } });
      return json(502, { error: 'Não foi possível iniciar o pagamento. Tente novamente.' });
    }

    await sb(`orders?id=eq.${order.id}`, { method: 'PATCH', body: { mercadopago_preference_id: prefData.id } });
    await sb('payments', {
      method: 'POST',
      body: {
        order_id: order.id,
        provider: 'mercadopago',
        status: 'preference_created',
        mercadopago_preference_id: prefData.id,
        amount_cents: total,
        raw: { id: prefData.id, init_point: prefData.init_point }
      }
    });

    return json(200, { init_point: prefData.init_point, order_id: order.id });
  } catch (err) {
    if (err instanceof ShippingError) return json(err.status, { error: err.message });
    console.error(err);
    return json(500, { error: 'Erro ao registrar o pedido. Tente novamente.' });
  }
};
