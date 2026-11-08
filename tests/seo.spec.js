// @ts-check
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { JSDOM } = require('jsdom');
const sitemap = require('../scripts/build-sitemap.js');

// SEO: sitemap.xml, robots.txt, metadados e dados estruturados da página de venda do livro

const ROOT = path.resolve(__dirname, '..');
const ORIGIN = 'https://nagilazortea.com.br';
const BOOK_URL = `${ORIGIN}/livro.html`;
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const doc = (file) => new JSDOM(read(file)).window.document;

function sitemapEntries() {
  const d = new JSDOM(read('sitemap.xml'), { contentType: 'application/xml' }).window.document;
  expect(d.querySelector('parsererror')).toBeNull();
  return [...d.getElementsByTagName('url')].map((url) => ({
    loc: url.getElementsByTagName('loc')[0].textContent,
    lastmod: url.getElementsByTagName('lastmod')[0].textContent,
    images: [...url.getElementsByTagName('image:loc')].map((el) => el.textContent)
  }));
}

function bookGraph(file = 'livro.html') {
  const json = JSON.parse(doc(file).querySelector('script[type="application/ld+json"]').textContent);
  return json['@graph'] || [json];
}

test.describe('sitemap.xml', () => {
  test('está em dia com scripts/build-sitemap.js (rode npm run build:sitemap)', () => {
    expect(read('sitemap.xml').replace(/\r\n/g, '\n')).toBe(sitemap.build());
  });

  test('lista só as páginas públicas, com a página de venda do livro', () => {
    const locs = sitemapEntries().map((e) => e.loc);
    expect(locs).toEqual([`${ORIGIN}/`, BOOK_URL]);
    for (const loc of locs) {
      expect(loc).not.toMatch(/admin|404|google[0-9a-f]+\.html|\/(functions|scripts|tests)\//);
    }
    expect(new Set(locs).size).toBe(locs.length);
  });

  test('a URL de cada página é a mesma do canonical dela', () => {
    for (const p of sitemap.pages) {
      const canonical = doc(p.file).querySelector('link[rel="canonical"]').getAttribute('href');
      expect(canonical).toBe(`${ORIGIN}${p.loc}`);
    }
  });

  test('lastmod é uma data válida e não está no futuro', () => {
    const today = new Date().toISOString().slice(0, 10);
    for (const { lastmod } of sitemapEntries()) {
      expect(lastmod).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(lastmod <= today).toBe(true);
    }
  });

  test('as páginas e as imagens listadas respondem 200', async ({ request }) => {
    for (const { loc, images } of sitemapEntries()) {
      for (const url of [loc, ...images]) {
        const res = await request.get(url.replace(ORIGIN, ''));
        expect(res.status(), url).toBe(200);
      }
    }
  });

  test('a página do livro lista a capa no sitemap de imagens', () => {
    const book = sitemapEntries().find((e) => e.loc === BOOK_URL);
    expect(book.images[0]).toBe(`${ORIGIN}/assets/images/book/livro-capa.webp`);
  });
});

test.describe('robots.txt', () => {
  test('aponta para o sitemap, libera o site e bloqueia só /admin/', async ({ request }) => {
    const res = await request.get('/robots.txt');
    expect(res.status()).toBe(200);
    const txt = await res.text();
    expect(txt).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
    const disallows = [...txt.matchAll(/^Disallow:\s*(.*)$/gm)].map((m) => m[1].trim());
    expect(new Set(disallows)).toEqual(new Set(['/admin/']));
    expect(txt).not.toMatch(/^Disallow:\s*\/\s*$/m);
  });

  test('o sitemap é servido como XML', async ({ request }) => {
    const res = await request.get('/sitemap.xml');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('xml');
  });
});

test.describe('livro.html — SEO on-page', () => {
  const d = doc('livro.html');
  const meta = (sel) => d.querySelector(sel)?.getAttribute('content');

  test('title e description falam de livro de pós-operatório, sem passar do tamanho exibido', () => {
    const title = d.title;
    expect(title).toMatch(/^Livro Pós-operatório/);
    expect(title).toContain('cirurgia plástica');
    const description = meta('meta[name="description"]');
    expect(description).toMatch(/livro/i);
    expect(description).toMatch(/pós-operatório/i);
    expect(description.length).toBeGreaterThanOrEqual(70);
    expect(description.length).toBeLessThanOrEqual(165);
  });

  test('é indexável, com canonical e Open Graph consistentes', () => {
    expect(meta('meta[name="robots"]')).not.toMatch(/noindex/);
    expect(d.querySelector('link[rel="canonical"]').getAttribute('href')).toBe(BOOK_URL);
    expect(meta('meta[property="og:url"]')).toBe(BOOK_URL);
    expect(meta('meta[property="og:type"]')).toBe('book');
    expect(meta('meta[property="og:description"]')).toBe(meta('meta[name="description"]'));
    expect(meta('meta[property="og:image"]')).toMatch(/^https:\/\//);
    expect(meta('meta[property="book:isbn"]')).toBe('9786553083547');
  });

  test('tem um único H1 com o nome do livro e H2 em cada seção', () => {
    const h1 = d.querySelectorAll('h1');
    expect(h1).toHaveLength(1);
    expect(h1[0].textContent).toBe('Pós-operatório e o raciocínio diante da cirurgia plástica');
    for (const section of d.querySelectorAll('main section[aria-labelledby]')) {
      const heading = d.getElementById(section.getAttribute('aria-labelledby'));
      expect(heading?.tagName, section.id).toMatch(/^H[12]$/);
    }
  });

  test('toda imagem tem atributo alt (vazio só quando decorativa)', () => {
    for (const img of d.querySelectorAll('img')) {
      expect(img.hasAttribute('alt'), img.getAttribute('src')).toBe(true);
    }
    expect(d.getElementById('main-image').getAttribute('alt')).toMatch(/livro/i);
  });

  test('as perguntas frequentes deixam claro o público e o que o livro não é', () => {
    const faq = d.getElementById('perguntas').textContent;
    expect(faq).toContain('estudantes e profissionais da saúde e da estética');
    expect(faq).toContain('deve seguir as orientações do seu cirurgião');
  });
});

test.describe('livro.html — dados estruturados', () => {
  const graph = bookGraph();
  const book = graph.find((n) => n['@id'] === `${BOOK_URL}#book`);

  test('Offer em BRL com o mesmo preço exibido no HTML estático', () => {
    const shown = doc('livro.html').getElementById('product-price').textContent; // "R$ 399,90"
    const shownNumber = shown.replace(/[^\d,]/g, '').replace(',', '.');
    expect(book.offers['@type']).toBe('Offer');
    expect(book.offers.priceCurrency).toBe('BRL');
    expect(book.offers.price).toBe(shownNumber);
    expect(book.offers.availability).toBe('https://schema.org/InStock');
    expect(book.offers.url).toBe(BOOK_URL);
  });

  test('BreadcrumbList e WebPage apontam para o livro', () => {
    const crumbs = graph.find((n) => n['@type'] === 'BreadcrumbList');
    expect(crumbs.itemListElement.map((i) => i.position)).toEqual([1, 2]);
    expect(crumbs.itemListElement[0].item).toBe(`${ORIGIN}/`);
    const webPage = graph.find((n) => n['@type'] === 'WebPage');
    expect(webPage.mainEntity['@id']).toBe(book['@id']);
    expect(webPage.url).toBe(BOOK_URL);
  });

  test('a página inicial declara o mesmo livro e tem link para a página de venda', () => {
    const home = doc('index.html');
    const homeGraph = JSON.parse(home.querySelector('script[type="application/ld+json"]').textContent)['@graph'];
    const homeBook = homeGraph.find((n) => n['@id'] === book['@id']);
    expect(homeBook.isbn).toBe(book.isbn);
    expect(homeBook.url).toBe(BOOK_URL);
    const links = [...home.querySelectorAll('a[href="livro.html"]')];
    expect(links.length).toBeGreaterThanOrEqual(2);
    expect(links.some((a) => /livro/i.test(a.textContent))).toBe(true);
  });

  test('o book.js atualiza preço e disponibilidade do Offer com os dados do servidor', async ({ page }) => {
    await page.route('**/.netlify/functions/bookInfo', (route) =>
      route.fulfill({
        status: 200,
        body: JSON.stringify({ title: 'Livro', price_cents: 42000, max_quantity: 3, available: false, sold_out: true, low_stock: false, pickup: null })
      })
    );
    await page.goto('/livro.html');
    await expect(page.locator('#buy')).toHaveText('Esgotado');
    const offers = await page.evaluate(() => {
      const json = JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent);
      return json['@graph'].find((n) => n.offers).offers;
    });
    expect(offers.price).toBe('420.00');
    expect(offers.availability).toBe('https://schema.org/SoldOut');
  });
});

test.describe('netlify.toml — URLs duplicadas', () => {
  test('/livro e /index.html redirecionam (301) para a URL canônica', () => {
    const toml = read('netlify.toml');
    for (const [from, to] of [['/livro', '/livro.html'], ['/index.html', '/']]) {
      const rule = new RegExp(`from = "${from.replace('.', '\\.')}"\\s+to = "${to.replace('.', '\\.')}"\\s+status = 301\\s+force = true`);
      expect(toml).toMatch(rule);
    }
  });
});
