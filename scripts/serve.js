#!/usr/bin/env node
/* Servidor estático mínimo para desenvolvimento local.
   Espelha o comportamento do GitHub Pages: gzip automático, 404 customizado. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 4173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

http
  .createServer((req, res) => {
    const url = decodeURI(req.url.split('?')[0]);
    let file = path.join(ROOT, url === '/' ? 'index.html' : url);

    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      file = path.join(file, 'index.html');
    }
    if (!fs.existsSync(file)) {
      const custom404 = path.join(ROOT, '404.html');
      if (fs.existsSync(custom404)) {
        res.writeHead(404, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' });
        fs.createReadStream(custom404).pipe(res);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404 ' + url);
      return;
    }

    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache' };

    const compressible = /^(text\/|application\/(json|xml|javascript))/.test(type);
    const accepts = req.headers['accept-encoding'] || '';

    if (compressible && /\bgzip\b/.test(accepts)) {
      headers['Content-Encoding'] = 'gzip';
      headers.Vary = 'Accept-Encoding';
      res.writeHead(200, headers);
      fs.createReadStream(file).pipe(zlib.createGzip()).pipe(res);
      return;
    }

    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, () => {
    console.log(`\n  Servidor rodando em http://localhost:${PORT}\n`);
  });
