// @ts-check
/**
 * Testes de overflow horizontal mobile — Nágila Bernarda Zortéa
 *
 * Verifica que nenhuma largura de viewport gera scroll horizontal.
 * Requer browser instalado: npx playwright install chromium
 */
const { test, expect } = require('@playwright/test');

/** @type {Array<{label: string, width: number, height: number}>} */
const VIEWPORTS = [
  { label: '320px (mobile pequeno)', width: 320, height: 800 },
  { label: '375px (iPhone SE)', width: 375, height: 812 },
  { label: '390px (iPhone 14)', width: 390, height: 844 },
  { label: '430px (iPhone 14 Plus)', width: 430, height: 932 },
  { label: '768px (tablet)', width: 768, height: 1024 },
  { label: '1280px (desktop)', width: 1280, height: 800 },
  { label: '1440px (desktop wide)', width: 1440, height: 900 },
];

/* --------------------------------------------------------------------------
   Utilitário — verifica scrollWidth vs. innerWidth
   -------------------------------------------------------------------------- */
async function checkNoHorizontalScroll(page, viewportWidth) {
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(
    scrollWidth,
    `scrollWidth=${scrollWidth} excede innerWidth=${viewportWidth}`,
  ).toBeLessThanOrEqual(viewportWidth + 1);
}

/* --------------------------------------------------------------------------
   Utilitário — encontra elementos que extravasam a viewport horizontalmente.
   Exclui: position:fixed, display:none, elementos zero-size, e o hero
   (que tem overflow:hidden intencional).
   -------------------------------------------------------------------------- */
async function findOverflowingElements(page) {
  return page.evaluate(() => {
    const iw = window.innerWidth;
    return [...document.querySelectorAll('main section *')]
      .filter((el) => {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (style.position === 'fixed' || style.position === 'sticky') return false;
        /* Ignora elementos cujo ancestral tem overflow:hidden (ex: .hero) */
        let ancestor = el.parentElement;
        while (ancestor && ancestor !== document.body) {
          const aStyle = window.getComputedStyle(ancestor);
          if (aStyle.overflowX === 'hidden' || aStyle.overflowX === 'clip') return false;
          ancestor = ancestor.parentElement;
        }
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        return rect.right > iw + 2 || rect.left < -2;
      })
      .map((el) => ({
        tag: el.tagName,
        cls: String(el.className || '').slice(0, 60),
        right: Math.round(el.getBoundingClientRect().right),
        left: Math.round(el.getBoundingClientRect().left),
        innerWidth: iw,
      }))
      .slice(0, 8);
  });
}

/* --------------------------------------------------------------------------
   Bloco 1 — scrollWidth em cada viewport (página carregada, menu fechado)
   -------------------------------------------------------------------------- */
for (const { label, width, height } of VIEWPORTS) {
  test(`Sem overflow horizontal — ${label}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    await checkNoHorizontalScroll(page, width);

    const overflowing = await findOverflowingElements(page);
    expect(
      overflowing,
      `Elementos extravasando em ${width}px: ${JSON.stringify(overflowing, null, 2)}`,
    ).toHaveLength(0);
  });
}

/* --------------------------------------------------------------------------
   Bloco 2 — menu mobile aberto não deve gerar overflow
   -------------------------------------------------------------------------- */
const MOBILE_VIEWPORTS = VIEWPORTS.filter((v) => v.width < 768);

for (const { label, width, height } of MOBILE_VIEWPORTS) {
  test(`Menu mobile aberto sem overflow — ${label}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    /* Abre o menu hamburger */
    await page.click('[data-nav-toggle]');
    await page.waitForTimeout(150); /* aguarda transição */

    await checkNoHorizontalScroll(page, width);
  });
}

/* --------------------------------------------------------------------------
   Bloco 3 — seção específica de livros (causa principal identificada)
   -------------------------------------------------------------------------- */
test('Seção de livros sem overflow em 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');

  await page.locator('#livros').scrollIntoViewIfNeeded();

  await checkNoHorizontalScroll(page, 320);
});

test('Seção de livros sem overflow em 375px', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');

  await page.locator('#livros').scrollIntoViewIfNeeded();

  await checkNoHorizontalScroll(page, 375);
});

/* --------------------------------------------------------------------------
   Bloco 4 — seção de palestras (conteúdo longo)
   -------------------------------------------------------------------------- */
for (const { label, width, height } of MOBILE_VIEWPORTS) {
  test(`Seção de palestras sem overflow — ${label}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    await page.locator('#palestras').scrollIntoViewIfNeeded();

    await checkNoHorizontalScroll(page, width);
  });
}

/* --------------------------------------------------------------------------
   Bloco 5 — troca de idioma não deve gerar overflow
   -------------------------------------------------------------------------- */
for (const lang of ['en', 'es']) {
  test(`Idioma ${lang} sem overflow em 375px`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/?lang=${lang}`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(300); /* aguarda aplicação do idioma */

    await checkNoHorizontalScroll(page, 375);
  });
}

/* --------------------------------------------------------------------------
   Bloco 6 — desktop não deve ter regressão
   -------------------------------------------------------------------------- */
test('Desktop 1280px sem overflow após correções mobile', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');

  await checkNoHorizontalScroll(page, 1280);
});
