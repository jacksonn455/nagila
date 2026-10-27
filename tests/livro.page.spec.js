const { test, expect } = require('@playwright/test');

// livro.html: layout no celular e dados estruturados (JSON-LD)

function mockBookInfo(page, body = {}, status = 200) {
  return page.route('**/.netlify/functions/bookInfo', (route) =>
    route.fulfill({
      status,
      body: JSON.stringify({ title: 'Livro', price_cents: 39990, max_quantity: 3, available: true, sold_out: false, low_stock: false, pickup: null, ...body })
    })
  );
}

test.describe('livro.html — sem rolagem horizontal', () => {
  for (const width of [320, 375, 390, 768]) {
    // normal: preço do servidor · indisponível: bookInfo fora do ar · preview: dados de demonstração
    for (const mode of ['normal', 'indisponível', 'preview']) {
      test(`${width}px (${mode})`, async ({ page }) => {
        if (mode === 'normal') await mockBookInfo(page);
        await page.setViewportSize({ width, height: 800 });
        await page.goto(`/livro.html${mode === 'preview' ? '?preview=1' : ''}`);
        // revela as seções animadas para medir o layout final
        await page.evaluate(() => document.querySelectorAll('[data-reveal]').forEach((el) => el.setAttribute('data-reveal', 'visible')));
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth
        }));
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
      });
    }
  }
});

test.describe('livro.html — JSON-LD do livro', () => {
  test('é JSON válido com os dados confirmados do livro', async ({ page }) => {
    await page.goto('/livro.html');
    const blocks = await page.$$eval('script[type="application/ld+json"]', (els) => els.map((el) => el.textContent));
    expect(blocks).toHaveLength(1);
    const data = JSON.parse(blocks[0]);

    expect(data['@context']).toBe('https://schema.org');
    expect(data['@type']).toBe('Book');
    expect(data.name).toBe('Pós-operatório e o raciocínio diante da cirurgia plástica');
    expect(data.isbn).toBe('9786553083547');
    expect(data.numberOfPages).toBe(231);
    expect(data.bookEdition).toBe('1ª edição');
    expect(data.datePublished).toBe('2026');
    expect(data.inLanguage).toBe('pt-BR');
    expect(data.publisher).toEqual({ '@type': 'Organization', name: 'Editora Lux' });
    expect(data.author.name).toBe('Nágila Zortéa');
    expect(data.url).toBe('https://nagilazortea.com.br/livro.html');
    // Product/Offer e imagem continuam desligados até existir a capa sozinha
    expect(data.offers).toBeUndefined();
    expect(data.image).toBeUndefined();
  });

  test('o ISBN do JSON-LD é o mesmo da ficha técnica e tem dígito verificador válido', async ({ page }) => {
    await page.goto('/livro.html');
    const data = JSON.parse(await page.locator('script[type="application/ld+json"]').textContent());
    const ficha = await page.locator('.book-specs__row', { hasText: 'ISBN' }).locator('dd').textContent();
    expect(ficha.replace(/-/g, '')).toBe(data.isbn);
    const digits = data.isbn.split('').map(Number);
    const sum = digits.slice(0, 12).reduce((acc, d, i) => acc + d * (i % 2 ? 3 : 1), 0);
    expect((10 - (sum % 10)) % 10).toBe(digits[12]);
  });
});

test.describe('livro.html — preço', () => {
  // Intl.NumberFormat usa espaço não separável depois do "R$"
  const displays = (page) => page.$$eval('[data-price-display]', (els) => els.map((el) => el.textContent.replace(/\s/g, ' ')));

  test('o HTML estático já traz R$ 399,90 (prévias de link e buscadores sem JavaScript)', async ({ request }) => {
    const html = await (await request.get('/livro.html')).text();
    expect(html.match(/data-price-display="">R\$ 399,90</g)).toHaveLength(3);
    expect(html).not.toContain('Preço a definir');
  });

  test('o valor do servidor substitui o estático', async ({ page }) => {
    await mockBookInfo(page, { price_cents: 41990 });
    await page.goto('/livro.html');
    await expect(page.locator('#product-price')).toHaveText('R$ 419,90');
    expect(await displays(page)).toEqual(['R$ 419,90', 'R$ 419,90', 'R$ 419,90']);
    await expect(page.locator('[data-price-flag]:visible')).toHaveCount(0);
    await expect(page.locator('#buy')).toBeEnabled();
  });

  for (const [name, setup] of [
    ['bookInfo com erro', (page) => mockBookInfo(page, {}, 500)],
    ['bookInfo sem preço', (page) => mockBookInfo(page, { price_cents: null })],
    ['bookInfo fora do ar', (page) => page.route('**/.netlify/functions/bookInfo', (route) => route.abort())]
  ]) {
    test(`${name}: esconde o preço e desativa a compra`, async ({ page }) => {
      await setup(page);
      await page.goto('/livro.html');
      await expect(page.locator('#buy')).toBeDisabled();
      expect(await displays(page)).toEqual(['R$ —', 'R$ —', 'R$ —']);
      await expect(page.locator('.book-price [data-price-flag]')).toHaveText('Indisponível no momento');
      await expect(page.locator('#calc-shipping')).toBeDisabled();
      await expect(page.locator('#messages')).toHaveText('Não foi possível carregar o preço agora. Recarregue a página em instantes.');
    });
  }

  test('preview continua com R$ 99,00 e o selo “Valor demonstrativo”, sem chamar a API', async ({ page }) => {
    let called = false;
    await page.route('**/.netlify/functions/**', (route) => {
      called = true;
      route.abort();
    });
    await page.goto('/livro.html?preview=1');
    expect(await displays(page)).toEqual(['R$ 99,00', 'R$ 99,00', 'R$ 99,00']);
    await expect(page.locator('.book-price [data-price-flag]')).toHaveText('Valor demonstrativo');
    await expect(page.locator('.book-price [data-price-flag]')).toBeVisible();
    expect(called).toBe(false);
  });
});

test.describe('livro.html — metadados sociais', () => {
  test('twitter:card summary espelha og:title/og:description, sem imagem social', async ({ page }) => {
    await page.goto('/livro.html');
    const meta = (sel) => page.locator(sel).getAttribute('content');
    expect(await meta('meta[name="twitter:card"]')).toBe('summary');
    expect(await meta('meta[name="twitter:title"]')).toBe(await meta('meta[property="og:title"]'));
    expect(await meta('meta[name="twitter:description"]')).toBe(await meta('meta[property="og:description"]'));
    await expect(page.locator('meta[property="og:image"], meta[name="twitter:image"]')).toHaveCount(0);
  });
});
