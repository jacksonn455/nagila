/*
 Netlify Scheduled Function: supabaseHealthCheck
 Agenda em netlify.toml ([functions.supabaseHealthCheck] schedule). Só roda em deploys publicados
 de produção e não pode ser chamada por URL nesses deploys, então nada fica exposto.
 Faz uma leitura mínima no Supabase e avisa no Discord quando cai / volta / o monitor falha.
 O estado (para não repetir avisos) fica no Netlify Blobs, store "monitoring".
 Monitora apenas: não é garantia de que o plano Free do Supabase deixe de pausar o projeto.
*/

const { connectLambda, getStore } = require('@netlify/blobs');
const { runMonitor } = require('../_lib/healthMonitor');

function blobStore(event) {
  connectLambda(event);
  // Sem consistency: 'strong': no modo Lambda (connectLambda) o Netlify não fornece o
  // uncachedEdgeURL que a leitura forte exige. Com execuções a cada 6h, a consistência
  // eventual (propagação em até ~60s) é suficiente para deduplicar os avisos.
  const store = getStore('monitoring');
  return {
    get: (key) => store.get(key, { type: 'json' }),
    set: (key, value) => store.setJSON(key, value),
  };
}

exports.handler = async (event) => {
  let store = null;
  try {
    store = blobStore(event);
  } catch (err) {
    // Sem Blobs o monitor ainda verifica e avisa, só não consegue deduplicar.
    console.error('[supabaseHealthCheck] Netlify Blobs indisponível:', (err && err.message) || err);
    store = {
      get: () => {
        throw err;
      },
      set: async () => {},
    };
  }
  const { status, checkedAt } = await runMonitor({ store });
  return { statusCode: 200, body: JSON.stringify({ status, checked_at: checkedAt }) };
};
