/*
 Netlify Function: mercadoLivreConnect (protegida)
 POST (cabeçalho X-Admin-Request: 1, sessão de administrador)
   -> 200 { authorization_url } + cookie __Host-nz_ml_oauth (state + PKCE, cifrado, 10 min)
 O painel faz location.assign(authorization_url). O endpoint não é um GET navegável
 porque a proteção CSRF do admin exige o cabeçalho customizado.
*/

const { adminJson, requireAdmin } = require('../_lib/adminAuth');
const ml = require('../_lib/mercadoLivre');

exports.handler = async (event) => {
  const guard = requireAdmin(event, { methods: ['POST'] });
  if (guard.response) return guard.response;

  const cfg = ml.mlConfig();
  if (!cfg.ok) {
    console.error('mercadoLivreConnect:', new ml.ConfigError(cfg.missing).message);
    return adminJson(503, { error: 'Integração com o Mercado Livre não configurada.', missing: cfg.missing });
  }

  const oauth = ml.createOAuthState(cfg.config);
  return adminJson(200, { authorization_url: oauth.authorizationUrl }, { 'Set-Cookie': ml.oauthCookie(oauth.cookieValue) });
};
