// @ts-check
/**
 * Testes de dados estruturados Schema.org/Event — Nágila Bernarda Zortéa
 *
 * Verifica que cada Event no JSON-LD contém os campos recomendados
 * pelo Google Search Console: image, eventStatus, organizer e offers.
 */
const { test, expect } = require('@playwright/test');

const ABSOLUTE_URL_RE = /^https?:\/\/.+/;

const VALID_EVENT_STATUS = [
  'https://schema.org/EventScheduled',
  'https://schema.org/EventCancelled',
  'https://schema.org/EventPostponed',
  'https://schema.org/EventMovedOnline',
  'https://schema.org/EventRescheduled',
];

/**
 * Extrai todos os nós @type "Event" do JSON-LD da página.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<Record<string, any>[]>}
 */
async function extractEvents(page) {
  return page.evaluate(() => {
    const scripts = Array.from(
      document.querySelectorAll('script[type="application/ld+json"]'),
    );
    /** @type {any[]} */
    const events = [];
    for (const script of scripts) {
      let parsed;
      try {
        parsed = JSON.parse(script.textContent || '');
      } catch {
        continue;
      }
      const graph = parsed['@graph'] || [parsed];
      for (const node of graph) {
        if (node['@type'] === 'Event') events.push(node);
      }
    }
    return events;
  });
}

test.describe('JSON-LD Event — campos recomendados Google Search Console', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
  });

  test('encontra pelo menos 2 eventos no JSON-LD', async ({ page }) => {
    const events = await extractEvents(page);
    expect(events.length, 'Esperado ao menos 2 eventos Schema.org/Event').toBeGreaterThanOrEqual(2);
  });

  test('campos básicos — name, startDate e location não nulos', async ({ page }) => {
    const events = await extractEvents(page);
    for (const ev of events) {
      expect(ev.name, `"name" ausente`).toBeTruthy();
      expect(ev.startDate, `Evento "${ev.name}": "startDate" ausente`).toBeTruthy();
      expect(ev.location, `Evento "${ev.name}": "location" ausente`).toBeTruthy();
    }
  });

  test('image — presente, array com ao menos uma URL absoluta', async ({ page }) => {
    const events = await extractEvents(page);
    for (const ev of events) {
      expect(ev.image, `Evento "${ev.name}": "image" ausente`).toBeDefined();
      expect(Array.isArray(ev.image), `Evento "${ev.name}": "image" deve ser array`).toBe(true);
      expect(ev.image.length, `Evento "${ev.name}": "image" está vazio`).toBeGreaterThan(0);
      for (const url of ev.image) {
        expect(typeof url).toBe('string');
        expect(url, `Evento "${ev.name}": URL de imagem deve ser absoluta`).toMatch(ABSOLUTE_URL_RE);
      }
    }
  });

  test('eventStatus — presente com valor Schema.org válido', async ({ page }) => {
    const events = await extractEvents(page);
    for (const ev of events) {
      expect(ev.eventStatus, `Evento "${ev.name}": "eventStatus" ausente`).toBeDefined();
      expect(
        VALID_EVENT_STATUS.includes(ev.eventStatus),
        `Evento "${ev.name}": "eventStatus" inválido — "${ev.eventStatus}"`,
      ).toBe(true);
    }
  });

  test('organizer — presente com @type e name não vazios', async ({ page }) => {
    const events = await extractEvents(page);
    for (const ev of events) {
      expect(ev.organizer, `Evento "${ev.name}": "organizer" ausente`).toBeDefined();
      expect(
        ev.organizer['@type'],
        `Evento "${ev.name}": "organizer" deve ter "@type"`,
      ).toBeTruthy();
      expect(
        typeof ev.organizer.name === 'string' && ev.organizer.name.length > 0,
        `Evento "${ev.name}": "organizer.name" deve ser string não vazia`,
      ).toBe(true);
    }
  });

  test('offers — presente com @type, priceCurrency e availability válidos', async ({ page }) => {
    const events = await extractEvents(page);
    for (const ev of events) {
      expect(ev.offers, `Evento "${ev.name}": "offers" ausente`).toBeDefined();
      expect(
        ev.offers['@type'],
        `Evento "${ev.name}": "offers" deve ter "@type"`,
      ).toBeTruthy();
      expect(
        typeof ev.offers.priceCurrency === 'string' && ev.offers.priceCurrency.length > 0,
        `Evento "${ev.name}": "offers.priceCurrency" deve ser string não vazia`,
      ).toBe(true);
      expect(
        typeof ev.offers.availability === 'string' &&
          ev.offers.availability.startsWith('https://schema.org/'),
        `Evento "${ev.name}": "offers.availability" deve ser URL Schema.org`,
      ).toBe(true);
    }
  });

  test('nenhum campo obrigatório é undefined ou null', async ({ page }) => {
    const events = await extractEvents(page);
    const required = ['name', 'startDate', 'location', 'image', 'eventStatus', 'organizer', 'offers'];
    for (const ev of events) {
      for (const field of required) {
        expect(
          ev[field] !== undefined && ev[field] !== null,
          `Evento "${ev.name}": campo "${field}" é undefined ou null`,
        ).toBe(true);
      }
    }
  });

  test('offers.url — quando presente deve ser URL absoluta', async ({ page }) => {
    const events = await extractEvents(page);
    for (const ev of events) {
      if (ev.offers && ev.offers.url != null) {
        expect(
          ev.offers.url,
          `Evento "${ev.name}": "offers.url" deve ser URL absoluta`,
        ).toMatch(ABSOLUTE_URL_RE);
      }
    }
  });

  test('organizer.url — quando presente deve ser URL absoluta', async ({ page }) => {
    const events = await extractEvents(page);
    for (const ev of events) {
      if (ev.organizer && ev.organizer.url != null) {
        expect(
          ev.organizer.url,
          `Evento "${ev.name}": "organizer.url" deve ser URL absoluta`,
        ).toMatch(ABSOLUTE_URL_RE);
      }
    }
  });
});
