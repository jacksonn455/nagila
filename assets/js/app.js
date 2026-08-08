/* ==========================================================================
   Nágila Bernarda Zortéa — Portfolio
   app.js · Vanilla JS, sem dependências
   ========================================================================== */

'use strict';

const SUPPORTED = ['pt', 'en', 'es'];
const FALLBACK = 'pt';
const STORE_LANG = 'preferredLanguage';
const STORE_THEME = 'nz-preferred-theme';

const HAS_MARKUP = /[<&]/;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* --------------------------------------------------------------------------
   i18n — Português como idioma padrão (embutido no HTML).
   en/es vêm de <script type="application/json" data-i18n-bundle="...">.
   -------------------------------------------------------------------------- */
const I18n = {
  dict: {},
  lang: FALLBACK,
  base: Object.create(null),
  bundles: Object.create(null),

  snapshot() {
    $$('[data-i18n]').forEach((el) => {
      const key = el.dataset.i18n;
      if (!(key in this.base)) this.base[key] = el.innerHTML;
    });
    $$('[data-i18n-attr]').forEach((el) => {
      el.dataset.i18nAttr.split(',').forEach((pair) => {
        const [attr, key] = pair.split(':').map((s) => s.trim());
        if (!attr || !key || key in this.base) return;
        const current = el.getAttribute(attr);
        if (current != null) this.base[key] = current;
      });
    });
    this.base.metaTitle = document.title;
    const descEl = $('meta[name="description"]');
    if (descEl) this.base.metaDescription = descEl.getAttribute('content');
  },

  readBundles() {
    $$('script[data-i18n-bundle]').forEach((tag) => {
      const lang = tag.dataset.i18nBundle;
      try {
        this.bundles[lang] = JSON.parse(tag.textContent);
      } catch (err) {
        console.error(`i18n: bundle "${lang}" inválido`, err);
      }
    });
  },

  detect() {
    const fromQuery = new URLSearchParams(location.search).get('lang');
    if (SUPPORTED.includes(fromQuery)) return fromQuery;
    let saved = null;
    try {
      saved = localStorage.getItem(STORE_LANG);
    } catch {
      /* modo privado */
    }
    if (SUPPORTED.includes(saved)) return saved;
    for (const tag of navigator.languages || [navigator.language || '']) {
      const base = String(tag).toLowerCase().split('-')[0];
      if (SUPPORTED.includes(base)) return base;
    }
    return FALLBACK;
  },

  get(key, dict = this.dict) {
    return key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), dict);
  },

  t(key) {
    const value = this.get(key);
    if (value != null) return value;
    return key in this.base ? this.base[key] : null;
  },

  apply() {
    $$('[data-i18n]').forEach((el) => {
      const value = this.t(el.dataset.i18n);
      if (value == null) return;
      if (HAS_MARKUP.test(value)) el.innerHTML = value;
      else if (el.textContent !== value) el.textContent = value;
    });

    $$('[data-i18n-attr]').forEach((el) => {
      el.dataset.i18nAttr.split(',').forEach((pair) => {
        const [attr, key] = pair.split(':').map((s) => s.trim());
        if (!attr || !key) return;
        const value = this.t(key);
        if (value != null) el.setAttribute(attr, value);
      });
    });

    document.documentElement.lang = this.lang === 'pt' ? 'pt-BR' : this.lang;

    const title = this.t('metaTitle');
    if (title) document.title = title;

    const desc = this.t('metaDescription');
    const descEl = $('meta[name="description"]');
    if (desc && descEl) descEl.setAttribute('content', desc);

    $$('[data-lang-option]').forEach((btn) => {
      btn.setAttribute('aria-current', String(btn.dataset.langOption === this.lang));
    });

    document.dispatchEvent(new CustomEvent('languagechange', { detail: this.lang }));
  },

  set(lang, persist = true) {
    if (!SUPPORTED.includes(lang)) lang = FALLBACK;
    this.dict = lang === FALLBACK ? {} : this.bundles[lang] || {};
    this.lang = lang;
    if (persist) {
      try {
        localStorage.setItem(STORE_LANG, lang);
      } catch {
        /* modo privado */
      }
    }
    this.apply();
  },

  init() {
    this.snapshot();
    this.readBundles();
    this.set(this.detect(), false);
    $$('[data-lang-option]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.set(btn.dataset.langOption);
        LangMenu.close();
      });
    });
  },
};

/* --------------------------------------------------------------------------
   Menu de idiomas
   -------------------------------------------------------------------------- */
const LangMenu = {
  init() {
    this.btn = $('[data-lang-toggle]');
    this.menu = $('[data-lang-menu]');
    if (!this.btn || !this.menu) return;

    this.btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.menu.hidden ? this.open() : this.close();
    });

    document.addEventListener('click', (e) => {
      if (!this.menu.hidden && !this.menu.contains(e.target)) this.close();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.menu.hidden) {
        this.close();
        this.btn.focus();
      }
    });
  },

  open() {
    if (!this.menu) return;
    this.menu.hidden = false;
    this.btn.setAttribute('aria-expanded', 'true');
  },

  close() {
    if (!this.menu || this.menu.hidden) return;
    this.menu.hidden = true;
    this.btn.setAttribute('aria-expanded', 'false');
  },
};

/* --------------------------------------------------------------------------
   Tema (Dark / Light / Sistema)
   -------------------------------------------------------------------------- */
const ThemeManager = (() => {
  const html = document.documentElement;

  function getStored() {
    try {
      return localStorage.getItem(STORE_THEME);
    } catch {
      return null;
    }
  }

  function setStored(value) {
    try {
      if (value) {
        localStorage.setItem(STORE_THEME, value);
      } else {
        localStorage.removeItem(STORE_THEME);
      }
    } catch {}
  }

  function getCurrent() {
    const stored = getStored();
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function apply(theme) {
    if (theme === 'light' || theme === 'dark') {
      html.dataset.theme = theme;
    } else {
      delete html.dataset.theme;
    }
    updateToggleIcons(theme || getCurrent());
  }

  function toggle() {
    const current = getCurrent();
    const next = current === 'dark' ? 'light' : 'dark';
    setStored(next);
    apply(next);
  }

  function updateToggleIcons(active) {
    document.querySelectorAll('[data-theme-icon]').forEach((el) => {
      const icon = el.dataset.themeIcon;
      el.style.display = icon === active ? 'none' : '';
    });
    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
      btn.setAttribute(
        'aria-label',
        active === 'dark' ? 'Ativar modo claro' : 'Ativar modo escuro',
      );
    });
  }

  function init() {
    const stored = getStored();
    apply(stored || null);

    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
      btn.addEventListener('click', toggle);
    });

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!getStored()) apply(e.matches ? 'dark' : 'light');
    });
  }

  return { init, getCurrent, toggle };
})();

/* --------------------------------------------------------------------------
   Navegação Mobile
   -------------------------------------------------------------------------- */
const NavManager = (() => {
  function init() {
    const toggle = document.querySelector('[data-nav-toggle]');
    const menu = document.querySelector('[data-nav-menu]');
    if (!toggle || !menu) return;

    function openMenu() {
      menu.classList.add('is-open');
      toggle.setAttribute('aria-expanded', 'true');
    }

    function closeMenu() {
      menu.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
    }

    toggle.addEventListener('click', () => {
      const isOpen = menu.classList.contains('is-open');
      isOpen ? closeMenu() : openMenu();
    });

    // Fecha ao clicar em link do menu
    menu.querySelectorAll('a[href]').forEach((link) => {
      link.addEventListener('click', closeMenu);
    });

    // Fecha com Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMenu();
    });

    // Fecha ao clicar fora
    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target) && !toggle.contains(e.target)) closeMenu();
    });
  }

  return { init };
})();

/* --------------------------------------------------------------------------
   Active Nav Link (scroll spy)
   -------------------------------------------------------------------------- */
const ScrollSpy = (() => {
  function init() {
    const sections = document.querySelectorAll('section[id]');
    const links = document.querySelectorAll('.site-nav__link[href^="#"]');
    if (!sections.length || !links.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const id = entry.target.id;
            links.forEach((link) => {
              const href = link.getAttribute('href');
              const active = href === `#${id}`;
              link.setAttribute('aria-current', active ? 'true' : 'false');
            });
          }
        });
      },
      { rootMargin: '-40% 0px -50% 0px' },
    );

    sections.forEach((s) => observer.observe(s));
  }

  return { init };
})();

/* --------------------------------------------------------------------------
   Scroll Reveal
   -------------------------------------------------------------------------- */
const RevealManager = (() => {
  function init() {
    const els = document.querySelectorAll('[data-reveal]');
    if (!els.length) return;

    // Respeitar prefers-reduced-motion
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      els.forEach((el) => el.setAttribute('data-reveal', 'visible'));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.setAttribute('data-reveal', 'visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.08 },
    );

    els.forEach((el) => observer.observe(el));
  }

  return { init };
})();

/* --------------------------------------------------------------------------
   FAQ Accordion
   -------------------------------------------------------------------------- */
const FaqManager = (() => {
  function init() {
    document.querySelectorAll('.faq-item__trigger').forEach((trigger) => {
      trigger.addEventListener('click', () => {
        const item = trigger.closest('.faq-item');
        const isOpen = item.dataset.open === 'true';

        // Fecha todos
        document.querySelectorAll('.faq-item').forEach((i) => {
          i.dataset.open = 'false';
          i.querySelector('.faq-item__trigger').setAttribute('aria-expanded', 'false');
        });

        // Abre o clicado (se estava fechado)
        if (!isOpen) {
          item.dataset.open = 'true';
          trigger.setAttribute('aria-expanded', 'true');
        }
      });
    });
  }

  return { init };
})();

/* --------------------------------------------------------------------------
   Smooth scroll para links âncora
   -------------------------------------------------------------------------- */
function initSmoothScroll() {
  document.querySelectorAll('a[href^="#"]').forEach((link) => {
    link.addEventListener('click', (e) => {
      const id = link.getAttribute('href').slice(1);
      const target = id ? document.getElementById(id) : null;
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // Atualiza hash sem scroll adicional
        history.pushState(null, '', `#${id}`);
      }
    });
  });
}

/* --------------------------------------------------------------------------
   Init
   -------------------------------------------------------------------------- */
document.addEventListener('DOMContentLoaded', () => {
  I18n.init();
  LangMenu.init();
  ThemeManager.init();
  NavManager.init();
  ScrollSpy.init();
  RevealManager.init();
  FaqManager.init();
  initSmoothScroll();
});
