/* Integração com o Mercado Livre (API oficial): configuração, criptografia dos tokens,
   OAuth com PKCE, cliente da API e renovação de token com controle de concorrência.

 Variáveis de ambiente (só no Netlify e no .env local, nunca no código):
 - MERCADO_LIVRE_CLIENT_ID, MERCADO_LIVRE_CLIENT_SECRET   credenciais da aplicação
 - MERCADO_LIVRE_REDIRECT_URI                              igual à cadastrada na aplicação
 - MERCADO_LIVRE_TOKEN_ENCRYPTION_KEY                      32 bytes aleatórios em base64

 Nada aqui registra em log token, código de autorização, verifier ou client secret.
*/

const crypto = require('crypto');
const { sb } = require('./supabase');

const PROVIDER = 'mercadolivre';
const AUTH_URL = 'https://auth.mercadolivre.com.br/authorization';
const API_BASE = 'https://api.mercadolibre.com';
const TOKEN_URL = `${API_BASE}/oauth/token`;

const REFRESH_MARGIN_MS = 10 * 60 * 1000; // renova quando faltam menos de 10 min
const REFRESH_LEASE_MS = 30 * 1000;
const OAUTH_COOKIE = '__Host-nz_ml_oauth';
const OAUTH_TTL_SECONDS = 10 * 60;
const REQUEST_TIMEOUT_MS = 10 * 1000;
const EPOCH = '1970-01-01T00:00:00.000Z';

// Ajustáveis nos testes (espera curta quando outro processo está renovando)
const timing = { leaseWaitMs: 400, leaseWaitTries: 8, retryDelayMs: 500 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------- erros ---------- */

// Erro de configuração: a mensagem lista só NOMES de variáveis
class ConfigError extends Error {
  constructor(missing) {
    super(`Mercado Livre não configurado: ${missing.join(', ')}`);
    this.name = 'ConfigError';
    this.missing = missing;
  }
}

// Integração sem token utilizável (precisa conectar ou reconectar a conta)
class IntegrationError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'IntegrationError';
    this.code = code; // not_connected | reauthorization_required
  }
}

// Erro da API: só status, caminho sem query e o código de erro devolvido (nunca o corpo)
class ApiError extends Error {
  constructor(status, path, code) {
    super(`Mercado Livre ${path} respondeu ${status}${code ? ` (${code})` : ''}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code || null;
  }
}

/* ---------- configuração ---------- */

function decodeKey(raw) {
  const value = String(raw || '').trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return null;
  const key = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return key.length === 32 ? key : null;
}

// Devolve { ok: true, config } ou { ok: false, missing: [nomes] } — sem expor valores
function mlConfig() {
  const env = process.env;
  const clientId = (env.MERCADO_LIVRE_CLIENT_ID || '').trim();
  const clientSecret = (env.MERCADO_LIVRE_CLIENT_SECRET || '').trim();
  const redirectUri = (env.MERCADO_LIVRE_REDIRECT_URI || '').trim();
  const key = decodeKey(env.MERCADO_LIVRE_TOKEN_ENCRYPTION_KEY);
  const missing = [];
  if (!clientId) missing.push('MERCADO_LIVRE_CLIENT_ID');
  if (!clientSecret) missing.push('MERCADO_LIVRE_CLIENT_SECRET');
  if (!/^https:\/\/[^\s?#]+$/.test(redirectUri)) missing.push('MERCADO_LIVRE_REDIRECT_URI (https, sem query)');
  if (!key) missing.push('MERCADO_LIVRE_TOKEN_ENCRYPTION_KEY (32 bytes em base64)');
  if (missing.length) return { ok: false, missing };
  return { ok: true, config: { clientId, clientSecret, redirectUri, key } };
}

function requireConfig() {
  const c = mlConfig();
  if (!c.ok) throw new ConfigError(c.missing);
  return c.config;
}

// Uma chave por finalidade, derivadas da chave mestra (HKDF-SHA256)
function subkey(config, purpose) {
  return Buffer.from(crypto.hkdfSync('sha256', config.key, Buffer.alloc(0), `nz-mercadolivre:${purpose}:v1`, 32));
}

/* ---------- criptografia (AES-256-GCM) ---------- */

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function seal(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `v1.${b64u(iv)}.${b64u(cipher.getAuthTag())}.${b64u(data)}`;
}

// Devolve o texto ou null (formato inválido, chave errada, AAD diferente ou dado adulterado)
function open(key, sealed, aad) {
  const parts = String(sealed || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const [iv, tag, data] = parts.slice(1).map((p) => Buffer.from(p, 'base64url'));
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// AAD = vendedor + campo: um token copiado para outra linha ou outro campo não abre
const tokenAad = (sellerId, field) => `${PROVIDER}:${sellerId}:${field}`;

function encryptToken(config, sellerId, field, value) {
  return seal(subkey(config, 'tokens'), value, tokenAad(sellerId, field));
}

function decryptToken(config, sellerId, field, value) {
  return open(subkey(config, 'tokens'), value, tokenAad(sellerId, field));
}

/* ---------- OAuth: state + PKCE em cookie selado ---------- */

function pkcePair() {
  const verifier = crypto.randomBytes(48).toString('base64url'); // 64 caracteres (RFC 7636: 43–128)
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function createOAuthState(config, now = Date.now()) {
  const state = crypto.randomBytes(32).toString('base64url');
  const { verifier, challenge } = pkcePair();
  const exp = Math.floor(now / 1000) + OAUTH_TTL_SECONDS;
  // O cookie é cifrado e autenticado: o navegador não lê o verifier nem altera o state
  const cookieValue = seal(subkey(config, 'oauth-cookie'), JSON.stringify({ v: 1, state, verifier, exp }), 'oauth-state');
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  }).toString();
  return { state, verifier, challenge, cookieValue, authorizationUrl: url.toString() };
}

// SameSite=Lax: o retorno do Mercado Livre é uma navegação vinda de outro site
function oauthCookie(value) {
  return `${OAUTH_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${OAUTH_TTL_SECONDS}`;
}

function clearedOAuthCookie() {
  return `${OAUTH_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// Devolve { verifier } ou { error: 'missing' | 'invalid' | 'expired' | 'mismatch' }
function verifyOAuthState(config, cookieValue, returnedState, now = Date.now()) {
  if (!cookieValue) return { error: 'missing' };
  if (typeof returnedState !== 'string' || !returnedState || returnedState.length > 256) return { error: 'mismatch' };
  const raw = open(subkey(config, 'oauth-cookie'), cookieValue, 'oauth-state');
  if (!raw) return { error: 'invalid' };
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { error: 'invalid' };
  }
  if (data.v !== 1 || typeof data.state !== 'string' || typeof data.verifier !== 'string') return { error: 'invalid' };
  if (!Number.isInteger(data.exp) || data.exp <= Math.floor(now / 1000)) return { error: 'expired' };
  const a = Buffer.from(data.state);
  const b = Buffer.from(returnedState);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { error: 'mismatch' };
  return { verifier: data.verifier };
}

/* ---------- HTTP ---------- */

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// Erros transitórios (rede, 429, 5xx) têm até 2 novas tentativas com espera curta
async function request(url, opts, { retries = 2 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    let res;
    try {
      res = await fetch(url, { ...opts, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      if (attempt < retries) {
        await sleep(timing.retryDelayMs * (attempt + 1));
        continue;
      }
      throw new ApiError(0, new URL(url).pathname, (err && err.name) || 'network');
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(timing.retryDelayMs * (attempt + 1));
      continue;
    }
    return res;
  }
}

// POST /oauth/token (form-urlencoded). Sem novas tentativas: o refresh token é de uso único
async function tokenRequest(params) {
  const res = await request(
    TOKEN_URL,
    {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString()
    },
    { retries: 0 }
  );
  const data = await readJson(res);
  if (!res.ok || !data || !data.access_token) {
    throw new ApiError(res.status, '/oauth/token', (data && data.error) || null);
  }
  return data;
}

function exchangeCode(config, code, verifier) {
  return tokenRequest({
    grant_type: 'authorization_code',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier
  });
}

function refreshTokens(config, refreshToken) {
  return tokenRequest({
    grant_type: 'refresh_token',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken
  });
}

// GET autenticado na API. 404 -> null; outros erros -> ApiError
async function apiGet(path, accessToken, headers = {}) {
  const res = await request(`${API_BASE}${path}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}`, ...headers }
  });
  if (res.status === 404) return null;
  const data = await readJson(res);
  if (!res.ok) throw new ApiError(res.status, path.split('?')[0], (data && data.error) || null);
  return data;
}

async function fetchSeller(accessToken) {
  const me = await apiGet('/users/me', accessToken);
  if (!me || me.id == null) throw new ApiError(404, '/users/me', null);
  return { id: String(me.id), nickname: me.nickname || null };
}

/* ---------- integração no Supabase ---------- */

const INTEGRATION_FIELDS =
  'id,provider,seller_id,seller_nickname,access_token_enc,refresh_token_enc,token_expires_at,scopes,status,version,refresh_lock_until,last_refreshed_at,last_error,created_at,updated_at';

async function loadIntegration(sellerId) {
  const [row] = await sb(
    `marketplace_integrations?provider=eq.${PROVIDER}&seller_id=eq.${encodeURIComponent(sellerId)}&select=${INTEGRATION_FIELDS}`
  );
  return row || null;
}

async function listIntegrations() {
  return sb(`marketplace_integrations?provider=eq.${PROVIDER}&select=${INTEGRATION_FIELDS}&order=created_at.asc`);
}

const expiresAt = (tokens, now) => new Date(now + Math.max(0, Number(tokens.expires_in) || 0) * 1000).toISOString();

// Grava (ou regrava, ao reconectar) a conta com os tokens criptografados
async function saveAuthorization(config, seller, tokens, now = Date.now()) {
  if (!tokens.refresh_token) {
    throw new IntegrationError('missing_offline_access', 'A aplicação não devolveu refresh token (escopo offline_access).');
  }
  const existing = await loadIntegration(seller.id);
  const body = {
    provider: PROVIDER,
    seller_id: seller.id,
    seller_nickname: seller.nickname,
    access_token_enc: encryptToken(config, seller.id, 'access_token', tokens.access_token),
    refresh_token_enc: encryptToken(config, seller.id, 'refresh_token', tokens.refresh_token),
    token_expires_at: expiresAt(tokens, now),
    scopes: tokens.scope || null,
    status: 'active',
    // a versão muda a cada gravação: uma renovação antiga em andamento não sobrescreve
    version: existing ? Number(existing.version) + 1 : 1,
    refresh_lock_until: EPOCH,
    last_refreshed_at: new Date(now).toISOString(),
    last_error: null
  };
  await sb('marketplace_integrations?on_conflict=provider,seller_id', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates',
    body
  });
  return body;
}

// Marca a integração como "precisa reconectar". true só para quem fez a mudança.
async function markReauthorization(row, reason) {
  const updated = await sb(
    `marketplace_integrations?id=eq.${row.id}&version=eq.${row.version}&status=eq.active`,
    {
      method: 'PATCH',
      prefer: 'return=representation',
      body: { status: 'reauthorization_required', last_error: reason, refresh_lock_until: EPOCH, version: Number(row.version) + 1 }
    }
  );
  return !!(updated && updated.length);
}

/* ---------- access token com renovação segura ---------- */

/*
 getAccessToken(sellerId) -> access token válido (texto) ou erro.

 O refresh token do Mercado Livre é de uso único e só o último emitido vale. Por isso:
 1. só quem consegue o "lease" (PATCH condicional por version e refresh_lock_until)
    chama POST /oauth/token;
 2. os demais usam o access token atual se ele ainda não venceu (a renovação começa
    10 min antes) ou esperam o vencedor gravar a versão nova;
 3. a gravação dos tokens novos também é condicional à versão lida.
 invalid_grant -> status reauthorization_required + aviso no Discord (uma vez).
*/
async function getAccessToken(sellerId, { onReauthorization, now = Date.now } = {}) {
  const config = requireConfig();

  for (let wait = 0; wait <= timing.leaseWaitTries; wait += 1) {
    const row = await loadIntegration(sellerId);
    if (!row) throw new IntegrationError('not_connected', 'Conta do Mercado Livre não conectada.');
    if (row.status !== 'active') throw new IntegrationError('reauthorization_required', 'Reconecte a conta do Mercado Livre.');

    const t = now();
    const expires = Date.parse(row.token_expires_at);
    const stillValid = Number.isFinite(expires) && expires > t;
    if (stillValid && expires - t > REFRESH_MARGIN_MS) return openAccess(config, row);

    // Tenta pegar o lease de renovação
    const leaseUntil = new Date(t + REFRESH_LEASE_MS).toISOString();
    const leased = await sb(
      `marketplace_integrations?id=eq.${row.id}&version=eq.${row.version}&refresh_lock_until=lt.${encodeURIComponent(new Date(t).toISOString())}`,
      { method: 'PATCH', prefer: 'return=representation', body: { refresh_lock_until: leaseUntil } }
    );
    if (leased && leased.length) return refreshWithLease(config, row, { onReauthorization, now });

    // Outro processo está renovando
    if (stillValid) return openAccess(config, row);
    await sleep(timing.leaseWaitMs);
  }
  throw new IntegrationError('refresh_in_progress', 'Renovação do token em andamento. Tente novamente.');
}

function openAccess(config, row) {
  const token = decryptToken(config, row.seller_id, 'access_token', row.access_token_enc);
  if (!token) throw new IntegrationError('reauthorization_required', 'Token armazenado ilegível (chave de criptografia trocada?).');
  return token;
}

async function refreshWithLease(config, row, { onReauthorization, now }) {
  const refreshToken = decryptToken(config, row.seller_id, 'refresh_token', row.refresh_token_enc);
  if (!refreshToken) {
    if ((await markReauthorization(row, 'refresh_token_unreadable')) && onReauthorization) await onReauthorization(row);
    throw new IntegrationError('reauthorization_required', 'Token armazenado ilegível (chave de criptografia trocada?).');
  }

  let tokens;
  try {
    tokens = await refreshTokens(config, refreshToken);
  } catch (err) {
    if (err instanceof ApiError && (err.code === 'invalid_grant' || err.status === 401)) {
      if ((await markReauthorization(row, 'invalid_grant')) && onReauthorization) await onReauthorization(row);
      throw new IntegrationError('reauthorization_required', 'O Mercado Livre recusou a renovação. Reconecte a conta.');
    }
    // Falha transitória: libera o lease para outra tentativa (o refresh token não foi consumido)
    await sb(`marketplace_integrations?id=eq.${row.id}&version=eq.${row.version}`, {
      method: 'PATCH',
      body: { refresh_lock_until: EPOCH, last_error: err.code || `http_${err.status || 0}` }
    }).catch(() => {});
    throw err;
  }

  const t = now();
  const body = {
    access_token_enc: encryptToken(config, row.seller_id, 'access_token', tokens.access_token),
    // rotação: o Mercado Livre devolve um refresh token novo a cada renovação
    refresh_token_enc: encryptToken(config, row.seller_id, 'refresh_token', tokens.refresh_token || refreshToken),
    token_expires_at: expiresAt(tokens, t),
    scopes: tokens.scope || row.scopes,
    version: Number(row.version) + 1,
    refresh_lock_until: EPOCH,
    last_refreshed_at: new Date(t).toISOString(),
    last_error: null
  };

  // O token antigo já foi consumido: a gravação tem 3 tentativas
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const saved = await sb(`marketplace_integrations?id=eq.${row.id}&version=eq.${row.version}`, {
        method: 'PATCH',
        prefer: 'return=representation',
        body
      });
      if (!saved || !saved.length) {
        // Versão mudou durante o lease (ex.: reconexão manual): a gravação nova prevalece
        console.warn('Mercado Livre: tokens renovados descartados (versão mudou) vendedor', row.seller_id);
      }
      return tokens.access_token;
    } catch (err) {
      if (attempt === 2) {
        console.error('Mercado Livre: falha ao gravar tokens renovados, vendedor', row.seller_id);
        throw err;
      }
      await sleep(timing.retryDelayMs);
    }
  }
  return tokens.access_token;
}

/* ---------- status para o painel (sem tokens) ---------- */

function publicStatus(row) {
  if (!row) return null;
  return {
    seller_id: row.seller_id,
    seller_nickname: row.seller_nickname || null,
    status: row.status,
    token_expires_at: row.token_expires_at || null,
    last_refreshed_at: row.last_refreshed_at || null,
    last_error: row.last_error || null,
    scopes: row.scopes || null,
    connected_at: row.created_at || null
  };
}

// Token interno para o webhook acionar a Background Function (não é segredo da API)
function internalToken(config) {
  return crypto.createHmac('sha256', subkey(config, 'internal')).update('process-notifications').digest('base64url');
}

function internalTokenOk(config, value) {
  const expected = Buffer.from(internalToken(config));
  const got = Buffer.from(String(value || ''));
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

module.exports = {
  PROVIDER,
  AUTH_URL,
  API_BASE,
  OAUTH_COOKIE,
  OAUTH_TTL_SECONDS,
  REFRESH_MARGIN_MS,
  timing,
  ConfigError,
  IntegrationError,
  ApiError,
  mlConfig,
  requireConfig,
  seal,
  open,
  encryptToken,
  decryptToken,
  pkcePair,
  createOAuthState,
  verifyOAuthState,
  oauthCookie,
  clearedOAuthCookie,
  exchangeCode,
  refreshTokens,
  apiGet,
  fetchSeller,
  loadIntegration,
  listIntegrations,
  saveAuthorization,
  getAccessToken,
  publicStatus,
  internalToken,
  internalTokenOk
};
