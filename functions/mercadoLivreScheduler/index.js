/*
 Netlify Scheduled Function: mercadoLivreScheduler (agenda em netlify.toml)
 A cada execução:
 1. processa notificações pendentes e reprocessa as que falharam (com espera crescente)
    — é o caminho principal quando não há Background Function;
 2. verifica cada conta conectada e renova o access token quando faltam menos de 10 min,
    mantendo o refresh token em uso (rotação a cada renovação).
 Funções agendadas não têm URL pública em produção.
*/

const ml = require('../_lib/mercadoLivre');
const { processPending } = require('../_lib/mercadoLivreSync');
const { notifyIntegrationAlert } = require('../_lib/discord');

const short = (err) => String((err && (err.code || err.message)) || 'erro').split(':')[0];

async function healthCheck() {
  const integrations = await ml.listIntegrations();
  const out = [];
  for (const row of integrations.filter((r) => r.status === 'active')) {
    try {
      await ml.getAccessToken(row.seller_id, {
        onReauthorization: (r) =>
          notifyIntegrationAlert(
            `A conta do Mercado Livre${r.seller_nickname ? ` (${r.seller_nickname})` : ''} precisa ser reconectada no painel: a renovação do acesso foi recusada.`
          )
      });
      out.push({ seller_id: row.seller_id, ok: true });
    } catch (err) {
      out.push({ seller_id: row.seller_id, ok: false, error: short(err) });
    }
  }
  return out;
}

exports.handler = async () => {
  const cfg = ml.mlConfig();
  if (!cfg.ok) {
    console.log('mercadoLivreScheduler: integração não configurada, nada a fazer');
    return { statusCode: 200, body: '' };
  }
  try {
    const stats = await processPending({ limit: 25, budgetMs: 20000 });
    const health = await healthCheck();
    console.log('mercadoLivreScheduler:', JSON.stringify({ stats, health }));
  } catch (err) {
    console.error('mercadoLivreScheduler falhou:', short(err));
  }
  return { statusCode: 200, body: '' };
};
