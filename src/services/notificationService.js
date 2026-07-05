'use strict';

/**
 * Notification service — outbound notifications to Slack, Microsoft Teams,
 * generic webhooks, and email digest. Also records every notification in
 * the `notifications` table for audit.
 *
 * Channels are configured via env vars (SLACK_WEBHOOK_URL, TEAMS_WEBHOOK_URL,
 * DIGEST_EMAIL) and/or via the `notification_channels` table.
 */

const db = require('../database/db');
const config = require('../config');
const { generateId, nowIso } = require('../utils/helpers');
const logger = require('../utils/logger').child('notif');
const log = logger;

const fetch = globalThis.fetch;

// ---------------------------------------------------------------
// Channel management (DB-backed)
// ---------------------------------------------------------------

function listChannels() {
  return db.all(`SELECT * FROM notification_channels ORDER BY created_at DESC`);
}

function addChannel({ name, type, target, events = [] }) {
  const id = generateId('ch');
  const now = nowIso();
  db.run(
    `INSERT INTO notification_channels (id, name, type, target, events, is_active, created_at)
     VALUES (@id, @name, @type, @target, @events, 1, @now)`,
    { id, name, target, type, events: JSON.stringify(events), now }
  );
  return { id, name, type, target, events, is_active: true };
}

function removeChannel(id) {
  const r = db.run(`DELETE FROM notification_channels WHERE id = @id`, { id });
  return r.changes > 0;
}

// ---------------------------------------------------------------
// Notify — fan out an event to all matching channels
// ---------------------------------------------------------------

/**
 * @param {string} event    e.g. ticket_created, sla_breach, escalation, spam_detected
 * @param {object} payload  JSON-serialisable context
 */
async function notify(event, payload) {
  const channels = getMatchingChannels(event);
  const envChannels = getEnvChannels(event);

  const all = [...channels, ...envChannels];
  if (!all.length) return { sent: 0, failed: 0 };

  let sent = 0, failed = 0;
  for (const ch of all) {
    const result = await sendToChannel(ch, event, payload);
    recordNotification({ type: ch.type, target: ch.target, event, ticketId: payload?.ticketId, payload, status: result.ok ? 'sent' : 'failed', error: result.error });
    if (result.ok) sent++; else failed++;
  }
  return { sent, failed };
}

function getMatchingChannels(event) {
  const rows = db.all(`SELECT * FROM notification_channels WHERE is_active = 1`);
  return rows.filter((r) => {
    try { return JSON.parse(r.events || '[]').includes(event); } catch { return false; }
  }).map((r) => ({ id: r.id, type: r.type, target: r.target, name: r.name }));
}

function getEnvChannels(event) {
  if (!config.notifications.defaultEvents.includes(event)) return [];
  const out = [];
  if (config.notifications.slackWebhookUrl) out.push({ type: 'slack', target: config.notifications.slackWebhookUrl, name: 'env:slack' });
  if (config.notifications.teamsWebhookUrl) out.push({ type: 'teams', target: config.notifications.teamsWebhookUrl, name: 'env:teams' });
  return out;
}

async function sendToChannel(ch, event, payload) {
  try {
    if (ch.type === 'slack') return await sendSlack(ch.target, event, payload);
    if (ch.type === 'teams') return await sendTeams(ch.target, event, payload);
    if (ch.type === 'webhook') return await sendGenericWebhook(ch.target, event, payload);
    if (ch.type === 'email') return await sendEmailDigest(ch.target, event, payload);
    return { ok: false, error: `unknown channel type: ${ch.type}` };
  } catch (err) {
    log.error('Notification send failed', { type: ch.type, event, error: err.message });
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------
// Slack
// ---------------------------------------------------------------

async function sendSlack(webhookUrl, event, payload) {
  const color = colorForEvent(event);
  const text = textForEvent(event, payload);
  const body = {
    attachments: [{
      color,
      title: `${event.toUpperCase()} — ${payload?.ticketId || ''}`,
      title_link: payload?.ticketId ? `${config.urls?.dashboard || 'http://localhost:' + config.port}/ticket.html?id=${payload.ticketId}` : undefined,
      text,
      fields: [
        { title: 'Priority', value: payload?.priority || '-', short: true },
        { title: 'Team', value: payload?.team || '-', short: true },
        { title: 'Category', value: payload?.category || '-', short: true },
        ...(payload?.level ? [{ title: 'Escalation Level', value: String(payload.level), short: true }] : []),
      ],
      ts: Math.floor(Date.now() / 1000),
    }],
  };
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    return { ok: false, error: `Slack HTTP ${res.status}: ${txt.slice(0, 200)}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------
// Microsoft Teams
// ---------------------------------------------------------------

async function sendTeams(webhookUrl, event, payload) {
  const themeColor = colorForEvent(event).replace('#', '');
  const text = textForEvent(event, payload);
  const body = {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    themeColor,
    summary: `${event} — ${payload?.ticketId || ''}`,
    title: `${event.toUpperCase()}${payload?.ticketId ? ' — ' + payload.ticketId : ''}`,
    text,
    sections: [{
      facts: [
        { name: 'Priority', value: payload?.priority || '-' },
        { name: 'Team', value: payload?.team || '-' },
        { name: 'Category', value: payload?.category || '-' },
        ...(payload?.level ? [{ name: 'Escalation Level', value: String(payload.level) }] : []),
        ...(payload?.reason ? [{ name: 'Reason', value: payload.reason }] : []),
      ],
    }],
  };
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    return { ok: false, error: `Teams HTTP ${res.status}: ${txt.slice(0, 200)}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------
// Generic webhook
// ---------------------------------------------------------------

async function sendGenericWebhook(url, event, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Event': event },
    body: JSON.stringify({ event, timestamp: nowIso(), payload }),
  });
  if (!res.ok) return { ok: false, error: `Webhook HTTP ${res.status}` };
  return { ok: true };
}

// ---------------------------------------------------------------
// Email digest (logged when SMTP disabled)
// ---------------------------------------------------------------

async function sendEmailDigest(email, event, payload) {
  if (!config.smtp.enabled) {
    log.info(`[email-digest → ${email}] ${event}: ${textForEvent(event, payload)}`);
    return { ok: true, logged: true };
  }
  // Use the existing ackService transport
  const ackService = require('./ackService');
  const transporter = ackService._getTransporter ? ackService._getTransporter() : null;
  if (!transporter) {
    log.info(`[email-digest → ${email}] (no transporter) ${event}: ${textForEvent(event, payload)}`);
    return { ok: true, logged: true };
  }
  await transporter.sendMail({
    from: config.smtp.from,
    to: email,
    subject: `[Support Desk] ${event}: ${payload?.ticketId || ''}`,
    text: textForEvent(event, payload),
  });
  return { ok: true };
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function colorForEvent(event) {
  switch (event) {
    case 'critical_priority':
    case 'sla_breach':
    case 'escalation': return '#dc2626';
    case 'spam_detected': return '#9333ea';
    case 'ticket_created': return '#10b981';
    case 'ticket_resolved': return '#3b82f6';
    default: return '#6b7280';
  }
}

function textForEvent(event, payload) {
  switch (event) {
    case 'ticket_created':
      return `New ticket from ${payload?.senderEmail || 'customer'}: ${payload?.subject || '(no subject)'}\nCategory: ${payload?.category || '-'}, Priority: ${payload?.priority || '-'}`;
    case 'critical_priority':
      return `Critical priority ticket ${payload?.ticketId}: ${payload?.subject || ''}`;
    case 'sla_breach':
      return `SLA breach on ticket ${payload?.ticketId} — ${payload?.reason || 'overdue'}`;
    case 'escalation':
      return `Ticket ${payload?.ticketId} escalated to level ${payload?.level}. Reason: ${payload?.reason || '-'}. Action: ${payload?.description || '-'}`;
    case 'spam_detected':
      return `Spam detected on ticket ${payload?.ticketId} (score ${payload?.spamScore || '-'})`;
    case 'ticket_resolved':
      return `Ticket ${payload?.ticketId} resolved`;
    default:
      return `${event}: ${JSON.stringify(payload).slice(0, 400)}`;
  }
}

// ---------------------------------------------------------------
// Record in DB
// ---------------------------------------------------------------

function recordNotification({ type, target, event, ticketId, payload, status, error }) {
  try {
    db.run(
      `INSERT INTO notifications (type, target, event, ticket_id, payload, status, error, attempts, created_at, sent_at)
       VALUES (@type, @target, @event, @tid, @payload, @status, @error, 1, @now, @sentAt)`,
      {
        type, target, event,
        tid: ticketId || null,
        payload: payload ? JSON.stringify(payload) : null,
        status, error: error || null,
        now: nowIso(),
        sentAt: status === 'sent' ? nowIso() : null,
      }
    );
  } catch (e) {
    log.warn('Failed to record notification', { error: e.message });
  }
}

function listNotifications({ status, limit = 100 } = {}) {
  const where = status ? 'WHERE status = @status' : '';
  return db.all(`SELECT * FROM notifications ${where} ORDER BY id DESC LIMIT @limit`, { status, limit });
}

module.exports = {
  notify,
  listChannels,
  addChannel,
  removeChannel,
  listNotifications,
  // exposed for tests
  _sendSlack: sendSlack,
  _sendTeams: sendTeams,
  _colorForEvent: colorForEvent,
  _textForEvent: textForEvent,
};
