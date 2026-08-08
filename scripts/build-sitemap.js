#!/usr/bin/env node
/*
 * Gera sitemap.xml a partir dos dados do projeto.
 * Execute: npm run build
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const profile = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/profile.json'), 'utf8'));

const ORIGIN = profile.site.origin;
const LASTMOD = profile.site.lastmod;

const pages = [
  { loc: '/', priority: '1.0', changefreq: 'monthly' },
  { loc: '/#sobre', priority: '0.9', changefreq: 'monthly' },
  { loc: '/#docencia', priority: '0.8', changefreq: 'monthly' },
  { loc: '/#publicacoes', priority: '0.8', changefreq: 'monthly' },
  { loc: '/#palestras', priority: '0.8', changefreq: 'monthly' },
  { loc: '/#clinica', priority: '0.9', changefreq: 'monthly' },
  { loc: '/#contato', priority: '0.7', changefreq: 'monthly' },
  { loc: '/artigos/', priority: '0.6', changefreq: 'weekly' },
];

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${pages
  .map(
    (p) => `  <url>
    <loc>${ORIGIN}${p.loc}</loc>
    <lastmod>${LASTMOD}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`,
  )
  .join('\n')}
</urlset>`;

fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), xml, 'utf8');
console.log('sitemap.xml gerado com sucesso.');
