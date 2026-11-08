#!/usr/bin/env node
/*
 * Gera sitemap.xml a partir dos dados do projeto.
 * Execute: npm run build:sitemap         (grava sitemap.xml)
 *          npm run check:sitemap         (só confere: falha se sitemap.xml estiver desatualizado)
 *
 * - Só entram páginas públicas e indexáveis. /admin/, 404.html, o arquivo de verificação do
 *   Google e as rotas internas (/functions, /scripts, /tests) ficam de fora.
 * - lastmod = data do último commit do arquivo da página; se ele tiver alterações ainda não
 *   commitadas, a data de hoje. Assim o lastmod muda só quando a página muda (o Google
 *   ignora lastmod que muda a cada build sem a página mudar).
 * - changefreq e priority são ignorados pelo Google; ficam por compatibilidade com outros
 *   buscadores, com a página de venda do livro em destaque.
 * - Sitemap de imagens: só image:loc (image:title/caption foram descontinuados pelo Google).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'sitemap.xml');
const profile = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/profile.json'), 'utf8'));

const ORIGIN = profile.site.origin;

const pages = [
  {
    loc: '/',
    file: 'index.html',
    priority: '0.8',
    changefreq: 'monthly',
    images: ['/assets/images/nagila-hero.png', '/assets/images/nagila-com-livro.webp'],
  },
  {
    // Página de venda do livro: destino principal das buscas por livro de pós-operatório
    loc: '/livro.html',
    file: 'livro.html',
    priority: '1.0',
    changefreq: 'weekly',
    images: [
      '/assets/images/book/livro-capa.webp',
      '/assets/images/book/livro-capa-retrato.webp',
      '/assets/images/book/book-capa-contracapa.webp',
      '/assets/images/book/livro-og.webp',
      '/assets/images/book/livro-miolo-meias.webp',
      '/assets/images/book/livro-miolo-ilib.webp',
      '/assets/images/book/livro-miolo-lipo.webp',
    ],
  },
];

const escapeXml = (s) =>
  String(s).replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c],
  );

function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

const today = () => new Date().toISOString().slice(0, 10);

// Data da última alteração real da página (AAAA-MM-DD)
function lastModified(file) {
  if (git(['status', '--porcelain', '--', file])) return today();
  const committed = git(['log', '-1', '--format=%cs', '--', file]);
  if (/^\d{4}-\d{2}-\d{2}$/.test(committed)) return committed;
  return fs.statSync(path.join(ROOT, file)).mtime.toISOString().slice(0, 10);
}

function build() {
  for (const p of pages) {
    for (const img of p.images) {
      if (!fs.existsSync(path.join(ROOT, img)))
        throw new Error(`Imagem do sitemap não existe: ${img}`);
    }
  }
  const urls = pages
    .map((p) => {
      const images = p.images
        .map(
          (img) =>
            `    <image:image>\n      <image:loc>${escapeXml(ORIGIN + img)}</image:loc>\n    </image:image>`,
        )
        .join('\n');
      return `  <url>
    <loc>${escapeXml(ORIGIN + p.loc)}</loc>
    <lastmod>${lastModified(p.file)}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
${images}
  </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${urls}
</urlset>
`;
}

module.exports = { pages, build, ORIGIN };

if (require.main === module) {
  const xml = build();
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
    if (current !== xml) {
      console.error('sitemap.xml desatualizado. Rode: npm run build:sitemap');
      process.exit(1);
    }
    console.log('sitemap.xml em dia.');
  } else {
    fs.writeFileSync(OUT, xml, 'utf8');
    console.log('sitemap.xml gerado com sucesso.');
  }
}
