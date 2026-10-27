/*
 Netlify Function: adminExport (protegida)
 GET -> CSV (UTF-8, separador ";") dos pedidos prontos para envio por frete:
 pedido, nome, telefone, endereço, CEP, itens, quantidade e serviço.
 Valores que começam com = + - @ recebem um apóstrofo (injeção de fórmula).
*/

const { adminJson, requireAdmin } = require('../_lib/adminAuth');
const { loadOrders, toCsv, safeError } = require('../_lib/adminOrders');

exports.handler = async (event) => {
  const guard = requireAdmin(event);
  if (guard.response) return guard.response;

  try {
    const csv = toCsv(await loadOrders());
    const day = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); // data de Brasília
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="pedidos-prontos-${day}.csv"`,
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
        'X-Content-Type-Options': 'nosniff'
      },
      body: csv
    };
  } catch (err) {
    console.error('adminExport failed:', safeError(err));
    return adminJson(500, { error: 'Não foi possível gerar o arquivo.' });
  }
};
