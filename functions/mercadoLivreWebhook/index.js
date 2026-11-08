/*
 Netlify Function: mercadoLivreWebhook
 URL cadastrada na aplicação do Mercado Livre (Notificações):
   https://nagilazortea.com.br/.netlify/functions/mercadoLivreWebhook
 POST { _id, resource, user_id, topic, application_id, attempts, sent, received }

 - Confere application_id (= MERCADO_LIVRE_CLIENT_ID), user_id (conta conectada),
   tópico (orders_v2, shipments) e o formato do resource.
 - Grava a notificação em processed_notifications (status pending) e só então responde 200.
   Notificação repetida (_id já gravado) também recebe 200, sem gravar de novo.
 - Falha ao gravar -> 503, para o Mercado Livre reenviar.
 - Não processa o pedido aqui: quem processa é processPending() (Background/Scheduled),
   sempre consultando a API do Mercado Livre — o corpo da notificação não é confiável.
*/

const { json, readBody } = require('../_lib/http');
const { sb } = require('../_lib/supabase');
const ml = require('../_lib/mercadoLivre');
const { CHANNEL, TOPICS, parseResource } = require('../_lib/mercadoLivreSync');

const NOTIFICATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KICK_TIMEOUT_MS = 1500;

// Aciona a Background Function (opcional; a Scheduled Function cobre se isto falhar)
async function kickProcessor(config) {
  if (process.env.MERCADO_LIVRE_BACKGROUND_PROCESSING !== 'true') return;
  const base = (process.env.URL || process.env.SITE_URL || '').replace(/\/$/, '');
  if (!base) return;
  try {
    await fetch(`${base}/.netlify/functions/mercadoLivreProcess-background`, {
      method: 'POST',
      headers: { 'x-nz-internal': ml.internalToken(config) },
      signal: AbortSignal.timeout(KICK_TIMEOUT_MS)
    });
  } catch {
    // sem problema: a notificação já está gravada
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const cfg = ml.mlConfig();
  if (!cfg.ok) {
    console.error('mercadoLivreWebhook:', new ml.ConfigError(cfg.missing).message);
    return json(503, { error: 'Not configured' });
  }

  const body = readBody(event);
  if (!body) return json(400, { error: 'Invalid JSON' });

  if (String(body.application_id ?? '') !== cfg.config.clientId) {
    console.warn('mercadoLivreWebhook: application_id diferente do configurado');
    return json(403, { error: 'Unknown application' });
  }

  const topic = typeof body.topic === 'string' ? body.topic : '';
  // Outros tópicos assinados por engano: confirma para não haver reenvio, sem gravar
  if (!TOPICS.includes(topic)) return json(200, { ok: true, ignored: 'topic' });

  const notificationId = typeof body._id === 'string' ? body._id : '';
  const sellerId = /^\d{1,20}$/.test(String(body.user_id ?? '')) ? String(body.user_id) : '';
  const resource = typeof body.resource === 'string' ? body.resource : '';
  if (!NOTIFICATION_ID_RE.test(notificationId) || !sellerId || !parseResource(topic, resource)) {
    return json(400, { error: 'Invalid notification' });
  }

  try {
    const integration = await ml.loadIntegration(sellerId);
    if (!integration) {
      console.warn('mercadoLivreWebhook: vendedor não conectado', sellerId);
      return json(403, { error: 'Unknown seller' });
    }

    // Grava só campos conhecidos (nada além do que o Mercado Livre manda na notificação)
    const payload = {
      _id: notificationId,
      topic,
      resource,
      user_id: sellerId,
      application_id: String(body.application_id),
      attempts: Number.isInteger(body.attempts) ? body.attempts : null,
      sent: typeof body.sent === 'string' ? body.sent.slice(0, 40) : null,
      received: typeof body.received === 'string' ? body.received.slice(0, 40) : null
    };
    const inserted = await sb('processed_notifications?on_conflict=provider,provider_notification_id', {
      method: 'POST',
      prefer: 'resolution=ignore-duplicates,return=representation',
      body: {
        provider: CHANNEL,
        provider_notification_id: notificationId,
        topic,
        resource,
        payload,
        status: 'pending',
        attempts: 0,
        next_attempt_at: new Date().toISOString()
      }
    });
    if (!inserted || !inserted.length) return json(200, { ok: true, duplicate: true });

    await kickProcessor(cfg.config);
    return json(200, { ok: true });
  } catch (err) {
    console.error('mercadoLivreWebhook: falha ao gravar a notificação', String((err && err.message) || '').split(':')[0]);
    return json(503, { error: 'Temporarily unavailable' });
  }
};
