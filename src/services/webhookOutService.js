'use strict';

/**
 * Outbound Webhook Service — emit events to subscribed endpoints.
 *
 * Subscriptions are stored in webhook_subscriptions. When an event fires
 * (e.g. ticket_created, sla_breach), the engine:
 *   1. Finds all active subscriptions whose events array includes the event
 *   2. Builds a payload with the event name, timestamp, and ticket context
 *   3. Signs the payload with HMAC-SHA256 using the subscription's secret
 *      (header: X-Webhook-Signature)
 *   4. POSTs to the target URL with exponential backoff retries
 *   5. Records every delivery attempt in webhook_deliveries
 *
 * Retries: 5 attempts at 1s, 5s, 30s, 2min, 10min. After that, marked failed.
 */

const db = require('../database/db');
const crypto = require('crypto');
const { generateId, nowIso } = require('../utils/helpers');
const { asString, asArray } = require('../utils/validator');
const logger = require('../utils/logger').child('webhook-out');
const log = logger;

const fetch = globalThis.fetch;

const EVENT_TYPES = [
  'ticket_created', 'ticket_updated', 'ticket_resolved', 'ticket_closed',
  'ticket_rejected', 'ticket_escalated', 'ticket_assigned',
  'sla_breach', 'spam_detected', 'critical_priority',
  'customer_vip_marked', 'agent_created',
];

const RETRY_DELAYS = [0, 5000, 30000, 120000, 600000]; // 0s, 5s, 30s, 2min, 10min

// ---------------------------------------------------------------
// Subscription CRUD
// ---------------------------------------------------------------

function listSubscriptions({ isActive = true } = {}) {
  const where = isActive !== undefined ? `WHERE is_active = ${isActive ? 1 : 0}` : '';
  return db.all(`SELECT * FROM webhook_subscriptions ${where} ORDER BY created_at DESC`).map(rowToSubscription);
}

function getSubscription(id) {
  const row = db.get(`SELECT * FROM webhook_subscriptions WHERE id = @id`, { id });
  return row ? rowToSubscription(row) : null;
}

function createSubscription({ name, targetUrl, secret, events }) {
  if (!name) throw new Error('name is required');
  if (!targetUrl) throw new Error('targetUrl is required');
  if (!targetUrl.startsWith('http')) throw new Error('targetUrl must start with http:// or https://');
  if (!Array.isArray(events) || !events.length) throw new Error('events array required');
  for (const e of events) {
    if (!EVENT_TYPES.includes(e)) throw new Error(`invalid event: ${e}`);
  }

  const id = generateId('whsub');
  const now = nowIso();
  const row = {
    id, name: asString(name, 100), target_url: targetUrl,
    secret: secret || null,
    events: JSON.stringify(events),
    is_active: 1, created_at: now,
  };
  db.run(
    `INSERT INTO webhook_subscriptions (id, name, target_url, secret, events, is_active, created_at)
     VALUES (@id, @name, @target_url, @secret, @events, @is_active, @created_at)`,
    row
  );
  log.info('Webhook subscription created', { id, name, targetUrl, events });
  return getSubscription(id);
}

function updateSubscription(id, patch) {
  const existing = getSubscription(id);
  if (!existing) return null;
  const allowed = ['name', 'target_url', 'secret', 'events', 'is_active'];
  const setClauses = [];
  const params = { id };
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    let v = patch[k];
    if (k === 'events') v = JSON.stringify(asArray(v, 50));
    else if (k === 'is_active') v = v ? 1 : 0;
    else v = asString(v, 500);
    setClauses.push(`${k} = @${k}`);
    params[k] = v;
  }
  if (setClauses.length === 0) return existing;
  db.run(`UPDATE webhook_subscriptions SET ${setClauses.join(', ')} WHERE id = @id`, params);
  return getSubscription(id);
}

function removeSubscription(id) {
  const r = db.run(`DELETE FROM webhook_subscriptions WHERE id = @id`, { id });
  return r.changes > 0;
}

// ---------------------------------------------------------------
// Event emission
// ---------------------------------------------------------------

/**
 * Emit an event to all matching subscriptions.
 * @param {string} event  one of EVENT_TYPES
 * @param {object} payload  { ticketId, ... }
 */
async function emit(event, payload = {}) {
  if (!EVENT_TYPES.includes(event)) {
    log.warn('Unknown webhook event', { event });
    return { emitted: 0 };
  }

  const subscriptions = db.all(`SELECT * FROM webhook_subscriptions WHERE is_active = 1`)
    .filter((s) => {
      try { return JSON.parse(s.events || '[]').includes(event); } catch { return false; }
    });

  if (!subscriptions.length) return { emitted: 0 };

  let emitted = 0;
  for (const sub of subscriptions) {
    await deliver(sub, event, payload);
    emitted++;
  }
  return { emitted };
}

/**
 * Deliver one event to one subscription (with HMAC signing).
 */
async function deliver(sub, event, payload) {
  const body = JSON.stringify({
    event,
    timestamp: nowIso(),
    data: payload,
  });

  const deliveryId = recordDelivery(sub.id, event, payload.ticketId, body);

  // Sign with HMAC-SHA256 if secret is set
  const headers = { 'Content-Type': 'application/json', 'X-Webhook-Event': event };
  if (sub.secret) {
    const sig = crypto.createHmac('sha256', sub.secret).update(body).digest('hex');
    headers['X-Webhook-Signature'] = `sha256=${sig}`;
    headers['X-Webhook-Signature-Alg'] = 'hmac-sha256';
  }

  // Attempt delivery with retries
  for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
    if (RETRY_DELAYS[attempt] > 0) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
    }

    try {
      const res = await fetch(sub.target_url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10000),
      });
      const responseText = await res.text().catch(() => '');

      if (res.ok) {
        markDelivered(deliveryId, res.status, responseText.slice(0, 500));
        log.debug('Webhook delivered', { sub: sub.name, event, status: res.status, attempt: attempt + 1 });
        return;
      }

      // 4xx = don't retry (client error)
      if (res.status >= 400 && res.status < 500) {
        markFailed(deliveryId, res.status, responseText.slice(0, 500), true);
        log.warn('Webhook 4xx — not retrying', { sub: sub.name, event, status: res.status });
        return;
      }

      // 5xx = retry
      markAttempt(deliveryId, res.status, responseText.slice(0, 500));
    } catch (err) {
      markAttempt(deliveryId, 0, err.message);
    }
  }

  // All retries exhausted
  markFailed(deliveryId, 0, 'all retries exhausted', false);
  log.warn('Webhook delivery failed after retries', { sub: sub.name, event });
}

function recordDelivery(subscriptionId, event, ticketId, payload) {
  const r = db.run(
    `INSERT INTO webhook_deliveries (subscription_id, event, ticket_id, payload, status, attempts, created_at)
     VALUES (@subId, @event, @ticketId, @payload, 'pending', 0, @now)`,
    { subId: subscriptionId, event, ticketId: ticketId || null, payload, now: nowIso() }
  );
  return r.lastInsertRowid;
}

function markAttempt(deliveryId, responseStatus, responseBody) {
  db.run(
    `UPDATE webhook_deliveries SET attempts = attempts + 1, last_attempt_at = @now, response_status = @rs, response_body = @rb WHERE id = @id`,
    { now: nowIso(), rs: responseStatus, rb: responseBody, id: deliveryId }
  );
}

function markDelivered(deliveryId, responseStatus, responseBody) {
  db.run(
    `UPDATE webhook_deliveries SET status = 'delivered', attempts = attempts + 1, last_attempt_at = @now, response_status = @rs, response_body = @rb, delivered_at = @now WHERE id = @id`,
    { now: nowIso(), rs: responseStatus, rb: responseBody, id: deliveryId }
  );
}

function markFailed(deliveryId, responseStatus, responseBody, permanent) {
  db.run(
    `UPDATE webhook_deliveries SET status = 'failed', attempts = attempts + 1, last_attempt_at = @now, response_status = @rs, response_body = @rb WHERE id = @id`,
    { now: nowIso(), rs: responseStatus, rb: responseBody, id: deliveryId }
  );
}

// ---------------------------------------------------------------
// Delivery log
// ---------------------------------------------------------------

function listDeliveries({ status, subscriptionId, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = { limit, offset };
  if (status) { where.push('status = @status'); params.status = status; }
  if (subscriptionId) { where.push('subscription_id = @subId'); params.subId = subscriptionId; }
  const sql = `SELECT * FROM webhook_deliveries ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY id DESC LIMIT @limit OFFSET @offset`;
  return db.all(sql, params);
}

function retryDelivery(deliveryId) {
  const d = db.get(`SELECT * FROM webhook_deliveries WHERE id = @id`, { id: deliveryId });
  if (!d) throw new Error('delivery not found');
  const sub = db.get(`SELECT * FROM webhook_subscriptions WHERE id = @id`, { id: d.subscription_id });
  if (!sub || !sub.is_active) throw new Error('subscription inactive');
  // Re-queue by resetting status
  db.run(`UPDATE webhook_deliveries SET status = 'pending', attempts = 0 WHERE id = @id`, { id: deliveryId });
  // Fire and forget
  deliver(sub, d.event, JSON.parse(d.payload || '{}')).catch((err) => log.error('Retry failed', { error: err.message }));
  return { ok: true };
}

/**
 * Sweep pending deliveries that need another attempt.
 * Called by the background sweeper in app.js.
 */
async function sweepPending() {
  // For simplicity, we don't re-queue here — retries are inline in deliver()
  // This could be enhanced to use a proper queue (BullMQ, etc.)
  return { swept: 0 };
}

function rowToSubscription(row) {
  if (!row) return null;
  let events = [];
  try { events = JSON.parse(row.events || '[]'); } catch { /* ignore */ }
  return {
    ...row,
    events,
    is_active: !!row.is_active,
  };
}

module.exports = {
  EVENT_TYPES, RETRY_DELAYS,
  listSubscriptions, getSubscription, createSubscription, updateSubscription, removeSubscription,
  emit, deliver, listDeliveries, retryDelivery, sweepPending,
};
