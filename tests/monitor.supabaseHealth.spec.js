const { test, expect } = require('@playwright/test');
const { createBackend, install } = require('./helpers/backend');
const { runMonitor, checkSupabase, STATE_KEY } = require('../functions/_lib/healthMonitor');

// Monitor do Supabase direto no Node: Supabase e Discord simulados, estado em memória.

const WEBHOOK = 'https://discord.test/monitor';
let backend;
let restore;
let supabase; // comportamento simulado do Supabase: 'ok' | 'refused' | 'http500' | 'hang'

function memoryStore(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: async (key) => (key in data ? structuredClone(data[key]) : null),
    set: async (key, value) => {
      data[key] = structuredClone(value);
    },
  };
}

// Fetch que desvia as chamadas ao Supabase para o cenário atual; o resto vai ao backend simulado.
function installSupabaseScenario() {
  const base = global.fetch;
  global.fetch = (url, opts = {}) => {
    // 'ok' segue para o backend simulado, que já registra a chamada em backend.calls
    if (!String(url).includes('supabase.test') || supabase === 'ok') return base(url, opts);
    backend.calls.push({ url: String(url), method: (opts.method || 'GET').toUpperCase(), headers: opts.headers });
    if (supabase === 'refused') {
      return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    }
    if (supabase === 'http500') {
      return Promise.resolve({ ok: false, status: 503, text: async () => '{"message":"Service Unavailable"}' });
    }
    if (supabase === 'hang') {
      return new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
      });
    }
    return base(url, opts);
  };
}

const fastCheck = () => checkSupabase({ timeoutMs: 50, retryDelayMs: 0 });
const run = (store, extra = {}) => runMonitor({ store, check: fastCheck, ...extra });
const supabaseCalls = () => backend.calls.filter((c) => c.url.includes('supabase.test'));
const messages = () => backend.discord.messages;
const field = (msg, name) => (msg.embeds[0].fields.find((f) => f.name === name) || {}).value;

test.describe('monitor do Supabase', () => {
  test.beforeEach(() => {
    backend = createBackend();
    restore = install(backend, { DISCORD_WEBHOOK_URL: WEBHOOK, MONITOR_ENVIRONMENT: 'test' });
    supabase = 'ok';
    installSupabaseScenario();
  });
  test.afterEach(() => restore());

  test('sucesso: uma leitura mínima, nada gravado, sem aviso', async () => {
    const store = memoryStore();
    const result = await run(store);

    expect(result.status).toBe('up');
    expect(supabaseCalls()).toHaveLength(1);
    expect(supabaseCalls()[0]).toMatchObject({ method: 'GET', url: 'https://supabase.test/rest/v1/orders?select=id&limit=1' });
    expect(messages()).toHaveLength(0);
    expect(store.data[STATE_KEY]).toMatchObject({ status: 'up', lastSuccessAt: result.checkedAt, monitorError: null });
  });

  test('conexão recusada: tenta 2 vezes e avisa no Discord com os detalhes', async () => {
    supabase = 'refused';
    const store = memoryStore();
    const result = await run(store, { now: () => new Date('2026-11-08T12:00:00Z') });

    expect(result.status).toBe('down');
    expect(supabaseCalls()).toHaveLength(2);
    expect(messages()).toHaveLength(1);
    const msg = messages()[0];
    expect(msg.embeds[0].title).toContain('indisponível');
    expect(field(msg, 'Projeto')).toBe('NZ Livros');
    expect(field(msg, 'Ambiente')).toBe('test');
    expect(field(msg, 'Status')).toBe('Falhou');
    expect(field(msg, 'Verificado em')).toContain('2026-11-08T12:00:00.000Z');
    expect(field(msg, 'Erro')).toContain('ECONNREFUSED');
    expect(store.data[STATE_KEY]).toMatchObject({
      status: 'down',
      downAlerted: true,
      downSince: '2026-11-08T12:00:00.000Z',
      lastFailureAt: '2026-11-08T12:00:00.000Z',
    });
  });

  test('erro HTTP do Supabase (ex.: projeto pausado) conta como falha', async () => {
    supabase = 'http500';
    const result = await run(memoryStore());
    expect(result.status).toBe('down');
    expect(field(messages()[0], 'Erro')).toContain('503');
  });

  test('timeout de rede: aborta e avisa', async () => {
    supabase = 'hang';
    const result = await run(memoryStore());
    expect(result.status).toBe('down');
    expect(supabaseCalls()).toHaveLength(2);
    expect(field(messages()[0], 'Erro')).toBe('Tempo limite excedido');
  });

  test('queda contínua: avisa uma vez só', async () => {
    supabase = 'refused';
    const store = memoryStore();
    await run(store);
    await run(store);
    await run(store);
    expect(messages()).toHaveLength(1);
  });

  test('se o Discord falhou, o aviso de queda é tentado de novo na próxima execução', async () => {
    supabase = 'refused';
    const store = memoryStore();
    backend.discord.fails = true;
    const first = await run(store);
    expect(first.notifications).toEqual([{ kind: 'down', delivered: false }]);
    expect(store.data[STATE_KEY].downAlerted).toBe(false);

    backend.discord.fails = false;
    await run(store);
    await run(store);
    expect(messages()).toHaveLength(1);
  });

  test('recuperação: avisa que voltou uma vez, com o início da queda', async () => {
    const store = memoryStore();
    supabase = 'refused';
    await run(store, { now: () => new Date('2026-11-08T00:00:00Z') });
    supabase = 'ok';
    await run(store, { now: () => new Date('2026-11-08T06:00:00Z') });
    await run(store, { now: () => new Date('2026-11-08T12:00:00Z') });

    expect(messages()).toHaveLength(2);
    const recovery = messages()[1];
    expect(recovery.embeds[0].title).toContain('voltou');
    expect(field(recovery, 'Status')).toBe('OK');
    expect(field(recovery, 'Fora do ar desde')).toContain('2026-11-08T00:00:00.000Z');
    expect(field(recovery, 'Fora do ar desde')).toContain('~360 min');
    expect(store.data[STATE_KEY]).toMatchObject({ status: 'up', downSince: null, lastSuccessAt: '2026-11-08T12:00:00.000Z' });
  });

  test('erro inesperado do monitor (sem configuração): avisa uma vez, sem chamar o Supabase', async () => {
    delete process.env.SUPABASE_URL;
    const store = memoryStore();
    const result = await run(store);
    await run(store);

    expect(result.status).toBe('monitor_error');
    expect(supabaseCalls()).toHaveLength(0);
    expect(messages()).toHaveLength(1);
    expect(messages()[0].embeds[0].title).toContain('Erro no monitor');
    expect(field(messages()[0], 'Erro')).toContain('SUPABASE_URL');
  });

  test('estado ilegível: ainda verifica e avisa (sem deduplicação possível)', async () => {
    const store = { get: async () => { throw new Error('blobs fora'); }, set: async () => {} };
    const result = await run(store);
    expect(result.status).toBe('up');
    expect(messages()).toHaveLength(1);
    expect(field(messages()[0], 'Erro')).toContain('blobs fora');
  });

  test('a chave service_role nunca vai para o Discord', async () => {
    supabase = 'refused';
    await run(memoryStore());
    expect(JSON.stringify(messages())).not.toContain('test-service-key');
  });

  test('sem DISCORD_WEBHOOK_URL: monitora e registra, sem lançar erro', async () => {
    delete process.env.DISCORD_WEBHOOK_URL;
    supabase = 'refused';
    const result = await run(memoryStore());
    expect(result.status).toBe('down');
    expect(result.notifications).toEqual([{ kind: 'down', delivered: false }]);
  });

  test('handler agendado: responde 200 mesmo sem o contexto do Netlify Blobs', async () => {
    const { handler } = require('../functions/supabaseHealthCheck/index.js');
    const res = await handler({});
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('up');
  });
});
