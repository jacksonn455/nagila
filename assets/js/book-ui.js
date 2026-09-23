/* ==========================================================================
   livro.html — camada de interface (somente visual)
   · Galeria (estado ativo, alt, teclado, transição)
   · Máscara de CEP, espelho do CEP no endereço, quantidade no resumo
   · CTA fixo no mobile
   · MODO PREVIEW (?preview=1 ou file://): estados do checkout com dados MOCK

   IMPORTANTE: este arquivo NÃO altera book.js nem chama APIs.
   A integração real (calculateShipping/createOrder) continua em book.js.
   No modo preview, os cliques em "Calcular frete" e "Comprar" são
   interceptados antes de chegarem ao book.js, e nada é enviado.
   ========================================================================== */

(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const brl = (cents) =>
    cents == null
      ? '—'
      : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);

  const escapeHtml = (str) =>
    String(str).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );

  /* ------------------------------------------------------------------------
     Galeria
     ------------------------------------------------------------------------ */
  function initGallery() {
    const stage = $('#gallery-main');
    const main = $('#main-image');
    const thumbs = $$('.book-gallery__thumbs .thumb');
    if (!stage || !main || !thumbs.length) return;

    function select(thumb) {
      thumbs.forEach((t) => {
        const active = t === thumb;
        t.classList.toggle('is-active', active);
        t.setAttribute('aria-pressed', String(active));
      });

      // book.js também troca o src no clique; aqui garantimos o mesmo resultado
      const src = thumb.dataset.src;
      if (src && main.getAttribute('src') !== src) main.setAttribute('src', src);
      if (thumb.dataset.alt) main.alt = thumb.dataset.alt;
      stage.dataset.fit = thumb.dataset.fit || 'object';

      if (!reducedMotion) {
        stage.classList.remove('is-swapping');
        void stage.offsetWidth; // reinicia a animação
        stage.classList.add('is-swapping');
      }
    }

    thumbs.forEach((thumb, i) => {
      thumb.addEventListener('click', () => select(thumb));
      thumb.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        const next = thumbs[(i + (e.key === 'ArrowRight' ? 1 : -1) + thumbs.length) % thumbs.length];
        next.focus();
        select(next);
      });
    });

    stage.addEventListener('animationend', () => stage.classList.remove('is-swapping'));
  }

  /* ------------------------------------------------------------------------
     Campos: CEP, quantidade, etapa atual
     ------------------------------------------------------------------------ */
  function formatCep(value) {
    const digits = value.replace(/\D/g, '').slice(0, 8);
    return digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
  }

  function initFields(onChange) {
    const cep = $('#cep');
    const mirror = $('#address-cep');
    const qty = $('#quantity');

    if (cep) {
      cep.addEventListener('input', () => {
        const formatted = formatCep(cep.value);
        if (formatted !== cep.value) cep.value = formatted;
        if (mirror) mirror.value = cep.value;
      });
    }

    if (qty) {
      const sync = () => {
        // book.js atualiza o valor no mesmo clique; lemos no próximo tick
        setTimeout(() => {
          // Só exibe — não reescreve o valor enviado pelo book.js
          const n = Math.max(1, Math.floor(Number(qty.value) || 1));
          const out = $('#summary-qty');
          if (out) out.textContent = n;
          onChange();
        }, 0);
      };
      qty.addEventListener('change', sync);
      $('#qty-decrease')?.addEventListener('click', sync);
      $('#qty-increase')?.addEventListener('click', sync);
    }

    // Destaca a etapa em que o usuário está
    $$('.buy-step').forEach((step) => {
      step.addEventListener('focusin', () => setCurrentStep(Number(step.dataset.step)));
    });

    $('#shipping-options')?.addEventListener('change', onChange);
  }

  function setCurrentStep(n) {
    $$('.buy-step').forEach((step) => {
      const s = Number(step.dataset.step);
      step.classList.toggle('is-current', s === n);
      step.classList.toggle('is-done', s < n);
    });
  }

  /* ------------------------------------------------------------------------
     CTA fixo (mobile) — visível fora do hero e fora da área de compra
     ------------------------------------------------------------------------ */
  function initSticky() {
    const bar = $('#buy-sticky');
    const hero = $('.book-hero');
    const buy = $('#comprar');
    if (!bar || !hero || !buy || !('IntersectionObserver' in window)) return;

    const link = $('a', bar);
    const seen = new Map();

    const update = () => {
      const show = seen.get(hero) === false && seen.get(buy) === false;
      bar.classList.toggle('is-visible', show);
      bar.setAttribute('aria-hidden', String(!show));
      if (link) link.tabIndex = show ? 0 : -1;
      document.body.classList.toggle('sticky-on', show);
      document.body.classList.toggle('buy-in-view', seen.get(buy) === true);
    };

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => seen.set(entry.target, entry.isIntersecting));
        update();
      },
      { threshold: 0 },
    );
    io.observe(hero);
    io.observe(buy);
  }

  /* ========================================================================
     MODO PREVIEW — somente demonstração visual
     ======================================================================== */

  const params = new URLSearchParams(location.search);
  const PREVIEW =
    params.get('preview') === '0'
      ? false
      : params.has('preview') || location.protocol === 'file:';

  /* ⚠️ DADOS DE DEMONSTRAÇÃO (MOCK) — NÃO SÃO VALORES REAIS.
     Preço, frete, prazos, número do pedido e dados do comprador existem
     apenas para visualizar a interface. Os valores reais são definidos
     no servidor (createOrder / calculateShipping). */
  const DEMO = Object.freeze({
    priceCents: 9900,
    shipping: [
      { id: 'demo_pac', service: 'PAC', carrier: 'Correios', price_cents: 1850, estimated_days: 7 },
      { id: 'demo_sedex', service: 'SEDEX', carrier: 'Correios', price_cents: 4500, estimated_days: 2 },
    ],
    orderId: 'DEMO-000123',
    buyer: {
      cep: '00000-000',
      name: 'Cliente Demonstração',
      email: 'cliente@exemplo.com',
      phone: '(00) 00000-0000',
      street: 'Rua Exemplo',
      number: '123',
      complement: '',
      neighborhood: 'Bairro Exemplo',
      city: 'Cidade Exemplo',
      state: 'RS',
    },
  });

  const ICONS = {
    check:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>',
    alert:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>',
  };

  const Preview = {
    state: 'initial',
    timer: null,

    card: null,
    result: null,
    buy: null,
    options: null,
    messages: null,

    init() {
      this.card = $('#purchase-panel');
      this.result = $('#checkout-result');
      this.buy = $('#buy');
      this.options = $('#shipping-options');
      this.messages = $('#messages');
      if (!this.card) return;

      $$('[data-preview-only]').forEach((el) => (el.hidden = false));
      document.documentElement.dataset.preview = 'true';

      // Preço demonstrativo nos pontos de exibição
      $$('[data-price-display]').forEach((el) => (el.textContent = brl(DEMO.priceCents)));
      $$('[data-price-flag]').forEach((el) => (el.textContent = 'Valor demonstrativo'));

      $$('[data-preview-state]').forEach((btn) => {
        btn.addEventListener('click', () => this.set(btn.dataset.previewState, { scroll: true }));
      });

      // Intercepta antes do book.js (fase de captura) — nenhuma chamada de API
      document.addEventListener(
        'click',
        (e) => {
          const calc = e.target.closest('#calc-shipping');
          const buy = e.target.closest('#buy');
          if (!calc && !buy) return;
          e.preventDefault();
          e.stopPropagation();
          if (calc) this.simulateShipping();
          if (buy) this.simulateOrder();
        },
        true,
      );

      this.set('initial');
    },

    /* ---------- helpers ---------- */
    qty() {
      return Math.max(1, Math.floor(Number($('#quantity')?.value) || 1));
    },

    selectedShipping() {
      const radio = $('input[name="shippingOption"]:checked');
      if (!radio) return null;
      return DEMO.shipping.find((o) => o.id === radio.dataset.optionId) || null;
    },

    totals() {
      const subtotal = DEMO.priceCents * this.qty();
      const ship = this.selectedShipping();
      return {
        subtotal,
        shipping: ship ? ship.price_cents : null,
        total: ship ? subtotal + ship.price_cents : null,
        ship,
      };
    },

    updateSummary() {
      const t = this.totals();
      const set = (id, v) => {
        const el = document.getElementById(id);
        if (el) el.textContent = v;
      };
      set('summary-qty', this.qty());
      set('summary-subtotal', brl(t.subtotal));
      set('summary-shipping', brl(t.shipping));
      set('summary-total', brl(t.total));
    },

    message(text, type = 'info') {
      if (!this.messages) return;
      this.messages.textContent = text;
      this.messages.className = text ? `message message--${type}` : '';
    },

    fillBuyer(clear = false) {
      Object.entries(DEMO.buyer).forEach(([key, value]) => {
        const el = document.getElementById(key);
        if (el) el.value = clear ? '' : value;
      });
      const mirror = $('#address-cep');
      if (mirror) mirror.value = clear ? '' : DEMO.buyer.cep;
    },

    ensureCep() {
      const cep = $('#cep');
      if (cep && !cep.value) {
        cep.value = DEMO.buyer.cep;
        const mirror = $('#address-cep');
        if (mirror) mirror.value = cep.value;
      }
    },

    renderLoading() {
      this.options.innerHTML = `
        <p class="ship-loading"><span class="spinner" aria-hidden="true"></span> Calculando opções de envio...</p>
        <div class="skeleton" aria-hidden="true"></div>
        <div class="skeleton" aria-hidden="true"></div>`;
    },

    renderOptions() {
      const current = this.selectedShipping()?.id || DEMO.shipping[0].id;
      // Mesmo contrato de markup do book.js: input[name=shippingOption][data-option-id]
      this.options.innerHTML = `
        <div class="shipping-options__head">
          <span>Opções de envio</span>
          <span class="ph">Dados de demonstração</span>
        </div>
        ${DEMO.shipping
          .map(
            (o) => `
          <label>
            <input type="radio" name="shippingOption" data-option-id="${o.id}" ${o.id === current ? 'checked' : ''}>
            <span class="ship-opt__main">
              <span class="ship-opt__name">${o.service} <span class="ship-opt__eta">· ${o.carrier}</span></span>
              <span class="ship-opt__eta">Até ${o.estimated_days} dias úteis</span>
            </span>
            <span class="ship-opt__price">${brl(o.price_cents)}</span>
          </label>`,
          )
          .join('')}`;
    },

    showResult(html) {
      this.result.innerHTML = html;
      this.result.hidden = false;
    },

    hideResult() {
      this.result.hidden = true;
      this.result.innerHTML = '';
    },

    summaryHtml() {
      const t = this.totals();
      return `
        <div class="order-summary">
          <p class="order-summary__row"><span>Produto</span> <span>${escapeHtml($('#summary-product')?.textContent || 'Livro')}</span></p>
          <p class="order-summary__row"><span>Quantidade</span> <span>${this.qty()}</span></p>
          <p class="order-summary__row"><span>Frete${t.ship ? ` · ${t.ship.service}` : ''}</span> <span>${brl(t.shipping)}</span></p>
          <p class="order-summary__row order-summary__row--total"><span>Total</span> <span>${brl(t.total)}</span></p>
        </div>`;
    },

    /* ---------- estados ---------- */
    set(state, { scroll = false } = {}) {
      clearTimeout(this.timer);
      this.state = state;
      this.card.dataset.state = state;
      this.buy.disabled = false;
      this.buy.textContent = 'Continuar para pagamento';
      this.message('');
      this.hideResult();

      $$('[data-preview-state]').forEach((b) =>
        b.setAttribute('aria-pressed', String(b.dataset.previewState === state)),
      );

      switch (state) {
        case 'initial': {
          this.buy.textContent = 'Comprar agora';
          this.options.innerHTML = '';
          this.fillBuyer(true);
          const q = $('#quantity');
          if (q) q.value = 1;
          ['summary-subtotal', 'summary-shipping', 'summary-total'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.textContent = '—';
          });
          const sq = $('#summary-qty');
          if (sq) sq.textContent = '1';
          setCurrentStep(1);
          break;
        }

        case 'loading':
          this.ensureCep();
          this.renderLoading();
          this.buy.disabled = true;
          setCurrentStep(1);
          break;

        case 'shipping':
          this.ensureCep();
          this.renderOptions();
          this.updateSummary();
          setCurrentStep(1);
          break;

        case 'form':
          this.ensureCep();
          this.renderOptions();
          this.updateSummary();
          setCurrentStep(2);
          break;

        case 'summary':
          this.fillBuyer();
          this.renderOptions();
          this.updateSummary();
          setCurrentStep(3);
          break;

        case 'processing':
          this.fillBuyer();
          this.renderOptions();
          this.updateSummary();
          setCurrentStep(3);
          this.buy.disabled = true;
          this.showResult(`
            <div class="checkout-processing">
              <span class="spinner spinner--lg" aria-hidden="true"></span>
              <p class="checkout-processing__title">Processando seu pedido…</p>
              <p class="checkout-result__lead">Estamos preparando o pagamento. Não feche esta página.</p>
            </div>`);
          this.result.setAttribute('role', 'status');
          break;

        case 'success': {
          if (!this.selectedShipping()) {
            this.fillBuyer();
            this.renderOptions();
          }
          this.updateSummary();
          const ship = this.selectedShipping() || DEMO.shipping[0];
          const email = $('#email')?.value || DEMO.buyer.email;
          this.showResult(`
            <div class="checkout-result">
              <span class="checkout-result__icon">${ICONS.check}</span>
              <span class="section__label" style="margin:0">Compra concluída</span>
              <h3 class="checkout-result__title" tabindex="-1">Pedido recebido!</h3>
              <p class="checkout-result__order">Pedido nº <strong>${DEMO.orderId}</strong> <span class="ph">Demonstração</span></p>
              <p class="checkout-result__lead">Obrigada pela compra. Os detalhes do pedido ficam associados ao e-mail <strong>${escapeHtml(email)}</strong>.</p>
              ${this.summaryHtml()}
              <p class="checkout-steps__title">Próximos passos <span class="ph">Texto a validar</span></p>
              <ol class="checkout-steps">
                <li><span><strong>Pagamento</strong> A confirmação acontece na plataforma de pagamento, logo após a conclusão.</span></li>
                <li><span><strong>Preparação</strong> Com o pagamento confirmado, o exemplar é separado para envio.</span></li>
                <li><span><strong>Envio</strong> Entrega via ${ship.service}, em até ${ship.estimated_days} dias úteis após a postagem.</span></li>
              </ol>
              <div class="checkout-result__actions">
                <a href="/" class="btn btn--ghost">Voltar ao site</a>
                <button type="button" class="btn btn--primary" data-preview-reset>Reiniciar preview</button>
              </div>
            </div>`);
          this.result.removeAttribute('role');
          $('.checkout-result__title', this.result)?.focus({ preventScroll: true });
          break;
        }

        case 'error':
          this.showResult(`
            <div class="checkout-result checkout-result--error" role="alert">
              <span class="checkout-result__icon">${ICONS.alert}</span>
              <h3 class="checkout-result__title" tabindex="-1">Não foi possível concluir o pedido.</h3>
              <p class="checkout-result__lead">Ocorreu um problema ao registrar o pedido. Seus dados continuam preenchidos — revise as informações e tente novamente.</p>
              <div class="checkout-result__actions">
                <button type="button" class="btn btn--primary" data-preview-retry>Tentar novamente</button>
              </div>
              <a class="checkout-result__link" href="https://wa.me/5554996516136" target="_blank" rel="noopener noreferrer">Precisa de ajuda? Fale pelo WhatsApp</a>
            </div>`);
          break;
      }

      $('[data-preview-reset]', this.result)?.addEventListener('click', () =>
        this.set('initial', { scroll: true }),
      );
      $('[data-preview-retry]', this.result)?.addEventListener('click', () => {
        this.set('summary', { scroll: true });
        this.buy.focus({ preventScroll: true });
      });

      if (scroll) {
        this.card.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'nearest' });
      }
    },

    /* ---------- fluxo navegável (simulado) ---------- */
    simulateShipping() {
      const cep = $('#cep');
      if (cep && cep.value.replace(/\D/g, '').length !== 8) {
        this.message('Informe um CEP válido (8 dígitos).', 'error');
        cep.setAttribute('aria-invalid', 'true');
        cep.focus();
        return;
      }
      cep?.removeAttribute('aria-invalid');
      this.set('loading');
      this.timer = setTimeout(() => this.set('shipping'), 1300);
    },

    simulateOrder() {
      if (this.buy.disabled) return;
      if (!this.selectedShipping()) {
        this.message('Calcule e escolha uma opção de frete.', 'error');
        $('#cep')?.focus();
        return;
      }
      const missing = ['name', 'email'].filter((id) => !document.getElementById(id)?.value.trim());
      if (missing.length) {
        this.message('Preencha nome e e-mail para continuar.', 'error');
        document.getElementById(missing[0])?.focus();
        return;
      }
      this.set('processing');
      this.timer = setTimeout(() => this.set('success', { scroll: true }), 1600);
    },
  };

  /* ------------------------------------------------------------------------
     Init
     ------------------------------------------------------------------------ */
  document.addEventListener('DOMContentLoaded', () => {
    initGallery();
    initFields(() => {
      if (PREVIEW && Preview.card) Preview.updateSummary();
    });
    initSticky();
    if (PREVIEW) Preview.init();
  });
})();
