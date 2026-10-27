const { test, expect } = require('@playwright/test');

// livro.html: layout no celular e dados estruturados (JSON-LD)

test.describe('livro.html — sem rolagem horizontal', () => {
  for (const width of [320, 375, 390, 768]) {
    for (const preview of [false, true]) {
      test(`${width}px${preview ? ' (preview)' : ''}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(`/livro.html${preview ? '?preview=1' : ''}`);
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
