/* Autenticação da área administrativa (um único administrador).

 Variáveis de ambiente (criadas no Netlify, nunca no código):
 - ADMIN_EMAIL           e-mail de login
 - ADMIN_PASSWORD_HASH   "scrypt:N:r:p:salt:hash" — gerado por scripts/generate-admin-hash.js
 - ADMIN_SESSION_SECRET  32+ caracteres aleatórios; assina a sessão e os hashes de tentativas

 Sessão: cookie __Host- assinado (HMAC-SHA256), HttpOnly, Secure, SameSite=Strict,
 8 h, sem dados pessoais. A chave do HMAC deriva do segredo e do hash da senha:
 trocar qualquer um dos dois invalida todas as sessões.
 Nada aqui registra senha, cookie, e-mail ou IP em log.
*/

const crypto = require('crypto');
const { sb } = require('./supabase');

const COOKIE_NAME = '__Host-nz_admin';
const SESSION_TTL_SECONDS = 8 * 3600;
const CSRF_HEADER = 'x-admin-request';

// Força bruta: 5 falhas em 15 min bloqueiam; repetir aumenta o bloqueio
const ATTEMPT_WINDOWS = [
  { failures: 5, windowMinutes: 15, lockMinutes: 15 },
  { failures: 10, windowMinutes: 24 * 60, lockMinutes: 60 },
  { failures: 20, windowMinutes: 24 * 60, lockMinutes: 24 * 60 }
];

const ADMIN_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow'
};

function adminJson(statusCode, body, extraHeaders = {}) {
  return { statusCode, headers: { ...ADMIN_HEADERS, ...extraHeaders }, body: JSON.stringify(body) };
}

const unauthorized = () => adminJson(401, { error: 'Sessão expirada. Entre novamente.' });

/* ---------- configuração ---------- */

function adminConfig() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const passwordHash = (process.env.ADMIN_PASSWORD_HASH || '').trim();
  const secret = process.env.ADMIN_SESSION_SECRET || '';
  const parsed = parseHash(passwordHash);
  if (!email || !parsed || secret.length < 32) return null;
  return { email, passwordHash, parsed, secret };
}

/* ---------- senha (scrypt) ---------- */

const SCRYPT_LIMITS = { minN: 2 ** 10, maxN: 2 ** 20 };

function parseHash(value) {
  const parts = String(value).split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], 'base64url');
  const hash = Buffer.from(parts[5], 'base64url');
  const powerOfTwo = Number.isInteger(N) && (N & (N - 1)) === 0;
  if (!powerOfTwo || N < SCRYPT_LIMITS.minN || N > SCRYPT_LIMITS.maxN) return null;
  if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 4) return null;
  if (salt.length < 16 || hash.length < 32) return null;
  return { N, r, p, salt, hash };
}

function scrypt(password, salt, { N, r, p }, keylen) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, keylen, { N, r, p, maxmem: 256 * N * r + 32 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key)
    );
  });
}

async function hashPassword(password, { N = 2 ** 15, r = 8, p = 1 } = {}) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, { N, r, p }, 32);
  return `scrypt:${N}:${r}:${p}:${salt.toString('base64url')}:${hash.toString('base64url')}`;
}

function safeEqual(a, b) {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Compara e-mail e senha sem revelar qual errou (o scrypt roda sempre)
async function checkCredentials(config, email, password) {
  const digest = (v) => crypto.createHmac('sha256', config.secret).update(String(v).trim().toLowerCase()).digest();
  const emailOk = safeEqual(digest(email), digest(config.email));
  const candidate = await scrypt(password, config.parsed.salt, config.parsed, config.parsed.hash.length);
  const passwordOk = safeEqual(candidate, config.parsed.hash);
  return emailOk && passwordOk;
}

/* ---------- sessão ---------- */

function sessionKey(config) {
  return crypto.createHmac('sha256', config.secret).update(`session:${config.passwordHash}`).digest();
}

function sign(config, payload) {
  return crypto.createHmac('sha256', sessionKey(config)).update(payload).digest('base64url');
}

function createSession(config, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const payload = Buffer.from(
    JSON.stringify({ v: 1, iat, exp: iat + SESSION_TTL_SECONDS, sid: crypto.randomBytes(12).toString('base64url') })
  ).toString('base64url');
  return `${payload}.${sign(config, payload)}`;
}

function verifySession(config, token, now = Date.now()) {
  if (!config || typeof token !== 'string' || token.length > 512) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  if (!safeEqual(Buffer.from(signature), Buffer.from(sign(config, payload)))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.v !== 1 || !Number.isInteger(data.exp) || data.exp <= Math.floor(now / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

function sessionCookie(token) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`;
}

function clearedCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

/* ---------- requisição ---------- */

function headersOf(event) {
  return Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
}

function readCookie(event, name) {
  const raw = headersOf(event).cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// CSRF: exige o cabeçalho customizado (não pode ser enviado entre sites sem CORS)
// e, se o navegador mandar Origin, ele deve ser o próprio site
function csrfOk(event) {
  const h = headersOf(event);
  if (h[CSRF_HEADER] !== '1') return false;
  if (h.origin) {
    try {
      const host = h['x-forwarded-host'] || h.host;
      if (new URL(h.origin).host !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function clientIp(event) {
  const h = headersOf(event);
  return (h['x-nf-client-connection-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || h['client-ip'] || 'desconhecido').trim();
}

/* Guarda das Functions admin: sessão válida + cabeçalho anti-CSRF.
   Devolve { config } ou { response } (401/403/503 sem detalhes). */
function requireAdmin(event, { methods = ['GET'] } = {}) {
  if (!methods.includes(event.httpMethod)) return { response: adminJson(405, { error: 'Método não permitido.' }) };
  const config = adminConfig();
  if (!config) return { response: adminJson(503, { error: 'Área administrativa não configurada.' }) };
  if (!csrfOk(event)) return { response: adminJson(403, { error: 'Requisição recusada.' }) };
  if (!verifySession(config, readCookie(event, COOKIE_NAME))) return { response: unauthorized() };
  return { config };
}

/* ---------- limite de tentativas (tabela admin_login_attempts) ---------- */

function attemptKeys(config, event, email) {
  const h = (v) => crypto.createHmac('sha256', config.secret).update(v).digest('hex');
  return [h(`ip:${clientIp(event)}`), h(`email:${String(email || '').trim().toLowerCase()}`)];
}

// Devolve os segundos até liberar (0 = liberado)
async function lockoutSeconds(keys, now = Date.now()) {
  const since = new Date(now - 24 * 3600 * 1000).toISOString();
  const rows = await sb(
    `admin_login_attempts?select=key_hash,created_at&key_hash=in.(${keys.join(',')})&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=200`
  );
  let wait = 0;
  for (const key of keys) {
    const times = rows.filter((r) => r.key_hash === key).map((r) => Date.parse(r.created_at)).sort((a, b) => b - a);
    for (const rule of ATTEMPT_WINDOWS) {
      const recent = times.filter((t) => t >= now - rule.windowMinutes * 60 * 1000);
      if (recent.length >= rule.failures) {
        const until = recent[0] + rule.lockMinutes * 60 * 1000;
        wait = Math.max(wait, Math.ceil((until - now) / 1000));
      }
    }
  }
  return Math.max(0, wait);
}

async function recordFailure(keys) {
  await sb('admin_login_attempts', { method: 'POST', body: keys.map((key_hash) => ({ key_hash })) });
}

async function clearFailures(keys) {
  await sb(`admin_login_attempts?key_hash=in.(${keys.join(',')})`, { method: 'DELETE' });
}

// Limpeza oportunista: tentativas com mais de 24 h não servem mais
async function pruneAttempts(now = Date.now()) {
  const before = new Date(now - 24 * 3600 * 1000).toISOString();
  await sb(`admin_login_attempts?created_at=lt.${encodeURIComponent(before)}`, { method: 'DELETE' });
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_SECONDS,
  adminJson,
  adminConfig,
  hashPassword,
  parseHash,
  checkCredentials,
  createSession,
  verifySession,
  sessionCookie,
  clearedCookie,
  readCookie,
  csrfOk,
  requireAdmin,
  attemptKeys,
  lockoutSeconds,
  recordFailure,
  clearFailures,
  pruneAttempts
};
