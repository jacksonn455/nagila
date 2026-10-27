const { test, expect } = require('@playwright/test');
const crypto = require('crypto');
const { createBackend, install } = require('./helpers/backend');
const auth = require('../functions/_lib/adminAuth');

// Páginas /admin/: indexação, redirecionamentos e fluxo completo no navegador.
// As chamadas /.netlify/functions/admin* são atendidas pelos handlers reais, no Node,
// com o banco simulado (nenhum .env e nenhuma gravação em produção).

const EMAIL = 'admin@example.com';
const PASSWORD = 'senha-de-teste-muito-segura';

test.describe('admin — fora dos buscadores e sem links públicos', () => {
  for (const path of ['/admin/', '/admin/pedidos.html']) {
    test(`${path} tem noindex, nofollow`, async ({ request }) => {
      const html = await (await request.get(path)).text();
      expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    });
  }

  test('sitemap.xml e llms.txt não citam /admin; robots.txt bloqueia /admin/ em todos os grupos', async ({ request }) => {
    expect(await (await request.get('/sitemap.xml')).text()).not.toContain('/admin');
    expect(await (await request.get('/llms.txt')).text()).not.toContain('/admin');
    const robots = await (await request.get('/robots.txt')).text();
    const groups = robots.split(/\n(?=User-agent:)/).filter((g) => g.startsWith('User-agent:'));
    expect(groups.length).toBeGreaterThan(1);
    for (const g of groups) expect(g, g.split('\n')[0]).toContain('Disallow: /admin/');
  });

  test('nenhuma página pública tem link para /admin', async ({ request }) => {
    for (const path of ['/', '/livro.html', '/404.html']) {
      expect(await (await request.get(path)).text(), path).not.toMatch(/href="\/?admin/);
    }
  });

  test('netlify.toml: X-Robots-Tag e no-store para /admin/*', async () => {
    const toml = require('fs').readFileSync(require('path').join(__dirname, '..', 'netlify.toml'), 'utf8');
    const block = toml.split('[[headers]]').find((b) => b.includes('for = "/admin/*"'));
    expect(block).toContain('X-Robots-Tag = "noindex, nofollow"');
    expect(block).toContain('Cache-Control = "no-store"');
    expect(toml).toContain('for = "/*"'); // cabeçalhos de segurança continuam valendo
  });

  test('pedidos.html sem sessão volta ao login, guardando os filtros', async ({ page }) => {
    await page.goto('/admin/pedidos.html?status=pendente');
    await expect(page).toHaveURL(/\/admin\/\?next=%2Fadmin%2Fpedidos\.html%3Fstatus%3Dpendente$/);
    await expect(page.locator('#panel')).toHaveCount(0);
  });
});

test.describe('admin — fluxo completo', () => {
  let backend;
  let restore;
  let ids;

  test.beforeEach(async ({ page }) => {
    backend = createBackend();
    restore = install(backend, {
      ADMIN_EMAIL: EMAIL,
      ADMIN_PASSWORD_HASH: await auth.hashPassword(PASSWORD, { N: 1024 }),
      ADMIN_SESSION_SECRET: 'z'.repeat(48)
    });
    ids = {
      pronto: seed('Ana Pronta', {}),
      xss: seed('<img src=x onerror="window.__xss=1">Mal', { status: 'pending', payments: [] }),
      pendente: seed('Bia Pendente', { status: 'pending', payments: [] })
    };

    // Encaminha as Functions admin para os handlers reais
    await page.route('**/.netlify/functions/admin*', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const name = url.pathname.split('/').pop();
      const res = await require(`../functions/${name}/index.js`).handler({
        httpMethod: req.method(),
        headers: { ...(await req.allHeaders()), host: url.host },
        queryStringParameters: Object.fromEntries(url.searchParams),
        body: req.postData() || undefined
      });
      await route.fulfill({ status: res.statusCode, headers: res.headers, body: res.body });
    });
  });
  test.afterEach(() => restore());

  let n = 0;
  function seed(name, o) {
    n += 1;
    const id = crypto.randomUUID();
    const total = 42565;
    backend.db.customers.push({ id: `c${n}`, name, email: `c${n}@example.com`, phone: '54999990000' });
    backend.db.orders.push({ id, customer_id: `c${n}`, status: o.status || 'paid', total_cents: total, shipping_cents: 2575, created_at: new Date(Date.UTC(2026, 8, n, 15)).toISOString() });
    backend.db.order_items.push({ order_id: id, product_id: 'book-nagila-zortea', quantity: 1, unit_price_cents: 39990, subtotal_cents: 39990 });
    backend.db.addresses.push({ order_id: id, cep: '01001000', street: '=Rua Fórmula', number: '10', neighborhood: 'Sé', city: 'São Paulo', state: 'SP' });
    backend.db.shipments.push({ order_id: id, provider: 'melhorenvio', status: 'quoted', raw: { service: 'PAC', carrier: 'Correios' } });
    for (const p of o.payments || [{ status: 'approved' }]) {
      backend.db.payments.push({ order_id: id, mercadopago_payment_id: `${100 + n}`, status: p.status, amount_cents: total, method: 'pix' });
    }
    return id;
  }

  async function doLogin(page, password = PASSWORD) {
    await page.fill('#email', EMAIL);
    await page.fill('#password', password);
    await page.click('#login-submit');
  }

  test('login, painel, detalhe, marcar como enviado, exportar e sair', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.accept()); // confirmação de envio

    await page.goto('/admin/');
    await doLogin(page, 'senha-errada-errada');
    await expect(page.locator('#login-error')).toHaveText('E-mail ou senha incorretos.');
    await expect(page.locator('#password')).toHaveValue('');

    await doLogin(page);
    await expect(page).toHaveURL(/\/admin\/pedidos\.html$/);
    await expect(page.locator('#orders tr')).toHaveCount(3);

    // cookie de sessão com os atributos de segurança
    const cookie = (await page.context().cookies()).find((c) => c.name === '__Host-nz_admin');
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });

    // nome malicioso aparece como texto, sem executar nada
    await expect(page.locator('#orders')).toContainText('<img src=x onerror="window.__xss=1">Mal');
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    await expect(page.locator('#orders img')).toHaveCount(0);

    // resumo
    await expect(page.locator('#summary')).toContainText('Prontos para envio');

    // detalhe e marcação de envio
    await page.locator('tr', { hasText: 'Ana Pronta' }).getByRole('button', { name: /Detalhes/ }).click();
    await expect(page.locator('#detail')).toBeVisible();
    await expect(page.locator('#detail-body')).toContainText('Todas as condições para envio foram atendidas.');
    await page.fill('#ship-tracking', 'AB123456789BR');
    await page.getByRole('button', { name: 'Marcar como enviado' }).click();
    await expect(page.locator('#detail-body')).toContainText('Rastreio: AB123456789BR');
    expect(backend.db.shipments.find((s) => s.order_id === ids.pronto)).toMatchObject({ status: 'shipped', tracking_code: 'AB123456789BR', marked_by: EMAIL });
    await page.click('#detail-close');

    // pedido pendente: botão de envio desativado
    await page.locator('tr', { hasText: 'Bia Pendente' }).getByRole('button', { name: /Detalhes/ }).click();
    await expect(page.getByRole('button', { name: 'Marcar como enviado' })).toBeDisabled();
    await expect(page.locator('#detail-body')).toContainText('Pagamento pendente');
    await page.click('#detail-close');

    // exportação (nenhum pedido pronto restante: só cabeçalho)
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
    expect(download.suggestedFilename()).toMatch(/^pedidos-prontos-\d{4}-\d{2}-\d{2}\.csv$/);

    // sair
    await page.click('#logout');
    await expect(page).toHaveURL(/\/admin\/$/);
    await page.goto('/admin/pedidos.html');
    await expect(page).toHaveURL(/\/admin\/\?next=/);
    expect(errors).toEqual([]);
  });

  test('sessão expirada no meio do uso: avisa, volta ao login e mantém o filtro', async ({ page }) => {
    await page.goto('/admin/');
    await doLogin(page);
    await expect(page).toHaveURL(/pedidos\.html/);
    await page.selectOption('#f-status', 'pendente');
    await page.getByRole('button', { name: 'Filtrar' }).click();
    await expect(page).toHaveURL(/pedidos\.html\?status=pendente$/);
    await expect(page.locator('#orders tr')).toHaveCount(2);

    await page.context().clearCookies(); // a sessão "expira"
    await page.click('#refresh');
    await expect(page).toHaveURL(/\/admin\/\?expirada=1&next=%2Fadmin%2Fpedidos\.html%3Fstatus%3Dpendente$/);
    await expect(page.locator('#login-notice')).toHaveText('Sua sessão expirou. Entre novamente para continuar.');

    await doLogin(page);
    await expect(page).toHaveURL(/\/admin\/pedidos\.html\?status=pendente$/);
    await expect(page.locator('#f-status')).toHaveValue('pendente');
  });

  test('login não redireciona para fora do painel (next malicioso)', async ({ page }) => {
    await page.goto('/admin/?next=https://ataque.test/');
    await doLogin(page);
    await expect(page).toHaveURL(/\/admin\/pedidos\.html$/);
  });

  for (const width of [390, 1280]) {
    test(`painel sem rolagem horizontal da página em ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/admin/');
      await doLogin(page);
      await expect(page.locator('#orders tr')).toHaveCount(3);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
});
