/*
 Netlify Function: adminOrders (protegida)
 GET ?status=&situacao=&entrega=&de=&ate=&q=&page=&page_size=
   -> { summary, orders: [...], page, page_size, total }
 GET ?id=<uuid> -> { order } com endereço, itens, histórico de pagamento e motivos
 Filtros, paginação e a regra "Pronto para envio" são aplicados aqui, no servidor.
*/

const { adminJson, requireAdmin } = require('../_lib/adminAuth');
const { loadOrders, parseQuery, applyFilters, summarize, listItem, detailItem, safeError } = require('../_lib/adminOrders');

exports.handler = async (event) => {
  const guard = requireAdmin(event);
  if (guard.response) return guard.response;

  const parsed = parseQuery(event.queryStringParameters || {});
  if (!parsed.ok) return adminJson(400, { error: 'Parâmetros inválidos.' });
  const p = parsed.params;

  try {
    if (p.id) {
      const [order] = await loadOrders({ orderId: p.id });
      if (!order) return adminJson(404, { error: 'Pedido não encontrado.' });
      return adminJson(200, { order: detailItem(order) });
    }

    const all = await loadOrders();
    const filtered = applyFilters(all, p);
    const start = (p.page - 1) * p.pageSize;
    return adminJson(200, {
      summary: await summarize(all),
      orders: filtered.slice(start, start + p.pageSize).map(listItem),
      page: p.page,
      page_size: p.pageSize,
      total: filtered.length
    });
  } catch (err) {
    console.error('adminOrders failed:', safeError(err));
    return adminJson(500, { error: 'Não foi possível carregar os pedidos.' });
  }
};
