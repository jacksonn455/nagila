/*
 Netlify Function: adminLogin
 POST { email, password } (cabeçalho X-Admin-Request: 1)
 -> 200 { ok: true } + cookie de sessão  |  401 "E-mail ou senha incorretos."
 -> 429 depois de muitas falhas (por IP e por e-mail)  |  503 sem configuração
*/

const { readBody } = require('../_lib/http');
const {
  adminJson,
  adminConfig,
  checkCredentials,
  createSession,
  sessionCookie,
  csrfOk,
  attemptKeys,
  lockoutSeconds,
  recordFailure,
  clearFailures,
  pruneAttempts
} = require('../_lib/adminAuth');

const GENERIC_ERROR = 'E-mail ou senha incorretos.';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return adminJson(405, { error: 'Método não permitido.' });

  const config = adminConfig();
  if (!config) return adminJson(503, { error: 'Área administrativa não configurada.' });
  if (!csrfOk(event)) return adminJson(403, { error: 'Requisição recusada.' });

  const body = readBody(event);
  const email = body && typeof body.email === 'string' ? body.email.slice(0, 254) : '';
  const password = body && typeof body.password === 'string' ? body.password.slice(0, 512) : '';
  if (!email || !password) return adminJson(400, { error: GENERIC_ERROR });

  const keys = attemptKeys(config, event, email);
  try {
    const wait = await lockoutSeconds(keys);
    if (wait > 0) {
      const minutes = Math.max(1, Math.ceil(wait / 60));
      return adminJson(
        429,
        { error: `Muitas tentativas. Tente novamente em ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}.` },
        { 'Retry-After': String(wait) }
      );
    }

    if (!(await checkCredentials(config, email, password))) {
      await recordFailure(keys);
      await sleep(400); // atrasa a próxima tentativa
      return adminJson(401, { error: GENERIC_ERROR });
    }

    await clearFailures(keys);
    pruneAttempts().catch(() => {});
    return adminJson(200, { ok: true }, { 'Set-Cookie': sessionCookie(createSession(config)) });
  } catch (err) {
    // Sem registro de tentativas não há proteção contra força bruta: recusa o login
    console.error('adminLogin failed:', err && err.message ? err.message.split(':')[0] : 'erro');
    return adminJson(503, { error: 'Login indisponível no momento. Tente novamente em instantes.' });
  }
};
