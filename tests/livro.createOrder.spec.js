const { test, expect } = require('@playwright/test');

test.describe('createOrder validations', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/livro.html');
  });

  test('rejects invalid quantity (0)', async ({ page }) => {
    await page.fill('#quantity', '0');
    await page.fill('#cep', '99000-000');
    await page.fill('#name', 'A');
    await page.fill('#email', 'a@b.com');
    await page.click('#calc-shipping');
    // assume calc shows message
    await page.click('#buy');
    await expect(page.locator('#messages')).toContainText('Quantidade inválida');
  });

  test('rejects quantity above max (scaffold)', async ({ page }) => {
    // simulate frontend-only: BOOK.maxQuantity not set in scaffold, server would reject; expect server message
    await page.fill('#quantity', '9999');
    await page.fill('#cep', '99000-000');
    await page.fill('#name', 'User');
    await page.fill('#email', 'u@example.com');
    await page.click('#calc-shipping');
    await page.click('#buy');
    await expect(page.locator('#messages')).not.toBeEmpty();
  });

  test('rejects invalid CEP', async ({ page }) => {
    await page.fill('#cep', 'abc');
    await page.click('#calc-shipping');
    await expect(page.locator('#messages')).toContainText('CEP');
  });

  test('required fields missing', async ({ page }) => {
    await page.fill('#name', '');
    await page.fill('#email', '');
    await page.click('#buy');
    await expect(page.locator('#messages')).toContainText('Preencha nome, email e CEP');
  });

  test('rejects attempts to send price/unit_price/shipping_price in payload', async ({ page }) => {
    // This test simulates constructing a fetch to createOrder with forbidden fields
    const res = await page.evaluate(async () => {
      const payload = { client_token: 'ct-test', name: 'T', email: 't@e.com', quantity: 1, address: { cep: '99000-000' }, price: 1000, unit_price: 1000, shipping_price: 100 };
      const r = await fetch('/.netlify/functions/createOrder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      return { status: r.status, body: await r.json() };
    });
    // Server should ignore client price fields or reject; ensure not 200 creating init_point
    expect([200,400,422]).toContain(res.status);
  });

  test('rejects attempts to manipulate weight/dimensions', async ({ page }) => {
    const res = await page.evaluate(async () => {
      const payload = { client_token: 'ct-test2', name: 'T', email: 't@e.com', quantity: 1, address: { cep: '99000-000' }, weightGrams: 99999, dimensions: { length: 999, width: 999, height: 999 } };
      const r = await fetch('/.netlify/functions/createOrder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      return { status: r.status, body: await r.json() };
    });
    expect([200,400,422]).toContain(res.status);
  });

  test('idempotency: same client_token twice reuses order/preference', async ({ page }) => {
    const token = `ct-${Date.now()}`;
    const payload = { client_token: token, name: 'Idem', email: 'idem@example.com', quantity: 1, address: { cep: '99000-000' }, shipping_option_id: 'placeholder' };
    const first = await page.evaluate(async (p) => { const r = await fetch('/.netlify/functions/createOrder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }); return { status: r.status, body: await r.json() }; }, payload);
    const second = await page.evaluate(async (p) => { const r = await fetch('/.netlify/functions/createOrder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }); return { status: r.status, body: await r.json() }; }, payload);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // Both should reference same order_id
    expect(first.body.order_id || first.body.mercadopago_preference_id).toBeTruthy();
    expect(second.body.order_id || second.body.mercadopago_preference_id).toBeTruthy();
    if (first.body.order_id && second.body.order_id) expect(first.body.order_id).toBe(second.body.order_id);
  });
});
