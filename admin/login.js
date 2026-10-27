/* Login da área administrativa. A sessão é um cookie HttpOnly gravado pela Function adminLogin. */
(function () {
  'use strict';

  const API = '/.netlify/functions';
  const PANEL = '/admin/pedidos.html';
  const params = new URLSearchParams(location.search);

  // Só volta para o próprio painel (evita redirecionamento para fora do site)
  function nextUrl() {
    const next = params.get('next') || '';
    return next.startsWith(PANEL) && !next.startsWith('//') ? next : PANEL;
  }

  function call(path, options = {}) {
    return fetch(`${API}/${path}`, {
      credentials: 'same-origin',
      ...options,
      headers: { 'X-Admin-Request': '1', ...(options.body ? { 'Content-Type': 'application/json' } : {}) }
    });
  }

  const form = document.getElementById('login-form');
  const error = document.getElementById('login-error');
  const notice = document.getElementById('login-notice');
  const submit = document.getElementById('login-submit');

  if (params.get('expirada') === '1') {
    notice.textContent = 'Sua sessão expirou. Entre novamente para continuar.';
    notice.hidden = false;
  }

  // Já logado: vai direto para o painel
  call('adminSession')
    .then((res) => {
      if (res.ok) location.replace(nextUrl());
    })
    .catch(() => {});

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    const email = form.email.value.trim();
    const password = form.password.value;
    if (!email || !password) {
      error.textContent = 'Informe e-mail e senha.';
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Entrando…';
    try {
      const res = await call('adminLogin', { method: 'POST', body: JSON.stringify({ email, password }) });
      if (res.ok) {
        location.replace(nextUrl());
        return;
      }
      let data = null;
      try {
        data = await res.json();
      } catch {
        // resposta sem JSON
      }
      error.textContent = (data && data.error) || 'Não foi possível entrar. Tente novamente.';
    } catch {
      error.textContent = 'Sem conexão. Verifique a internet e tente novamente.';
    }
    form.password.value = '';
    submit.disabled = false;
    submit.textContent = 'Entrar';
  });
})();
