/*
 Netlify Function: adminMercadoLivreStatus (protegida)
 GET (cabeçalho X-Admin-Request: 1)
   -> { configured, missing?, accounts: [{ seller_id, seller_nickname, status, token_expires_at, ... }],
        queue: { pending, failed } }
 Nunca devolve tokens nem credenciais: só nomes das variáveis que faltam.
*/

const { adminJson, requireAdmin } = require('../_lib/adminAuth');
const { sb } = require('../_lib/supabase');
const ml = require('../_lib/mercadoLivre');
const { safeError } = require('../_lib/adminOrders');

exports.handler = async (event) => {
  const guard = requireAdmin(event);
  if (guard.response) return guard.response;

  const cfg = ml.mlConfig();
  if (!cfg.ok) return adminJson(200, { configured: false, missing: cfg.missing, accounts: [], queue: null });

  try {
    const [integrations, queue] = await Promise.all([
      ml.listIntegrations(),
      sb('processed_notifications?provider=eq.mercadolivre&status=in.(pending,processing,failed)&select=status&limit=1000')
    ]);
    return adminJson(200, {
      configured: true,
      accounts: integrations.map(ml.publicStatus),
      queue: {
        pending: queue.filter((r) => r.status !== 'failed').length,
        failed: queue.filter((r) => r.status === 'failed').length
      }
    });
  } catch (err) {
    console.error('adminMercadoLivreStatus failed:', safeError(err));
    return adminJson(500, { error: 'Não foi possível consultar a integração.' });
  }
};
