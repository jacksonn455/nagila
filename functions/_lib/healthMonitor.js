/* Monitor de disponibilidade do Supabase (usado pela function agendada supabaseHealthCheck).

   - checkSupabase: UMA leitura mínima (GET orders?select=id&limit=1) pelo cliente sb(), com
     timeout por tentativa e uma nova tentativa antes de considerar falha. Nunca grava nada.
   - runMonitor: compara com o estado anterior e avisa no Discord (DISCORD_WEBHOOK_URL) só nas
     transições: fora do ar, voltou, erro do próprio monitor. Uma queda contínua gera um aviso só.
     Se o Discord falhar, o aviso é tentado de novo na próxima execução.

   IMPORTANTE: isto MONITORA. Não garante que o Supabase deixe de pausar o projeto no plano Free;
   a documentação oficial não promete que requisições agendadas contem como atividade. */

const { sb } = require('./supabase');
const { postDiscord } = require('./discord');

const PROJECT_NAME = 'NZ Livros';
const HEALTH_QUERY = 'orders?select=id&limit=1';
const STATE_KEY = 'supabase-health';

const environment = (env = process.env) =>
  env.MONITOR_ENVIRONMENT || env.CONTEXT || env.NODE_ENV || 'production';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Mensagem de erro curta, sem segredos (a chave nunca deveria aparecer, mas por garantia).
function describeError(err) {
  const name = (err && err.name) || 'Error';
  let message =
    name === 'TimeoutError' || name === 'AbortError'
      ? 'Tempo limite excedido'
      : (err && err.message) || String(err);
  const cause = err && err.cause && (err.cause.code || err.cause.message);
  if (cause) message += ` (${cause})`;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (key) message = message.split(key).join('[redacted]');
  return message.length > 500 ? `${message.slice(0, 499)}…` : message;
}

class MonitorConfigError extends Error {}

async function checkSupabase({ timeoutMs = 5000, attempts = 2, retryDelayMs = 1000 } = {}) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new MonitorConfigError('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY não configuradas');
  }
  let error;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const started = Date.now();
    try {
      await sb(HEALTH_QUERY, { signal: AbortSignal.timeout(timeoutMs) });
      return { ok: true, latencyMs: Date.now() - started, attempts: attempt };
    } catch (err) {
      error = describeError(err);
      console.warn(`[supabaseHealthCheck] tentativa ${attempt}/${attempts} falhou: ${error}`);
      if (attempt < attempts) await sleep(retryDelayMs);
    }
  }
  return { ok: false, error, attempts };
}

/* ---------- Mensagens ---------- */

function buildAlert(kind, { checkedAt, error, downSince, latencyMs }, env) {
  const styles = {
    down: { title: '🔴 Supabase indisponível', color: 0xc62828, status: 'Falhou' },
    up: { title: '🟢 Supabase voltou a responder', color: 0x2e7d32, status: 'OK' },
    monitor_error: { title: '⚠️ Erro no monitor do Supabase', color: 0xef6c00, status: 'Erro no monitor' },
  };
  const style = styles[kind];
  const unix = Math.floor(new Date(checkedAt).getTime() / 1000);
  const fields = [
    { name: 'Projeto', value: PROJECT_NAME, inline: true },
    { name: 'Ambiente', value: environment(env), inline: true },
    { name: 'Status', value: style.status, inline: true },
    { name: 'Verificado em', value: `<t:${unix}:f> (${checkedAt})`, inline: false },
  ];
  if (kind === 'up' && downSince) {
    const minutes = Math.round((new Date(checkedAt) - new Date(downSince)) / 60000);
    fields.push({ name: 'Fora do ar desde', value: `${downSince} (~${minutes} min)`, inline: false });
  }
  if (kind === 'up' && latencyMs != null)
    fields.push({ name: 'Latência', value: `${latencyMs} ms`, inline: true });
  if (error) fields.push({ name: 'Erro', value: error, inline: false });
  if (kind === 'down')
    fields.push({
      name: 'O que fazer',
      value: 'Se o projeto foi pausado por inatividade, retome em supabase.com/dashboard (Restore).',
      inline: false,
    });
  return {
    username: 'Monitor NZ Livros',
    embeds: [{ title: style.title, color: style.color, fields, timestamp: checkedAt }],
  };
}

const discordNotifier = (env = process.env) => (payload) =>
  postDiscord(env.DISCORD_WEBHOOK_URL, payload, 'monitor supabase');

/* ---------- Execução ----------
   store: { get(key) -> objeto|null, set(key, objeto) }   (Netlify Blobs na produção)
   Estado: { status: 'up'|'down', lastCheckAt, lastSuccessAt, lastFailureAt, lastError,
             downSince, downAlerted, monitorError } */

async function runMonitor({
  store,
  check = checkSupabase,
  notify = discordNotifier(),
  now = () => new Date(),
  env = process.env,
} = {}) {
  const checkedAt = now().toISOString();
  let prev = {};
  let stateError = null;
  try {
    prev = (store && (await store.get(STATE_KEY))) || {};
  } catch (err) {
    stateError = `Não foi possível ler o estado do monitor: ${describeError(err)}`;
  }

  let result;
  try {
    result = await check();
  } catch (err) {
    result = { monitorError: describeError(err) };
  }

  const next = { ...prev, lastCheckAt: checkedAt };
  const sent = [];
  const send = async (kind, info) => {
    const ok = await notify(buildAlert(kind, { checkedAt, ...info }, env));
    sent.push({ kind, delivered: ok });
    return ok;
  };

  if (result.monitorError) {
    // Erro do próprio monitor (configuração, bug): não diz nada sobre o Supabase.
    if (prev.monitorError !== result.monitorError || stateError) {
      const ok = await send('monitor_error', { error: result.monitorError });
      next.monitorError = ok ? result.monitorError : null;
    }
  } else {
    next.monitorError = null;
    if (result.ok) {
      next.lastSuccessAt = checkedAt;
      if (prev.status === 'down' && prev.downAlerted) {
        await send('up', { downSince: prev.downSince, latencyMs: result.latencyMs });
      }
      Object.assign(next, { status: 'up', downSince: null, downAlerted: false, lastError: null });
    } else {
      const firstFailure = prev.status !== 'down';
      Object.assign(next, {
        status: 'down',
        lastFailureAt: checkedAt,
        lastError: result.error,
        downSince: firstFailure ? checkedAt : prev.downSince,
      });
      // Um aviso por queda; se o Discord falhou da última vez, tenta de novo agora.
      if (firstFailure || !prev.downAlerted) {
        next.downAlerted = await send('down', { error: result.error });
      }
    }
  }

  // Sem estado legível não há como deduplicar: avisa (o erro de leitura em si também vai no log).
  if (stateError) {
    console.error(`[supabaseHealthCheck] ${stateError}`);
    if (!result.monitorError) await send('monitor_error', { error: stateError });
  }

  if (store) {
    try {
      await store.set(STATE_KEY, next);
    } catch (err) {
      console.error(`[supabaseHealthCheck] Não foi possível salvar o estado: ${describeError(err)}`);
    }
  }

  const status = result.monitorError ? 'monitor_error' : result.ok ? 'up' : 'down';
  const log = `[supabaseHealthCheck] status=${status} env=${environment(env)}` +
    (result.latencyMs != null ? ` latency=${result.latencyMs}ms` : '') +
    (result.error || result.monitorError ? ` error="${result.error || result.monitorError}"` : '') +
    (sent.length ? ` notified=${sent.map((s) => `${s.kind}:${s.delivered ? 'ok' : 'failed'}`).join(',')}` : '');
  (status === 'up' ? console.log : console.error)(log);

  return { status, checkedAt, state: next, notifications: sent };
}

module.exports = {
  PROJECT_NAME,
  HEALTH_QUERY,
  STATE_KEY,
  MonitorConfigError,
  checkSupabase,
  buildAlert,
  runMonitor,
  environment,
};
