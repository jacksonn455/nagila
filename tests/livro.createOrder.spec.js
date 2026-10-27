const { test, expect } = require('@playwright/test');
const { createBackend, install, call } = require('./helpers/backend');

// createOrder chamado direto no Node, com Supabase, Mercado Pago e Melhor Envio simulados.
// Nada é gravado em produção.

const ADDRESS = {
  cep: '01001-000',
  street: 'Praça da Sé',
  number: '100',
  complement: 'Sala 1',
  neighborhood: 'Sé',
  city: 'São Paulo',
  state: 'SP'
};

let backend;
let restore;

function order(overrides = {}) {
  return {
    client_token: `ct-${Math.random().toString(36).slice(2, 12)}`,
    name: 'Maria Teste',
    email: 'Maria@Example.com',
    phone: '54999999999',
    quantity: 1,
    address: ADDRESS,
    shipping_option_id: '1', // PAC
    ...overrides
  };
}

function createOrder(payload) {
  return call('createOrder', { httpMethod: 'POST', body: JSON.stringify(payload) });
}

const preferenceCalls = () => backend.calls.filter((c) => c.url.endsWith('/checkout/preferences'));

test.describe('createOrder — servidor', () => {
  test.beforeEach(() => {
    backend = createBackend();
    restore = install(backend);
  });
  test.afterEach(() => restore());

  test('pedido válido: grava tudo e cria a preferência com o preço do servidor', async () => {
    const res = await createOrder(order({ quantity: 2 }));
    expect(res.status).toBe(200);
    expect(res.body.init_point).toBe('https://mp.test/checkout/pref-1');

    const [o] = backend.db.orders;
    expect(res.body.order_id).toBe(o.id);
    expect(o).toMatchObject({ status: 'pending', total_cents: 2 * 39990 + 2575, shipping_cents: 2575, currency: 'BRL', mercadopago_preference_id: 'pref-1' });
    expect(backend.db.customers[0]).toMatchObject({ name: 'Maria Teste', email: 'maria@example.com', phone: '54999999999' });
    expect(backend.db.order_items[0]).toMatchObject({ order_id: o.id, quantity: 2, unit_price_cents: 39990, subtotal_cents: 79980 });
    expect(backend.db.addresses[0]).toMatchObject({ order_id: o.id, cep: '01001000', street: 'Praça da Sé', state: 'SP', country: 'BR' });
    expect(backend.db.shipments[0]).toMatchObject({ order_id: o.id, provider: 'melhorenvio', status: 'quoted' });
    expect(backend.db.payments[0]).toMatchObject({ order_id: o.id, status: 'preference_created', mercadopago_preference_id: 'pref-1', amount_cents: o.total_cents });

    const pref = preferenceCalls()[0].body;
    expect(pref.external_reference).toBe(o.id);
    expect(pref.notification_url).toBe('https://site.test/.netlify/functions/paymentWebhook');
    expect(pref.back_urls.success).toBe('https://site.test/livro.html?pagamento=aprovado');
    expect(pref.items).toEqual([
      { id: 'book-nagila-zortea', title: 'Pós-operatório e o raciocínio diante da cirurgia plástica', quantity: 2, unit_price: 399.9, currency_id: 'BRL' },
      { id: 'frete-1', title: 'Frete — Correios PAC', quantity: 1, unit_price: 25.75, currency_id: 'BRL' }
    ]);
  });

  test('ignora preço enviado pelo navegador', async () => {
    const res = await createOrder(order({ price: 1, unit_price: 1, shipping_price: 0, price_cents: 1, total_cents: 1 }));
    expect(res.status).toBe(200);
    expect(backend.db.orders[0].total_cents).toBe(39990 + 2575);
    expect(preferenceCalls()[0].body.items[0].unit_price).toBe(399.9);
  });

  test('ignora peso e medidas enviados pelo navegador', async () => {
    const res = await createOrder(order({ weightGrams: 1, weight: 0.001, dimensions: { length: 1, width: 1, height: 1 } }));
    expect(res.status).toBe(200);
    const product = backend.me.lastPayload.products[0];
    expect(product).toMatchObject({ length: 23, width: 16, height: 2, weight: 0.26, insurance_value: 399.9, quantity: 1 });
  });

  test('valida o endereço de entrega', async () => {
    for (const address of [
      { ...ADDRESS, street: '' },
      { ...ADDRESS, number: '' },
      { ...ADDRESS, neighborhood: '' },
      { ...ADDRESS, city: '' },
      { ...ADDRESS, state: 'XX' },
      { ...ADDRESS, cep: '123' },
      {}
    ]) {
      const res = await createOrder(order({ address }));
      expect(res.status, JSON.stringify(address)).toBe(400);
      expect(res.body.error).toBe('Endereço de entrega incompleto.');
    }
    expect(backend.db.orders).toHaveLength(0);
  });

  test('valida nome, e-mail, quantidade e client_token', async () => {
    expect(await createOrder(order({ name: '' }))).toEqual({ status: 400, body: { error: 'Informe nome e e-mail válidos.' } });
    expect(await createOrder(order({ email: 'sem-arroba' }))).toEqual({ status: 400, body: { error: 'Informe nome e e-mail válidos.' } });
    expect(await createOrder(order({ quantity: 0 }))).toEqual({ status: 400, body: { error: 'Quantidade inválida.' } });
    expect(await createOrder(order({ quantity: 1.5 }))).toEqual({ status: 400, body: { error: 'Quantidade inválida.' } });
    expect(await createOrder(order({ client_token: 'curto' }))).toEqual({ status: 400, body: { error: 'Requisição inválida (client_token).' } });
    expect(backend.db.orders).toHaveLength(0);
  });

  test('respeita BOOK_MAX_QUANTITY', async () => {
    const res = await createOrder(order({ quantity: 4 }));
    expect(res).toEqual({ status: 400, body: { error: 'Máximo de 3 exemplares por pedido.' } });
    expect(backend.db.orders).toHaveLength(0);
    expect((await createOrder(order({ quantity: 3 }))).status).toBe(200);
  });

  test('recusa opção de frete que deixou de existir', async () => {
    const res = await createOrder(order({ shipping_option_id: '17' })); // Mini Envios: fora da lista permitida
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('A opção de frete escolhida não está mais disponível. Calcule o frete novamente.');
    expect(backend.db.orders).toHaveLength(0);
    expect(preferenceCalls()).toHaveLength(0);
  });

  test('idempotência: o mesmo pedido enviado duas vezes reaproveita pedido e pagamento', async () => {
    const payload = order();
    const first = await createOrder(payload);
    const second = await createOrder(payload);
    expect(first.status).toBe(200);
    expect(second).toEqual(first);
    expect(backend.db.orders).toHaveLength(1);
    expect(preferenceCalls()).toHaveLength(1);
  });

  test('falha do Mercado Pago cancela o pedido', async () => {
    backend.mp.preferenceFails = true;
    const res = await createOrder(order());
    expect(res).toEqual({ status: 502, body: { error: 'Não foi possível iniciar o pagamento. Tente novamente.' } });
    expect(backend.db.orders[0].status).toBe('cancelled');
    expect(backend.db.payments).toHaveLength(0);
  });

  test('retirada no local: sem endereço, sem frete e com aviso no retorno', async () => {
    const res = await createOrder(order({ shipping_option_id: 'pickup', address: {} }));
    expect(res.status).toBe(200);
    expect(backend.db.orders[0]).toMatchObject({ total_cents: 39990, shipping_cents: 0 });
    expect(backend.db.addresses).toHaveLength(0);
    expect(backend.db.shipments[0]).toMatchObject({ provider: 'pickup', status: 'awaiting_pickup' });
    expect(backend.me.lastPayload).toBeNull(); // não cota frete
    const pref = preferenceCalls()[0].body;
    expect(pref.items).toHaveLength(1);
    expect(pref.back_urls.pending).toBe('https://site.test/livro.html?pagamento=pendente&entrega=retirada');
  });

  test('retirada desativada é recusada', async () => {
    process.env.PICKUP_ENABLED = 'false';
    const res = await createOrder(order({ shipping_option_id: 'pickup', address: {} }));
    expect(res).toEqual({ status: 400, body: { error: 'Retirada no local indisponível.' } });
  });

  test('sem configuração do livro ou do Mercado Pago: 503 com mensagem clara', async () => {
    delete process.env.BOOK_PRICE_CENTS;
    expect(await createOrder(order())).toEqual({ status: 503, body: { error: 'Venda do livro ainda não configurada.' } });
    process.env.BOOK_PRICE_CENTS = '39990';
    delete process.env.MERCADOPAGO_ACCESS_TOKEN;
    expect(await createOrder(order())).toEqual({ status: 503, body: { error: 'Pagamento ainda não configurado.' } });
    expect(backend.db.orders).toHaveLength(0);
  });
});

test.describe('createOrder — validações na página', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/.netlify/functions/bookInfo', (route) =>
      route.fulfill({
        status: 200,
        body: JSON.stringify({ title: 'Livro', price_cents: 39990, max_quantity: 3, available: true, sold_out: false, low_stock: false, pickup: null })
      })
    );
    await page.goto('/livro.html');
    await expect(page.locator('#product-price')).toHaveText('R$ 399,90');
  });

  test('quantidade 0 é recusada', async ({ page }) => {
    await page.fill('#quantity', '0');
    await page.fill('#cep', '99000-000');
    await page.click('#calc-shipping');
    await expect(page.locator('#messages')).toHaveText('Quantidade inválida.');
    await page.fill('#name', 'A');
    await page.fill('#email', 'a@b.com');
    await page.click('#buy');
    await expect(page.locator('#messages')).toHaveText('Quantidade inválida.');
  });

  test('quantidade acima do máximo é recusada e o botão + para no limite', async ({ page }) => {
    await page.fill('#quantity', '4');
    await page.fill('#cep', '99000-000');
    await page.click('#calc-shipping');
    await expect(page.locator('#messages')).toHaveText('Quantidade inválida.');

    await page.fill('#quantity', '3');
    await page.click('#qty-increase');
    await expect(page.locator('#quantity')).toHaveValue('3');
  });

  test('CEP inválido é recusado', async ({ page }) => {
    await page.fill('#cep', 'abc');
    await page.click('#calc-shipping');
    await expect(page.locator('#messages')).toHaveText('Informe um CEP válido.');
  });

  test('nome, e-mail e CEP são obrigatórios', async ({ page }) => {
    await page.click('#buy');
    await expect(page.locator('#messages')).toHaveText('Preencha nome, email e CEP.');
  });
});
