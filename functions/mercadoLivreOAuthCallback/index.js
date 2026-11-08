/*
 Netlify Function: mercadoLivreOAuthCallback
 Redirect URI cadastrada na aplicação do Mercado Livre:
   https://nagilazortea.com.br/.netlify/functions/mercadoLivreOAuthCallback
 GET ?code=...&state=...  (ou ?error=... quando a pessoa recusa)

 Não usa requireAdmin(): o retorno do Mercado Livre é uma navegação vinda de outro site
 e o cookie de sessão do admin é SameSite=Strict (não chega aqui). A proteção contra
 CSRF é o cookie __Host-nz_ml_oauth (SameSite=Lax, cifrado e autenticado), criado por
 mercadoLivreConnect para quem já estava logado no painel, comparado em tempo constante.

 Sempre responde com redirecionamento para /admin/pedidos.html?ml=<resultado>.
*/

const ml = require('../_lib/mercadoLivre');
const { readCookie } = require('../_lib/adminAuth');

const ADMIN_PAGE = '/admin/pedidos.html';
const CODE_RE = /^[A-Za-z0-9._-]{1,512}$/;

function redirect(result) {
  return {
    statusCode: 303,
    headers: {
      Location: `${ADMIN_PAGE}?ml=${encodeURIComponent(result)}`,
      'Set-Cookie': ml.clearedOAuthCookie(),
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'no-referrer'
    },
    body: ''
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: { 'Cache-Control': 'no-store' }, body: '' };

  const cfg = ml.mlConfig();
  if (!cfg.ok) {
    console.error('mercadoLivreOAuthCallback:', new ml.ConfigError(cfg.missing).message);
    return redirect('nao_configurado');
  }

  const q = event.queryStringParameters || {};
  const check = ml.verifyOAuthState(cfg.config, readCookie(event, ml.OAUTH_COOKIE), q.state);
  if (check.error) {
    console.warn('mercadoLivreOAuthCallback: state recusado', check.error);
    return redirect(check.error === 'expired' ? 'expirado' : 'estado_invalido');
  }
  if (q.error) return redirect('recusado'); // a pessoa não autorizou
  if (typeof q.code !== 'string' || !CODE_RE.test(q.code)) return redirect('erro');

  try {
    const tokens = await ml.exchangeCode(cfg.config, q.code, check.verifier);
    const seller = await ml.fetchSeller(tokens.access_token);
    if (tokens.user_id != null && String(tokens.user_id) !== seller.id) {
      console.error('mercadoLivreOAuthCallback: user_id do token difere de /users/me');
      return redirect('erro');
    }
    await ml.saveAuthorization(cfg.config, seller, tokens);
    console.log('mercadoLivreOAuthCallback: conta conectada, vendedor', seller.id);
    return redirect('conectado');
  } catch (err) {
    if (err instanceof ml.IntegrationError && err.code === 'missing_offline_access') return redirect('sem_offline_access');
    // Só nome/código do erro: nunca o código de autorização nem tokens
    console.error('mercadoLivreOAuthCallback falhou:', err.name || 'erro', err.status || '', err.code || '');
    return redirect('erro');
  }
};
