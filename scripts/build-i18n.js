#!/usr/bin/env node
/*
 * Torna index.html autossuficiente para i18n:
 *
 *  1. Preenche todo [data-i18n] / [data-i18n-attr] com o texto de pt.json.
 *     O português está no HTML: página renderiza completa sem JavaScript,
 *     buscadores veem o conteúdo real e o Google indexa o idioma principal.
 *
 *  2. Embute en.json e es.json em <script type="application/json">.
 *     Sem fetch: troca de idioma funciona em file://, offline e sob CSP.
 *
 * Idempotente — pode rodar quantas vezes quiser.  npm run build
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'index.html');
const START = '<!-- i18n:bundles:start -->';
const END = '<!-- i18n:bundles:end -->';

const read = (lang) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, `assets/i18n/${lang}.json`), 'utf8'));

const get = (dict, key) => key.split('.').reduce((a, p) => (a == null ? a : a[p]), dict);

const pt = read('pt');
let source = fs.readFileSync(HTML, 'utf8');

/* ---------- 1. conteúdo em português direto no HTML ---------- */
const dom = new JSDOM(source);
const D = dom.window.document;

let filled = 0;
const missing = [];

D.querySelectorAll('[data-i18n]').forEach((el) => {
  const key = el.getAttribute('data-i18n');
  const value = get(pt, key);
  if (value == null) {
    missing.push(key);
    return;
  }
  if (el.innerHTML !== value) {
    el.innerHTML = value;
    filled++;
  }
});

D.querySelectorAll('[data-i18n-attr]').forEach((el) => {
  el.getAttribute('data-i18n-attr')
    .split(',')
    .forEach((pair) => {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (!attr || !key) return;
      const value = get(pt, key);
      if (value == null) {
        missing.push(key);
        return;
      }
      if (el.getAttribute(attr) !== value) {
        el.setAttribute(attr, value);
        filled++;
      }
    });
});

if (pt.metaTitle) D.title = pt.metaTitle;
const descEl = D.querySelector('meta[name="description"]');
if (descEl && pt.metaDescription) descEl.setAttribute('content', pt.metaDescription);

D.querySelectorAll('link[rel="preload"][href*="i18n"]').forEach((l) => l.remove());

/* Normaliza atributos booleanos que o jsdom reserializa como `attr=""` */
const BOOLEAN_ATTRS = [
  'allowfullscreen',
  'async',
  'autofocus',
  'autoplay',
  'checked',
  'controls',
  'crossorigin',
  'default',
  'defer',
  'disabled',
  'download',
  'formnovalidate',
  'hidden',
  'ismap',
  'itemscope',
  'loop',
  'multiple',
  'muted',
  'nomodule',
  'novalidate',
  'open',
  'playsinline',
  'readonly',
  'required',
  'reversed',
  'selected',
];

source = '<!DOCTYPE html>\n' + D.documentElement.outerHTML;
source =
  source
    .replace(new RegExp(`\\s(${BOOLEAN_ATTRS.join('|')})=""`, 'g'), ' $1')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd() + '\n';

/* ---------- 2. bundles en/es embutidos ---------- */
const bundles = ['en', 'es']
  .map((lang) => {
    const json = JSON.stringify(read(lang)).replace(/</g, '\\u003c');
    return `  <script type="application/json" data-i18n-bundle="${lang}">${json}</script>`;
  })
  .join('\n');

const block = `${START}\n${bundles}\n  ${END}`;

if (source.includes(START)) {
  source = source.replace(new RegExp(`${START}[\\s\\S]*?${END}`), () => block);
} else {
  const anchor = /([ \t]*)<script\b[^>]*\bsrc="assets\/js\/app\.js"[^>]*><\/script>/;
  if (!anchor.test(source)) {
    console.error('ERRO: não encontrei a tag de app.js para ancorar os bundles.');
    process.exit(1);
  }
  source = source.replace(anchor, (tag, indent) => `${indent}${block}\n${indent}${tag.trim()}`);
}

const injected = (source.match(/data-i18n-bundle="/g) || []).length;
if (injected !== 2) {
  console.error(`ERRO: esperava 2 bundles embutidos, encontrei ${injected}.`);
  process.exit(1);
}

fs.writeFileSync(HTML, source);

const size = Buffer.byteLength(source) / 1024;
console.log(`index.html: ${filled} valor(es) preenchido(s) a partir de pt.json`);
console.log(`bundles en/es embutidos — arquivo agora com ${size.toFixed(1)} KB`);
if (missing.length) {
  console.error(`\nCHAVES AUSENTES em pt.json: ${[...new Set(missing)].join(', ')}`);
  process.exit(1);
}
