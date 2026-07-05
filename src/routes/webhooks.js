'use strict';

/**
 * Webhooks — inbound email ingestion endpoint.
 *
 * Two ingestion modes:
 *
 * 1. JSON webhook (POST /webhooks/email)
 *    Body: { from, name?, subject, body, receivedAt?, attachments?: [{filename, contentBase64, mimeType}] }
 *    Auth: ?token=<EMAIL_WEBHOOK_TOKEN> or X-Webhook-Token header
 *
 *    This is what n8n / SendGrid Inbound Parse / Mailgun Routes would POST to.
 *
 * 2. .eml upload (POST /webhooks/email/eml) — multipart/form-data with field `file`
 *    Useful for "drag-and-drop a saved .eml" testing in the UI.
 */

const express = require('express');
const multer = require('multer');
const config = require('../config');
const logger = require('../utils/logger').child('webhook');
const emailService = require('../services/emailService');
const ticketService = require('../services/ticketService');
const db = require('../database/db');
const { nowIso } = require('../utils/helpers');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.email.maxAttachmentMb * 1024 * 1024 * 4 }, // generous for whole .eml
});
const log = logger;

// ---------------------------------------------------------------
// Auth middleware — token-based
// ---------------------------------------------------------------
function auth(req, res, next) {
  const token = req.query.token || req.header('X-Webhook-Token');
  if (!token || token !== config.email.webhookToken) {
    log.warn('Webhook auth failed', { ip: req.ip, tokenProvided: !!token });
    return res.status(401).json({ error: 'invalid or missing webhook token' });
  }
  next();
}

function logInbox(entry) {
  try {
    db.run(
      `INSERT INTO inbox_log (message_id, sender_email, subject, received_at, status, reason, ticket_id, is_spam, created_at)
       VALUES (@mid, @email, @subject, @at, @status, @reason, @ticketId, @isSpam, @created)`,
      {
        mid: entry.messageId || null,
        email: entry.senderEmail || null,
        subject: entry.subject || null,
        at: entry.receivedAt || nowIso(),
        status: entry.status,
        reason: entry.reason || null,
        ticketId: entry.ticketId || null,
        isSpam: entry.isSpam ? 1 : 0,
        created: nowIso(),
      }
    );
  } catch (e) {
    log.warn('inbox_log write failed', { error: e.message });
  }
}

// ---------------------------------------------------------------
// POST /webhooks/email — JSON payload
// ---------------------------------------------------------------
router.post('/email', auth, express.json({ limit: '25mb' }), async (req, res) => {
  try {
    const inbound = emailService.parseWebhookPayload(req.body);
    const validation = emailService.validateInbound(inbound);
    if (!validation.ok) {
      log.warn('Webhook inbound rejected', { errors: validation.errors });
      logInbox({ ...inbound, status: 'skipped', reason: validation.errors.join('; ') });
      return res.status(400).json({ error: 'invalid email payload', details: validation.errors });
    }

    const result = await ticketService.createFromEmail(inbound, { sendAck: true });
    if (result.spam?.autoRejected) {
      logInbox({ ...inbound, status: 'skipped', reason: `spam auto-rejected (score ${result.spam.spam_score})`, isSpam: true });
      return res.status(200).json({
        spam_auto_rejected: true,
        spam_score: result.spam.spam_score,
        reasons: result.spam.reasons,
      });
    }
    logInbox({ ...inbound, status: 'processed', ticketId: result.ticket?.id, isSpam: result.ticket?.is_spam });
    log.info('Webhook created ticket', { ticketId: result.ticket?.id, category: result.ticket?.category, isSpam: result.ticket?.is_spam });
    return res.status(201).json({
      ticket_id: result.ticket.id,
      status: result.ticket.status,
      category: result.ticket.category,
      priority: result.ticket.priority,
      assigned_team: result.ticket.assigned_team,
      assigned_agent: result.assignedAgent,
      confidence: result.ticket.confidence_score,
      language: result.ticket.language,
      is_spam: result.ticket.is_spam,
      spam_score: result.spam?.spam_score,
      kb_suggestions: (result.kbSuggestions || []).map((a) => ({ id: a.id, title: a.title })),
      duplicate_of: result.duplicate ? result.duplicate.id : null,
      ai_used_mock: result.ai.usedMock,
      ack_sent: result.ack.sent,
      warnings: result.warnings,
    });
  } catch (err) {
    log.error('Webhook /email failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'internal error', message: err.message });
  }
});

// ---------------------------------------------------------------
// POST /webhooks/email/eml — multipart .eml upload
// ---------------------------------------------------------------
router.post('/email/eml', auth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no file uploaded (field name must be "file")' });
    const raw = req.file.buffer.toString('utf8');
    const inbound = emailService.parseEmlString(raw, req.file.originalname);
    const validation = emailService.validateInbound(inbound);
    if (!validation.ok) {
      logInbox({ ...inbound, status: 'skipped', reason: validation.errors.join('; ') });
      return res.status(400).json({ error: 'invalid eml', details: validation.errors });
    }
    const result = await ticketService.createFromEmail(inbound, { sendAck: true });
    if (result.spam?.autoRejected) {
      logInbox({ ...inbound, status: 'skipped', reason: `spam auto-rejected (score ${result.spam.spam_score})`, isSpam: true });
      return res.status(200).json({ spam_auto_rejected: true, spam_score: result.spam.spam_score });
    }
    logInbox({ ...inbound, status: 'processed', ticketId: result.ticket?.id, isSpam: result.ticket?.is_spam });
    return res.status(201).json({
      ticket_id: result.ticket.id,
      status: result.ticket.status,
      category: result.ticket.category,
      priority: result.ticket.priority,
      assigned_team: result.ticket.assigned_team,
      assigned_agent: result.assignedAgent,
      confidence: result.ticket.confidence_score,
      language: result.ticket.language,
      is_spam: result.ticket.is_spam,
      duplicate_of: result.duplicate ? result.duplicate.id : null,
      ai_used_mock: result.ai.usedMock,
      ack_sent: result.ack.sent,
      warnings: result.warnings,
    });
  } catch (err) {
    log.error('Webhook /email/eml failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'internal error', message: err.message });
  }
});

module.exports = router;
