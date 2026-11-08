/*
 Netlify Background Function: mercadoLivreProcess-background
 Acionada pelo mercadoLivreWebhook logo depois de gravar uma notificação
 (só com MERCADO_LIVRE_BACKGROUND_PROCESSING=true e plano do Netlify com Background Functions).
 O Netlify responde 202 na hora e a função roda até 15 min.

 Exige o cabeçalho x-nz-internal (HMAC derivado da chave de criptografia): sem ele não faz nada.
 Mesmo se chamada à toa, só processa o que já está na fila — e a fila é idempotente.
*/

const ml = require('../_lib/mercadoLivre');
const { processPending } = require('../_lib/mercadoLivreSync');

exports.handler = async (event) => {
  const cfg = ml.mlConfig();
  if (!cfg.ok) return { statusCode: 503, body: '' };
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  if (event.httpMethod !== 'POST' || !ml.internalTokenOk(cfg.config, headers['x-nz-internal'])) {
    return { statusCode: 403, body: '' };
  }

  try {
    const stats = await processPending({ limit: 50, budgetMs: 10 * 60 * 1000 });
    console.log('mercadoLivreProcess-background:', JSON.stringify(stats));
  } catch (err) {
    console.error('mercadoLivreProcess-background falhou:', String((err && err.message) || 'erro').split(':')[0]);
  }
  return { statusCode: 200, body: '' };
};
