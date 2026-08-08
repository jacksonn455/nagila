#!/usr/bin/env node
/*
 * Verifica se os links externos referenciados nos arquivos de dados estão acessíveis.
 * Execute: npm run check:links
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function checkUrl(url) {
  return new Promise((resolve) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { timeout: 10000 }, (res) => {
      resolve({ url, status: res.statusCode, ok: res.statusCode < 400 });
    });
    req.on('error', (err) => resolve({ url, status: 0, ok: false, error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ url, status: 0, ok: false, error: 'timeout' });
    });
  });
}

function extractUrls(obj) {
  const urls = [];
  const seen = new Set();
  function walk(val) {
    if (typeof val === 'string' && /^https?:\/\//.test(val)) {
      const clean = val.split('#')[0];
      if (!seen.has(clean)) {
        seen.add(clean);
        urls.push(clean);
      }
    } else if (Array.isArray(val)) {
      val.forEach(walk);
    } else if (val && typeof val === 'object') {
      Object.values(val).forEach(walk);
    }
  }
  walk(obj);
  return urls;
}

async function main() {
  const dataDir = path.join(ROOT, 'data');
  const files = fs.readdirSync(dataDir).filter((f) => f.endsWith('.json'));
  const allUrls = new Set();

  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
    extractUrls(data).forEach((u) => allUrls.add(u));
  }

  const urls = [...allUrls].filter((u) => !u.includes('nagilazortea.com.br'));
  console.log(`Verificando ${urls.length} links externos...\n`);

  let errors = 0;
  for (const url of urls) {
    const result = await checkUrl(url);
    const icon = result.ok ? '✓' : '✗';
    console.log(`${icon} ${result.status || result.error} — ${result.url}`);
    if (!result.ok) errors++;
  }

  console.log(`\n${errors === 0 ? 'Todos os links OK.' : `${errors} link(s) com problema.`}`);
  if (errors > 0) process.exit(1);
}

main();
