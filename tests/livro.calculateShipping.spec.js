const { test, expect } = require('@playwright/test');

test.describe('calculateShipping', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/livro.html'); });

  test('invalid CEP', async ({ page }) => {
    await page.fill('#cep', 'badcep');
    await page.click('#calc-shipping');
    await expect(page.locator('#messages')).toContainText('CEP');
  });

  test('invalid quantity', async ({ page }) => {
    await page.fill('#quantity', '0');
    await page.fill('#cep', '99000-000');
    await page.click('#calc-shipping');
    await expect(page.locator('#messages')).toContainText('Quantidade inválida');
  });

  test('Melhor Envio unavailable / BOOK config missing', async ({ page }) => {
    await page.route('**/.netlify/functions/calculateShipping', (route) =>
      route.fulfill({ status: 503, body: JSON.stringify({ error: 'Venda do livro ainda não configurada.' }) })
    );
    await page.fill('#cep', '99000-000');
    await page.click('#calc-shipping');
    await expect(page.locator('#messages')).toContainText('ainda não configurada');
  });

  test('integration returns invalid response', async ({ page }) => {
    // Simulate fetch returning malformed response by overriding fetch in page
    await page.addInitScript(() => {
      const orig = window.fetch;
      window.fetch = (input, opts) => {
        if (typeof input === 'string' && input.includes('calculateShipping')) {
          return Promise.resolve(new Response('notjson', { status: 200, headers: { 'Content-Type': 'text/plain' } }));
        }
        return orig(input, opts);
      };
    });
    await page.reload();
    await page.fill('#cep', '99000-000');
    await page.click('#calc-shipping');
    await expect(page.locator('#messages')).toContainText('Erro');
  });
});
