/*
 Netlify Function: adminLogout
 POST (cabeçalho X-Admin-Request: 1) -> 200 { ok: true } e apaga o cookie de sessão.
 Sem sessão válida responde 401 (e apaga o cookie do mesmo jeito).
 A sessão é assinada e não fica guardada no servidor: para derrubar todas as sessões
 (ex.: senha vazada), troque ADMIN_SESSION_SECRET ou ADMIN_PASSWORD_HASH.
*/

const { adminJson, clearedCookie, requireAdmin } = require('../_lib/adminAuth');

exports.handler = async (event) => {
  const guard = requireAdmin(event, { methods: ['POST'] });
  if (guard.response) {
    if (guard.response.statusCode === 401) guard.response.headers['Set-Cookie'] = clearedCookie();
    return guard.response;
  }
  return adminJson(200, { ok: true }, { 'Set-Cookie': clearedCookie() });
};
