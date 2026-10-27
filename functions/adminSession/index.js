/*
 Netlify Function: adminSession
 GET (cabeçalho X-Admin-Request: 1) -> 200 { authenticated: true, expires_at } | 401 | 503
 Usada pelas páginas /admin/ para decidir se mostram o login ou o painel.
*/

const { adminJson, requireAdmin, readCookie, verifySession, COOKIE_NAME } = require('../_lib/adminAuth');

exports.handler = async (event) => {
  const guard = requireAdmin(event);
  if (guard.response) return guard.response;
  const session = verifySession(guard.config, readCookie(event, COOKIE_NAME));
  return adminJson(200, { authenticated: true, expires_at: new Date(session.exp * 1000).toISOString() });
};
