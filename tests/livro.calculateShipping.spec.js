const { test, expect } = require('@playwright/test');
const { createBackend, install, call } = require('./helpers/backend');

// Servidor: handler chamado direto no Node, com o Melhor Envio simulado
test.describe('calculateShipping — servidor', () => {
  let backend;
  let restore;
  test.beforeEach(() => {
    backend = createBackend();
    restore = install(backend);
  });
  test.afterEach(() => restore());

  const quote = (body) => call('calculateShipping', { httpMethod: 'POST', body: JSON.stringify(body) });

  test('envia ao Melhor Envio as medidas, o peso e o seguro do servidor', async () => {
    const res = await quote({ cep: '01001-000', quantity: 2, weight: 1, length: 1 });
    expect(res.status).toBe(200);
    const meCall = backend.calls.find((c) => c.url.endsWith('/api/v2/me/shipment/calculate'));
    expect(meCall.url).toBe('https://www.melhorenvio.com.br/api/v2/me/shipment/calculate');
    expect(meCall.headers.Authorization).toBe('Bearer test-me-token');
    expect(meCall.body).toEqual({
      from: { postal_code: '99700000' },
      to: { postal_code: '01001000' },
      products: [{ id: 'book-nagila-zortea', length: 23, width: 16, height: 2, weight: 0.26, insurance_value: 399.9, quantity: 2 }],
      options: { receipt: false, own_hand: false },
      services: '1,2,3'
    });
  });

  test('filtra serviços: só os permitidos, sem erro, ordenados pelo preço (custom_price primeiro)', async () => {
    const res = await quote({ cep: '01001000', quantity: 1 });
    expect(res.body.options).toEqual([
      { id: '1', service: 'PAC', carrier: 'Correios', price_cents: 2575, estimated_days: 6 },
      { id: '3', service: '.Package', carrier: 'Jadlog', price_cents: 2800, estimated_days: 8 },
      { id: '2', service: 'SEDEX', carrier: 'Correios', price_cents: 4947, estimated_days: 2 }
    ]);
  });

  test('MELHOR_ENVIO_SERVICES troca os serviços oferecidos', async () => {
    process.env.MELHOR_ENVIO_SERVICES = '2';
    const res = await quote({ cep: '01001000', quantity: 1 });
    expect(res.body.options.map((o) => o.service)).toEqual(['SEDEX']);
    expect(backend.me.lastPayload.services).toBe('2');
  });

  test('erros: CEP, quantidade, limite, configuração, sem opção e Melhor Envio fora do ar', async () => {
    expect(await quote({ cep: '123', quantity: 1 })).toEqual({ status: 400, body: { error: 'CEP inválido.' } });
    expect(await quote({ cep: '01001000', quantity: 0 })).toEqual({ status: 400, body: { error: 'Quantidade inválida.' } });
    expect(await quote({ cep: '01001000', quantity: 4 })).toEqual({ status: 400, body: { error: 'Máximo de 3 exemplares por pedido.' } });

    backend.me.quote = [{ id: 17, name: 'Mini Envios', price: '10.00' }];
    expect(await quote({ cep: '01001000', quantity: 1 })).toEqual({ status: 422, body: { error: 'Nenhuma opção de entrega disponível para este CEP.' } });

    backend.me.fails = true;
    expect(await quote({ cep: '01001000', quantity: 1 })).toEqual({
      status: 502,
      body: { error: 'Não foi possível calcular o frete agora. Tente novamente em instantes.' }
    });

    delete process.env.MELHOR_ENVIO_TOKEN;
    expect(await quote({ cep: '01001000', quantity: 1 })).toEqual({ status: 503, body: { error: 'Cálculo de frete ainda não configurado.' } });

    delete process.env.BOOK_WEIGHT_GRAMS;
    expect(await quote({ cep: '01001000', quantity: 1 })).toEqual({ status: 503, body: { error: 'Venda do livro ainda não configurada.' } });
  });
});

test.describe('calculateShipping', () => {
  test.beforeEach(async ({ page }) => {
    // sem bookInfo a página desativa a compra (estado seguro); aqui o preço vem do servidor
    await page.route('**/.netlify/functions/bookInfo', (route) =>
      route.fulfill({ status: 200, body: JSON.stringify({ title: 'Livro', price_cents: 39990, max_quantity: 3, available: true, pickup: null }) })
    );
    await page.goto('/livro.html');
  });

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
