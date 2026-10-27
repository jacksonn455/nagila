/* Painel de pedidos. Todo dado vindo do servidor entra na página por textContent
   (função el abaixo): nada de innerHTML com dados, para evitar XSS por nome ou endereço. */
(function () {
  'use strict';

  const API = '/.netlify/functions';
  const PAGE_SIZE = 20;
  const REFRESH_MS = 60 * 1000;
  const $ = (id) => document.getElementById(id);

  const state = { page: 1, total: 0, current: null, timer: null };

  /* ---------- utilidades ---------- */

  function el(tag, { cls, text, attrs } = {}, children = []) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = String(text);
    if (attrs) Object.entries(attrs).forEach(([k, v]) => v != null && node.setAttribute(k, String(v)));
    children.filter(Boolean).forEach((c) => node.append(c));
    return node;
  }

  const money = (cents) =>
    cents == null ? '—' : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);

  const dateTime = (iso) =>
    iso
      ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso))
      : '—';

  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

  const badge = (cls, text) => el('span', { cls: `badge badge--${cls}`, text });

  function notify(message, type = 'info') {
    const n = $('notice');
    n.textContent = message;
    n.className = `admin-notice${type === 'error' ? ' admin-notice--error' : ''}`;
    n.hidden = !message;
  }

  // Sessão expirada: volta ao login guardando os filtros na URL de retorno
  function sessionExpired() {
    const next = encodeURIComponent(location.pathname + location.search);
    location.replace(`/admin/?expirada=1&next=${next}`);
  }

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(`${API}/${path}`, {
      method,
      credentials: 'same-origin',
      headers: { 'X-Admin-Request': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 401) {
      sessionExpired();
      throw new Error('sessao');
    }
    return res;
  }

  async function readJson(res) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  /* ---------- filtros na URL ---------- */

  const FILTER_KEYS = ['status', 'situacao', 'entrega', 'de', 'ate', 'q'];

  function filtersFromUrl() {
    const params = new URLSearchParams(location.search);
    const form = $('filters');
    FILTER_KEYS.forEach((k) => (form.elements[k].value = params.get(k) || ''));
    state.page = Math.max(1, Number(params.get('page')) || 1);
  }

  function currentQuery() {
    const form = $('filters');
    const params = new URLSearchParams();
    FILTER_KEYS.forEach((k) => {
      const v = form.elements[k].value.trim();
      if (v) params.set(k, v);
    });
    if (state.page > 1) params.set('page', state.page);
    return params;
  }

  /* ---------- lista ---------- */

  function renderSummary(s) {
    const items = [
      ['Pedidos', s.total],
      ['Prontos para envio', s.prontos],
      ['Pendentes', s.pendentes],
      ['Recusados, cancelados ou estornados', s.recusados_cancelados_estornados],
      ['Exemplares vendidos', s.exemplares_vendidos]
    ];
    if (s.exemplares_restantes != null) items.push(['Exemplares restantes', s.exemplares_restantes]);
    $('summary').replaceChildren(...items.map(([label, value]) => el('div', {}, [el('dt', { text: label }), el('dd', { text: value })])));
  }

  // O conteúdo vai num único bloco: no celular a célula vira grade "rótulo | conteúdo"
  function cell(label, children) {
    return el('td', { attrs: { 'data-label': label } }, [el('div', {}, children)]);
  }

  function renderRow(o) {
    const open = el('button', { cls: 'admin-btn', text: 'Detalhes', attrs: { type: 'button', 'aria-label': `Detalhes do pedido ${o.short_id}` } });
    open.addEventListener('click', () => openDetail(o.id));
    const readiness = [badge(o.readiness.state, o.readiness.label)];
    if (o.readiness.reasons.length) readiness.push(el('span', { cls: 'admin-muted', text: o.readiness.reasons.join(' · ') }));
    return el('tr', {}, [
      cell('Pedido', [el('strong', { text: o.short_id }), el('span', { cls: 'admin-muted', text: dateTime(o.created_at) })]),
      cell('Comprador', [
        el('span', { text: o.customer.name || '—' }),
        el('span', { cls: 'admin-muted', text: o.customer.email }),
        el('span', { cls: 'admin-muted', text: o.customer.phone })
      ]),
      cell('Itens', [el('span', { text: `${o.quantity} ${o.quantity === 1 ? 'exemplar' : 'exemplares'}` }), el('span', { cls: 'admin-muted', text: money(o.total_cents) })]),
      cell('Entrega', [el('span', { text: o.delivery.label })]),
      cell('Pagamento', [badge(o.payment.status, o.payment.label)]),
      cell('Situação para envio', readiness),
      cell('Envio', [el('span', { text: o.shipment ? o.shipment.label : '—' })]),
      cell('Ações', [open])
    ]);
  }

  async function load() {
    const query = currentQuery();
    history.replaceState(null, '', `${location.pathname}${query.toString() ? `?${query}` : ''}`);
    query.set('page_size', PAGE_SIZE);
    try {
      const res = await api(`adminOrders?${query}`);
      const data = await readJson(res);
      if (!res.ok || !data) return notify((data && data.error) || 'Não foi possível carregar os pedidos.', 'error');
      notify('');
      renderSummary(data.summary);
      state.total = data.total;
      const rows = data.orders.map(renderRow);
      if (!rows.length) rows.push(el('tr', {}, [el('td', { cls: 'admin-empty', text: 'Nenhum pedido encontrado.', attrs: { colspan: 8 } })]));
      $('orders').replaceChildren(...rows);
      const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
      $('page-info').textContent = `Página ${data.page} de ${pages} · ${data.total} ${data.total === 1 ? 'pedido' : 'pedidos'}`;
      $('prev').disabled = data.page <= 1;
      $('next').disabled = data.page >= pages;
    } catch (err) {
      if (err.message !== 'sessao') notify('Sem conexão com o servidor. Tente “Atualizar”.', 'error');
    }
  }

  /* ---------- detalhe ---------- */

  function section(title, children) {
    return el('section', {}, [el('h3', { text: title }), ...children]);
  }

  function addressLines(a) {
    const cep = String(a.cep || '').replace(/^(\d{5})(\d{3})$/, '$1-$2');
    return [
      [a.street, a.number].filter(Boolean).join(', ') + (a.complement ? ` — ${a.complement}` : ''),
      a.neighborhood,
      `${a.city || ''}/${a.state || ''}`,
      `CEP ${cep}`
    ].filter(Boolean);
  }

  function labelText(o) {
    return [o.customer.name, ...addressLines(o.address), o.customer.phone ? `Tel. ${o.customer.phone}` : ''].filter(Boolean).join('\n');
  }

  function renderDetail(o) {
    state.current = o;
    $('detail-title').textContent = `Pedido ${o.short_id}`;
    const pickup = o.delivery.type === 'retirada';

    const buyer = section('Comprador', [
      el('p', { text: o.customer.name || '—' }),
      el('p', { text: o.customer.email }),
      el('p', { text: o.customer.phone || 'Sem telefone' }),
      el('p', { cls: 'admin-muted', text: `Pedido feito em ${dateTime(o.created_at)} · ID ${o.id}` })
    ]);

    const deliveryChildren = [el('p', { text: o.delivery.label })];
    if (pickup) deliveryChildren.push(el('p', { text: 'Retirada no local: não há endereço de envio.' }));
    else if (o.address) {
      addressLines(o.address).forEach((line) => deliveryChildren.push(el('p', { text: line })));
      const copy = el('button', { cls: 'admin-btn', text: 'Copiar endereço de envio', attrs: { type: 'button' } });
      copy.addEventListener('click', () => copyAddress(o, copy));
      deliveryChildren.push(copy);
    } else deliveryChildren.push(el('p', { text: 'Endereço não informado.' }));
    if (o.shipment) {
      deliveryChildren.push(el('p', { cls: 'admin-muted', text: `Situação: ${o.shipment.label}` }));
      if (o.shipment.tracking_code) deliveryChildren.push(el('p', { text: `Rastreio: ${o.shipment.tracking_code}` }));
      if (o.shipment.shipped_at) {
        const who = o.shipment.marked_by ? ` por ${o.shipment.marked_by}` : '';
        deliveryChildren.push(el('p', { cls: 'admin-muted', text: `Marcado em ${dateTime(o.shipment.shipped_at)}${who}` }));
      }
    }

    const items = section('Itens e valores', [
      el('ul', {}, o.items.map((i) => el('li', { text: `${i.quantity}× ${i.title} — ${money(i.unit_price_cents)} cada (${money(i.subtotal_cents)})` }))),
      el('p', { text: `Frete: ${pickup ? 'grátis (retirada)' : money(o.shipping_cents)}` }),
      el('p', { text: `Total: ${money(o.total_cents)}` })
    ]);

    const payments = section('Pagamento', [
      badge(o.payment.status, o.payment.label),
      el(
        'ul',
        {},
        o.payments.map((p) =>
          el('li', {
            text: [
              p.label,
              p.mercadopago_payment_id ? `ID Mercado Pago ${p.mercadopago_payment_id}` : null,
              p.method,
              p.amount_cents != null ? money(p.amount_cents) : null,
              dateTime(p.date)
            ]
              .filter(Boolean)
              .join(' · ')
          })
        )
      ),
      recheckBlock(o)
    ]);

    const rule = section('Situação para envio', [
      badge(o.readiness.state, o.readiness.label),
      o.readiness.reasons.length
        ? el('ul', {}, o.readiness.reasons.map((r) => el('li', { text: r })))
        : el('p', { text: o.readiness.state === 'pronto' ? 'Todas as condições para envio foram atendidas.' : '' }),
      shipBlock(o)
    ]);

    $('detail-body').replaceChildren(buyer, section('Entrega', deliveryChildren), items, payments, rule);
  }

  function recheckBlock(o) {
    const out = el('div', { cls: 'admin-result', attrs: { 'aria-live': 'polite' } });
    out.hidden = true;
    const btn = el('button', { cls: 'admin-btn', text: 'Reverificar no Mercado Pago', attrs: { type: 'button' } });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      out.hidden = false;
      out.replaceChildren(el('p', { text: 'Consultando o Mercado Pago…' }));
      try {
        const res = await api('adminRecheckPayment', { method: 'POST', body: { order_id: o.id } });
        const data = await readJson(res);
        if (!res.ok || !data) {
          out.replaceChildren(el('p', { text: (data && data.error) || 'Não foi possível consultar.' }));
        } else if (!data.payments.length) {
          out.replaceChildren(el('p', { text: 'Nenhum pagamento encontrado no Mercado Pago para este pedido.' }));
        } else {
          out.replaceChildren(
            el(
              'ul',
              {},
              data.payments.map((p) =>
                el('li', {
                  text: `${p.label} · ID ${p.id} · ${money(p.amount_cents)}${p.amount_matches ? '' : ' (diferente do total)'} · ${dateTime(p.date_approved || p.date_created)}`
                })
              )
            ),
            el('p', { cls: 'admin-muted', text: 'Consulta apenas: nada foi gravado. O pedido é atualizado pelo aviso automático do Mercado Pago.' })
          );
        }
      } catch (err) {
        if (err.message !== 'sessao') out.replaceChildren(el('p', { text: 'Sem conexão com o servidor.' }));
      }
      btn.disabled = false;
    });
    return el('div', {}, [btn, out]);
  }

  function shipBlock(o) {
    const pickup = o.delivery.type === 'retirada';
    const ready = o.readiness.state === 'pronto';
    const tracking = el('input', { cls: 'admin-input', attrs: { id: 'ship-tracking', maxlength: 40, autocomplete: 'off' } });
    const date = el('input', { cls: 'admin-input', attrs: { id: 'ship-date', type: 'date', value: today(), max: today() } });
    const msg = el('p', { cls: 'admin-muted', attrs: { 'aria-live': 'polite' } });
    const btn = el('button', {
      cls: 'admin-btn admin-btn--primary',
      text: pickup ? 'Marcar como retirado' : 'Marcar como enviado',
      attrs: { type: 'button' }
    });
    btn.disabled = !ready;
    if (!ready && o.readiness.state !== 'enviado') msg.textContent = 'Disponível só para pedidos prontos para envio.';

    btn.addEventListener('click', async () => {
      const what = pickup ? 'a retirada' : 'o envio';
      if (!window.confirm(`Confirmar ${what} do pedido ${o.short_id}?`)) return;
      btn.disabled = true;
      msg.textContent = 'Registrando…';
      try {
        const res = await api('adminMarkShipped', {
          method: 'POST',
          body: { order_id: o.id, tracking_code: tracking.value.trim() || undefined, shipped_on: date.value || undefined }
        });
        const data = await readJson(res);
        if (res.ok && data && data.order) {
          renderDetail(data.order);
          load();
          return;
        }
        msg.textContent = [(data && data.error) || 'Não foi possível registrar.', ...((data && data.reasons) || [])].join(' ');
      } catch (err) {
        if (err.message !== 'sessao') msg.textContent = 'Sem conexão com o servidor.';
      }
      btn.disabled = false;
    });

    if (o.readiness.state === 'enviado') return null;
    return el('div', { cls: 'admin-ship' }, [
      pickup ? null : el('label', { cls: 'admin-field', text: 'Código de rastreio (opcional)', }, [tracking]),
      el('label', { cls: 'admin-field', text: pickup ? 'Data da retirada' : 'Data do envio', }, [date]),
      btn,
      msg
    ]);
  }

  async function copyAddress(o, button) {
    const text = labelText(o);
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Endereço copiado';
    } catch {
      // sem permissão de área de transferência: mostra o texto para copiar à mão
      window.prompt('Copie o endereço:', text.replace(/\n/g, ' · '));
    }
    setTimeout(() => (button.textContent = 'Copiar endereço de envio'), 2500);
  }

  async function openDetail(id) {
    try {
      const res = await api(`adminOrders?id=${encodeURIComponent(id)}`);
      const data = await readJson(res);
      if (!res.ok || !data) return notify((data && data.error) || 'Não foi possível abrir o pedido.', 'error');
      renderDetail(data.order);
      if (!$('detail').open) $('detail').showModal();
    } catch (err) {
      if (err.message !== 'sessao') notify('Sem conexão com o servidor.', 'error');
    }
  }

  /* ---------- ações do topo ---------- */

  async function exportCsv() {
    try {
      const res = await api('adminExport');
      if (!res.ok) return notify('Não foi possível gerar o arquivo.', 'error');
      const blob = await res.blob();
      const name = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
      const a = el('a', { attrs: { href: URL.createObjectURL(blob), download: name ? name[1] : 'pedidos-prontos.csv' } });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (err) {
      if (err.message !== 'sessao') notify('Sem conexão com o servidor.', 'error');
    }
  }

  function setAutoRefresh(on) {
    clearInterval(state.timer);
    state.timer = on ? setInterval(() => !document.hidden && load(), REFRESH_MS) : null;
    try {
      localStorage.setItem('nz-admin-auto-refresh', on ? '1' : '0');
    } catch {
      // armazenamento indisponível: vale só para esta visita
    }
  }

  async function init() {
    // Sem sessão válida, nada é carregado: volta ao login
    try {
      const res = await fetch(`${API}/adminSession`, { credentials: 'same-origin', headers: { 'X-Admin-Request': '1' } });
      if (!res.ok) {
        const next = encodeURIComponent(location.pathname + location.search);
        location.replace(`/admin/?next=${next}`);
        return;
      }
    } catch {
      location.replace('/admin/');
      return;
    }
    $('panel').hidden = false;

    filtersFromUrl();
    $('filters').addEventListener('submit', (e) => {
      e.preventDefault();
      state.page = 1;
      load();
    });
    $('clear-filters').addEventListener('click', () => {
      $('filters').reset();
      state.page = 1;
      load();
    });
    $('prev').addEventListener('click', () => {
      state.page = Math.max(1, state.page - 1);
      load();
    });
    $('next').addEventListener('click', () => {
      state.page += 1;
      load();
    });
    $('refresh').addEventListener('click', load);
    $('export').addEventListener('click', exportCsv);
    $('detail-close').addEventListener('click', () => $('detail').close());
    $('logout').addEventListener('click', async () => {
      try {
        await fetch(`${API}/adminLogout`, { method: 'POST', credentials: 'same-origin', headers: { 'X-Admin-Request': '1' } });
      } finally {
        location.replace('/admin/');
      }
    });

    let auto = true;
    try {
      auto = localStorage.getItem('nz-admin-auto-refresh') !== '0';
    } catch {
      // padrão: ligado
    }
    $('auto-refresh').checked = auto;
    $('auto-refresh').addEventListener('change', (e) => setAutoRefresh(e.target.checked));
    setAutoRefresh(auto);

    load();
  }

  init();
})();
