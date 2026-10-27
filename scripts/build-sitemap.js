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
  {
    loc: '/',
    priority: '1.0',
    changefreq: 'monthly',
    image: {
      loc: '/assets/images/nagila-hero.png',
      title: 'Nágila Bernarda Zortéa — Esteticista e Coordenadora URI Erechim, NZ Beauty Clinic, Erechim/RS'
    }
  },
  {
    loc: '/livro.html',
    priority: '0.8',
    changefreq: 'monthly',
    image: {
      loc: '/assets/images/book/book-capa-contracapa.jpg',
      title: 'Capa e contracapa do livro Pós-operatório e o raciocínio diante da cirurgia plástica'
    }
  }
];

const TODAY = new Date().toISOString().slice(0, 10);

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${pages
  .map(
    (p) => `  <url>
    <loc>${ORIGIN}${p.loc}</loc>
    <lastmod>${TODAY}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
    <image:image>
      <image:loc>${ORIGIN}${p.image.loc}</image:loc>
      <image:title>${p.image.title}</image:title>
    </image:image>
  </url>`,
  )
  .join('\n')}
</urlset>`;

fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), xml, 'utf8');
console.log('sitemap.xml gerado com sucesso.');
