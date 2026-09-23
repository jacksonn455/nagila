const { test, expect } = require('@playwright/test');

// Functions endpoints are mocked with page.route — no backend needed.

const OPTIONS = [
  { id: '1', service: 'PAC', carrier: 'Correios', price_cents: 1850, estimated_days: 7 },
  { id: '2', service: 'SEDEX', carrier: 'Correios', price_cents: 4500, estimated_days: 2 }
];

async function mockApi(page, { createOrder } = {}) {
  await page.route('**/.netlify/functions/bookInfo', (route) =>
    route.fulfill({ status: 200, body: JSON.stringify({ title: 'Livro', price_cents: 8990, max_quantity: 5, available: true }) })
  );
  await page.route('**/.netlify/functions/calculateShipping', (route) =>
    route.fulfill({ status: 200, body: JSON.stringify({ options: OPTIONS }) })
  );
  if (createOrder) await page.route('**/.netlify/functions/createOrder', createOrder);
}

async function fillAddress(page) {
  await page.fill('#name', 'Teste');
  await page.fill('#email', 'test@example.com');
  await page.fill('#phone', '54999999999');
  await page.fill('#street', 'Rua A');
  await page.fill('#number', '10');
  await page.fill('#neighborhood', 'Centro');
  await page.fill('#city', 'Erechim');
  await page.selectOption('#state', 'RS');
}

test.describe('Livro page', () => {
  test('opens livro page and shows server price', async ({ page }) => {
    await mockApi(page);
    await page.goto('/livro.html');
    await expect(page.locator('#product-title')).toHaveText(/Título do livro/);
    await expect(page.locator('#product-price')).toHaveText('R$ 89,90');
  });

  test('calculates shipping and updates summary (mocked)', async ({ page }) => {
    await mockApi(page);
    await page.goto('/livro.html');
    await expect(page.locator('#product-price')).toHaveText('R$ 89,90');
    await page.fill('#cep', '99000-000');
    await page.click('#calc-shipping');

    await expect(page.locator('#shipping-options')).toContainText('PAC');
    await expect(page.locator('#summary-shipping')).toHaveText('R$ 18,50');
    await expect(page.locator('#summary-total')).toHaveText('R$ 108,40');

    await page.locator('input[data-option-id="2"]').check();
    await expect(page.locator('#summary-total')).toHaveText('R$ 134,90');
  });

  test('changing CEP invalidates the shipping quote', async ({ page }) => {
    await mockApi(page);
    await page.goto('/livro.html');
    await page.fill('#cep', '99000-000');
    await page.click('#calc-shipping');
    await expect(page.locator('#shipping-options')).toContainText('PAC');
    await page.fill('#cep', '01001-000');
    await expect(page.locator('#shipping-options')).toBeEmpty();
    await expect(page.locator('#summary-shipping')).toHaveText('—');
  });

  test('sends full address and redirects to Mercado Pago (mocked)', async ({ page }) => {
    let sent = null;
    await mockApi(page, {
      createOrder: (route) => {
        sent = route.request().postDataJSON();
        route.fulfill({ status: 200, body: JSON.stringify({ init_point: 'https://www.mercadopago.com/mock' }) });
      }
    });
    await page.route('https://www.mercadopago.com/mock', (route) => route.fulfill({ status: 200, body: 'ok' }));

    await page.goto('/livro.html');
    await page.fill('#cep', '99000-000');
    await page.click('#calc-shipping');
    await expect(page.locator('#shipping-options')).toContainText('PAC');
    await fillAddress(page);

    await Promise.all([page.waitForURL('https://www.mercadopago.com/mock'), page.click('#buy')]);
    expect(sent.address).toMatchObject({ cep: '99000000', street: 'Rua A', number: '10', neighborhood: 'Centro', city: 'Erechim', state: 'RS' });
    expect(sent.shipping_option_id).toBe('1');
    expect(sent).not.toHaveProperty('price');
  });

  test('requires address before creating order', async ({ page }) => {
    await mockApi(page);
    await page.goto('/livro.html');
    await page.fill('#cep', '99000-000');
    await page.click('#calc-shipping');
    await expect(page.locator('#shipping-options')).toContainText('PAC');
    await page.fill('#name', 'X');
    await page.fill('#email', 'a@b.com');
    await page.click('#buy');
    await expect(page.locator('#messages')).toContainText('endereço');
  });

  test('shows server error message', async ({ page }) => {
    await mockApi(page, {
      createOrder: (route) => route.fulfill({ status: 409, body: JSON.stringify({ error: 'A opção de frete escolhida não está mais disponível.' }) })
    });
    await page.goto('/livro.html');
    await page.fill('#cep', '99000-000');
    await page.click('#calc-shipping');
    await expect(page.locator('#shipping-options')).toContainText('PAC');
    await fillAddress(page);
    await page.click('#buy');
    await expect(page.locator('#messages')).toContainText('não está mais disponível');
    await expect(page.locator('#buy')).toBeEnabled();
  });

  test('rejects invalid quantity', async ({ page }) => {
    await mockApi(page);
    await page.goto('/livro.html');
    await page.fill('#quantity', '0');
    await page.fill('#cep', '99000-000');
    await page.click('#calc-shipping');
    await expect(page.locator('#messages')).toContainText('Quantidade inválida');
  });

  test('shows result when returning from Mercado Pago', async ({ page }) => {
    await mockApi(page);
    await page.goto('/livro.html?pagamento=aprovado');
    await expect(page.locator('#checkout-result')).toContainText('Pedido recebido');
    await page.goto('/livro.html?pagamento=falhou');
    await expect(page.locator('#checkout-result')).toContainText('não foi concluído');
  });
});
