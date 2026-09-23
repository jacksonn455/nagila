/* Frontend logic for livro.html
 - Loads the server-side price (bookInfo)
 - Handles quantity, CEP, shipping calculation (calculateShipping) and order summary
 - Creates the order (createOrder) and redirects to the Mercado Pago init_point
 - Shows the result when the buyer returns from Mercado Pago (?pagamento=...)

 NOTE: Does not contain secrets. Prices shown here are display-only — the
 server recalculates everything. In preview mode (?preview / file://) the
 checkout is simulated by book-ui.js and this file stays passive.
*/

(function () {
  'use strict';

  const API = '/.netlify/functions';

  const selectors = {
    quantity: '#quantity',
    cep: '#cep',
    calcShipping: '#calc-shipping',
    shippingOptions: '#shipping-options',
    name: '#name',
    email: '#email',
    phone: '#phone',
    street: '#street',
    number: '#number',
    complement: '#complement',
    neighborhood: '#neighborhood',
    city: '#city',
    state: '#state',
    deliveryMode: '#delivery-mode',
    deliveryShipping: '#delivery-shipping',
    deliveryAddress: '#delivery-address',
    pickupAddress: '#pickup-address',
    buy: '#buy',
    messages: '#messages',
    card: '#purchase-panel',
    result: '#checkout-result',
    summaryProduct: '#summary-product',
    summarySubtotal: '#summary-subtotal',
    summaryShipping: '#summary-shipping',
    summaryTotal: '#summary-total'
  };

  const $q = (k) => document.querySelector(selectors[k]);
  const value = (k) => ($q(k)?.value || '').trim();

  const params = new URLSearchParams(location.search);
  // Pedidos antigos voltavam com os dados do Mercado Pago depois do "#" (ex.: #comprar&external_reference=...)
  const hashQuery = location.hash.replace(/^#[^&?]*[&?]?/, '');
  if (hashQuery) new URLSearchParams(hashQuery).forEach((v, k) => !params.has(k) && params.set(k, v));
  const PREVIEW =
    params.get('preview') === '0' ? false : params.has('preview') || location.protocol === 'file:';

  const state = {
    priceCents: null,
    maxQuantity: null,
    options: [],
    pickup: null,
    clientToken: null
  };

  // UI helpers
  function setMessage(msg, type = 'info') {
    const m = $q('messages');
    m.textContent = msg;
    m.className = `message message--${type}`;
  }

  function clearMessage() {
    const m = $q('messages');
    m.textContent = '';
    m.className = '';
  }

  function formatCurrency(cents) {
    if (cents == null) return '—';
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  }

  function cepDigits() {
    return value('cep').replace(/\D/g, '');
  }

  function quantity() {
    const n = Number($q('quantity').value);
    return Number.isInteger(n) && n >= 1 ? n : null;
  }

  function newClientToken() {
    state.clientToken = crypto.randomUUID ? crypto.randomUUID() : `ct_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  async function postJson(path, body) {
    const res = await fetch(`${API}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      // resposta sem JSON (ex.: erro do servidor)
    }
    return { ok: res.ok, data };
  }

  function isPickup() {
    return !!state.pickup && document.querySelector('input[name="deliveryMode"]:checked')?.value === 'pickup';
  }

  function selectedOption() {
    if (isPickup()) return state.pickup;
    const radio = document.querySelector('input[name="shippingOption"]:checked');
    if (!radio) return null;
    return state.options.find((o) => o.id === radio.getAttribute('data-option-id')) || null;
  }

  // Na retirada no local não há CEP, frete nem endereço de entrega
  function updateDeliveryMode() {
    const pickup = isPickup();
    $q('deliveryShipping').hidden = pickup;
    $q('deliveryAddress').hidden = pickup;
    updateSummary();
  }

  function updateSummary() {
    const qty = quantity() || 1;
    const subtotal = state.priceCents != null ? state.priceCents * qty : null;
    const ship = selectedOption();
    $q('summarySubtotal').textContent = formatCurrency(subtotal);
    $q('summaryShipping').textContent = ship ? (ship.price_cents === 0 ? 'Grátis' : formatCurrency(ship.price_cents)) : '—';
    $q('summaryTotal').textContent = subtotal != null && ship ? formatCurrency(subtotal + ship.price_cents) : '—';
  }

  // Frete depende do CEP e da quantidade: qualquer mudança invalida a cotação
  function resetShipping() {
    if (!state.options.length) return;
    state.options = [];
    renderOptions(null);
    updateSummary();
  }

  // Price (server-side config)
  async function loadProduct() {
    try {
      const res = await fetch(`${API}/bookInfo`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.price_cents == null) return;
      state.priceCents = data.price_cents;
      state.maxQuantity = data.max_quantity || null;
      state.pickup = data.pickup || null;
      if (state.pickup) {
        $q('pickupAddress').textContent = state.pickup.address;
        $q('deliveryMode').hidden = false;
      }
      document.querySelectorAll('[data-price-display]').forEach((el) => (el.textContent = formatCurrency(data.price_cents)));
      document.querySelectorAll('[data-price-flag]').forEach((el) => (el.hidden = true));
      if (state.maxQuantity) $q('quantity').max = state.maxQuantity;
      updateSummary();
    } catch (err) {
      console.error(err);
    }
  }

  // Shipping calculation
  // Opções cotadas; checkedId marca a opção selecionada
  function renderOptions(checkedId) {
    const options = state.options;
    if (!options.length) {
      $q('shippingOptions').innerHTML = '';
      return;
    }
    $q('shippingOptions').innerHTML = `
      <div class="shipping-options__head"><span>Opções de envio</span></div>
      ${options
        .map(
          (o) => `
        <label>
          <input type="radio" name="shippingOption" data-option-id="${escapeHtml(o.id)}" ${o.id === checkedId ? 'checked' : ''}>
          <span class="ship-opt__main">
            <span class="ship-opt__name">${escapeHtml(o.service)}${o.carrier ? ` <span class="ship-opt__eta">· ${escapeHtml(o.carrier)}</span>` : ''}</span>
            ${o.estimated_days ? `<span class="ship-opt__eta">Até ${o.estimated_days} dias úteis</span>` : ''}
          </span>
          <span class="ship-opt__price">${formatCurrency(o.price_cents)}</span>
        </label>`
        )
        .join('')}`;
  }

  async function calculateShipping() {
    clearMessage();
    const cep = cepDigits();
    const qty = quantity();
    if (cep.length !== 8) return setMessage('Informe um CEP válido.', 'error');
    if (!qty || (state.maxQuantity && qty > state.maxQuantity)) return setMessage('Quantidade inválida.', 'error');

    const btn = $q('calcShipping');
    btn.disabled = true;
    state.options = [];
    $q('shippingOptions').innerHTML =
      '<p class="ship-loading"><span class="spinner" aria-hidden="true"></span> Calculando opções de envio...</p>';
    updateSummary();

    try {
      const { ok, data } = await postJson('calculateShipping', { cep, quantity: qty });
      if (!ok || !data || !Array.isArray(data.options) || !data.options.length) {
        renderOptions(null);
        return setMessage((data && data.error) || 'Erro ao calcular o frete. Tente novamente.', 'error');
      }
      state.options = data.options;
      renderOptions(data.options[0].id);
      updateSummary();
      setMessage('Frete calculado. Preencha seus dados para prosseguir.', 'success');
    } catch (err) {
      console.error(err);
      renderOptions(null);
      setMessage('Erro ao calcular o frete. Verifique sua conexão e tente novamente.', 'error');
    } finally {
      btn.disabled = false;
    }
  }

  async function createOrderAndPay() {
    clearMessage();
    const qty = quantity();
    const ship = selectedOption();
    const address = {
      cep: cepDigits(),
      street: value('street'),
      number: value('number'),
      complement: value('complement'),
      neighborhood: value('neighborhood'),
      city: value('city'),
      state: value('state')
    };

    const pickup = isPickup();

    if (!value('name') || !value('email') || (!pickup && address.cep.length !== 8)) {
      return setMessage(pickup ? 'Preencha nome e email.' : 'Preencha nome, email e CEP.', 'error');
    }
    if (!qty) return setMessage('Quantidade inválida.', 'error');
    if (!ship) return setMessage('Calcule o frete e escolha uma opção de envio.', 'error');
    if (!pickup && (!address.street || !address.number || !address.neighborhood || !address.city || !address.state)) {
      return setMessage('Preencha o endereço de entrega completo.', 'error');
    }

    const buy = $q('buy');
    buy.disabled = true;
    setMessage('Criando pedido...', 'info');
    if (!state.clientToken) newClientToken();

    try {
      const { ok, data } = await postJson('createOrder', {
        client_token: state.clientToken,
        name: value('name'),
        email: value('email'),
        phone: value('phone'),
        quantity: qty,
        address: pickup ? {} : address,
        shipping_option_id: ship.id
      });

      if (ok && data && data.init_point) {
        setMessage('Redirecionando para o Mercado Pago...', 'info');
        window.location.href = data.init_point;
        return;
      }
      // Um novo token permite tentar de novo após corrigir os dados
      newClientToken();
      setMessage((data && data.error) || 'Erro ao criar pedido.', 'error');
    } catch (err) {
      console.error(err);
      setMessage('Erro ao criar pedido.', 'error');
    }
    buy.disabled = false;
  }

  // Return from Mercado Pago (back_urls)
  const RETURN_STATES = {
    aprovado: {
      error: false,
      label: 'Pagamento aprovado',
      title: 'Pedido recebido!',
      lead: 'Obrigada pela compra! Você vai receber a confirmação do Mercado Pago no seu e-mail. Assim que o exemplar for postado, enviaremos o código de rastreio.',
      pickupLead: 'Obrigada pela compra! Você vai receber a confirmação do Mercado Pago no seu e-mail. Combine a retirada do seu exemplar pelo WhatsApp da clínica.'
    },
    pendente: {
      error: false,
      label: 'Pagamento em análise',
      title: 'Aguardando pagamento',
      lead: 'Seu pedido foi registrado. Se você escolheu Pix ou boleto, conclua o pagamento — assim que ele for confirmado, o exemplar será separado para envio. Esta página se atualiza sozinha quando o pagamento for confirmado.',
      pickupLead: 'Seu pedido foi registrado. Se você escolheu Pix ou boleto, conclua o pagamento — assim que ele for confirmado, combine a retirada pelo WhatsApp da clínica. Esta página se atualiza sozinha quando o pagamento for confirmado.'
    },
    falhou: {
      error: true,
      title: 'O pagamento não foi concluído.',
      lead: 'Nenhuma cobrança foi feita. Você pode tentar novamente com outro meio de pagamento.'
    }
  };

  // O Mercado Pago pode devolver o comprador como "pendente" (ex.: Pix) antes de confirmar
  // o pagamento. Consulta o status real do pedido e atualiza a tela quando ele mudar.
  const STATUS_TO_RETURN = { paid: 'aprovado', failed: 'falhou', cancelled: 'falhou' };
  const POLL_INTERVAL_MS = 5000;
  const POLL_MAX_TRIES = 36; // ~3 minutos

  async function fetchOrderStatus() {
    const orderId = params.get('external_reference');
    if (!orderId) return null;
    const qs = new URLSearchParams({ order_id: orderId });
    const paymentId = params.get('payment_id') || params.get('collection_id');
    if (paymentId && paymentId !== 'null') qs.set('payment_id', paymentId);
    try {
      const res = await fetch(`${API}/orderStatus?${qs}`);
      if (!res.ok) return null;
      const data = await res.json();
      return data.status || null;
    } catch {
      return null;
    }
  }

  // Só "pendente" fica consultando; "aprovado"/"falhou" conferem uma vez
  async function watchReturnState(key) {
    if (!params.get('external_reference')) return;
    for (let i = 0; i < POLL_MAX_TRIES; i++) {
      if ($q('card').dataset.state === 'initial') return; // comprador clicou em "Tentar novamente"
      const next = STATUS_TO_RETURN[await fetchOrderStatus()];
      if (next) {
        if (next !== key) renderReturnState(next);
        return;
      }
      if (key !== 'pendente') return;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  function showReturnState() {
    const key = params.get('pagamento');
    if (!RETURN_STATES[key]) return;
    renderReturnState(key);
    watchReturnState(key);
  }

  function renderReturnState(key) {
    const info = RETURN_STATES[key];
    const pickup = params.get('entrega') === 'retirada';

    const card = $q('card');
    const result = $q('result');
    const icon = info.error
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';

    result.innerHTML = `
      <div class="checkout-result${info.error ? ' checkout-result--error' : ''}"${info.error ? ' role="alert"' : ''}>
        <span class="checkout-result__icon">${icon}</span>
        ${info.label ? `<span class="section__label" style="margin:0">${info.label}</span>` : ''}
        <h3 class="checkout-result__title" tabindex="-1">${info.title}</h3>
        <p class="checkout-result__lead">${(pickup && info.pickupLead) || info.lead}</p>
        <div class="checkout-result__actions">
          ${info.error ? '<button type="button" class="btn btn--primary" data-checkout-retry>Tentar novamente</button>' : '<a href="/" class="btn btn--ghost">Voltar ao site</a>'}
        </div>
        <a class="checkout-result__link" href="https://wa.me/5554996516136" target="_blank" rel="noopener noreferrer">${pickup && !info.error ? 'Combinar retirada pelo WhatsApp' : 'Dúvidas? Fale pelo WhatsApp'}</a>
      </div>`;
    result.hidden = false;
    card.dataset.state = info.error ? 'error' : 'success';

    result.querySelector('[data-checkout-retry]')?.addEventListener('click', () => {
      result.hidden = true;
      result.innerHTML = '';
      card.dataset.state = 'initial';
      history.replaceState(null, '', `${location.pathname}#comprar`);
    });

    document.getElementById('comprar')?.scrollIntoView({ block: 'start' });
    result.querySelector('.checkout-result__title')?.focus({ preventScroll: true });
  }

  // Bind events
  document.addEventListener('DOMContentLoaded', () => {
    // Gallery thumbnail behavior (visual only)
    document.querySelectorAll('.thumb').forEach((t) =>
      t.addEventListener('click', () => {
        const src = t.getAttribute('data-src');
        const main = document.getElementById('main-image');
        if (main && src) main.src = src;
      })
    );

    // quantity controls
    const q = $q('quantity');
    document.getElementById('qty-decrease')?.addEventListener('click', (e) => {
      e.preventDefault();
      q.value = Math.max(1, (Number(q.value) || 1) - 1);
      q.dispatchEvent(new Event('change'));
    });
    document.getElementById('qty-increase')?.addEventListener('click', (e) => {
      e.preventDefault();
      const next = (Number(q.value) || 0) + 1;
      q.value = state.maxQuantity ? Math.min(state.maxQuantity, next) : next;
      q.dispatchEvent(new Event('change'));
    });

    // Preview: book-ui.js simula o checkout; nada é enviado ao servidor
    if (PREVIEW) return;

    $q('calcShipping').addEventListener('click', (e) => {
      e.preventDefault();
      calculateShipping();
    });
    $q('buy').addEventListener('click', (e) => {
      e.preventDefault();
      createOrderAndPay();
    });
    $q('cep').addEventListener('input', resetShipping);
    q.addEventListener('change', () => {
      resetShipping();
      updateSummary();
    });
    $q('shippingOptions').addEventListener('change', updateSummary);
    $q('deliveryMode').addEventListener('change', () => {
      clearMessage();
      updateDeliveryMode();
    });

    loadProduct();
    showReturnState();
  });
})();
