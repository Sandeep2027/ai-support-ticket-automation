'use strict';

/**
 * REST API v2 — production endpoints for the support dashboard.
 *
 * All endpoints return JSON (except /api/metrics → text/plain).
 * Routes are mounted under /api in app.js.
 *
 * Tickets:
 *   GET    /api/health
 *   GET    /api/metrics                  (Prometheus format)
 *   GET    /api/stats
 *   GET    /api/tickets                  ?status&priority&category&team&agentId&isSpam&escalated&q&limit&offset
 *   GET    /api/tickets/search?q=...     (FTS5 full-text search)
 *   GET    /api/tickets/:id
 *   PATCH  /api/tickets/:id
 *   POST   /api/tickets/:id/notes
 *   GET    /api/tickets/:id/audit
 *   GET    /api/tickets/:id/attachments
 *   GET    /api/tickets/:id/attachments/:attId
 *   GET    /api/tickets/:id/tags
 *   POST   /api/tickets/:id/tags         { name, color? }
 *   DELETE /api/tickets/:id/tags/:tagId
 *   POST   /api/tickets/:id/suggest-reply
 *   POST   /api/tickets/:id/suggest-resolution
 *   POST   /api/tickets/:id/assign-best  (auto-pick best agent)
 *   POST   /api/tickets/:id/escalate     (manual escalation)
 *   POST   /api/tickets/:id/merge        { parentId }
 *   GET    /api/tickets/export.csv       (CSV export)
 *
 * Agents:
 *   GET    /api/agents
 *   POST   /api/agents
 *   GET    /api/agents/:id
 *   PATCH  /api/agents/:id
 *   DELETE /api/agents/:id
 *   GET    /api/agents/:id/api-keys
 *   POST   /api/agents/:id/api-keys      { name, expiresInDays? }  → returns plaintext key ONCE
 *   DELETE /api/agents/:id/api-keys/:keyId
 *   GET    /api/agents/workload          (workload + utilisation)
 *   GET    /api/agents/leaderboard       (performance metrics)
 *
 * Knowledge Base:
 *   GET    /api/kb
 *   POST   /api/kb
 *   GET    /api/kb/:id
 *   PATCH  /api/kb/:id
 *   DELETE /api/kb/:id
 *   POST   /api/kb/:id/view              (increment view count)
 *   POST   /api/kb/:id/helpful           (mark helpful)
 *   GET    /api/kb/search?q=...
 *   GET    /api/kb/stats
 *
 * Customers:
 *   GET    /api/customers                ?q&isVip
 *   GET    /api/customers/:email         (360 view)
 *   POST   /api/customers/:email/vip     { isVip }
 *   PATCH  /api/customers/:email/notes   { notes }
 *
 * Routing:
 *   GET    /api/routing
 *   PUT    /api/routing/:category
 *
 * Notifications:
 *   GET    /api/notifications/channels
 *   POST   /api/notifications/channels
 *   DELETE /api/notifications/channels/:id
 *   GET    /api/notifications            (audit log)
 *
 * Escalations:
 *   GET    /api/escalations              (currently escalated tickets)
 *   POST   /api/escalations/sweep        (run sweep manually)
 *
 * Reports:
 *   GET    /api/reports/full             (master dashboard report)
 *   GET    /api/reports/timeseries       ?days=30
 *   GET    /api/reports/agents
 *   GET    /api/reports/teams
 *   GET    /api/reports/sla
 *   GET    /api/reports/spam
 *
 * Bulk:
 *   POST   /api/bulk/update              { ticketIds, patch }
 *   POST   /api/bulk/assign              { ticketIds, agentId }
 *   POST   /api/bulk/close               { ticketIds }
 *   POST   /api/bulk/tag                 { ticketIds, tagName }
 *   POST   /api/bulk/import              (JSON array of emails)
 *   GET    /api/bulk/export.csv
 *
 * Samples & inbox:
 *   GET    /api/samples
 *   POST   /api/samples/:filename/ingest
 *   GET    /api/inbox-log
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const config = require('../config');
const logger = require('../utils/logger').child('api');
const ticketService = require('../services/ticketService');
const emailService = require('../services/emailService');
const routingService = require('../services/routingService');
const attachmentService = require('../services/attachmentService');
const agentService = require('../services/agentService');
const kbService = require('../services/kbService');
const customerService = require('../services/customerService');
const escalationService = require('../services/escalationService');
const notificationService = require('../services/notificationService');
const reportService = require('../services/reportService');
const bulkService = require('../services/bulkService');
const metricsService = require('../services/metricsService');
const authService = require('../services/authService');
const aiService = require('../services/aiService');
const db = require('../database/db');

const router = express.Router();
const log = logger;

// Apply auth + request counting to all /api routes
router.use((req, _res, next) => { metricsService.inc('api_requests'); next(); });
router.use(authService.middleware);

// ---------------------------------------------------------------
// Health & metrics
// ---------------------------------------------------------------
router.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    ai: aiService.providerInfo(),
    smtp: { enabled: config.smtp.enabled },
    features: config.features,
    auth: { enabled: config.auth.enabled, agent: _req.agent?.name || 'system' },
  });
});

router.get('/metrics', (_req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4');
  res.send(metricsService.render());
});

// ---------------------------------------------------------------
// Stats
// ---------------------------------------------------------------
router.get('/stats', (_req, res) => res.json(ticketService.stats()));

// ---------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------
router.get('/tickets', (req, res) => {
  const { status, priority, category, team, agentId, isSpam, escalated, q, limit, offset } = req.query;
  res.json(ticketService.list({
    status, priority, category, team, agentId,
    isSpam: isSpam === undefined ? undefined : isSpam === 'true',
    escalated: escalated === undefined ? undefined : escalated === 'true',
    q,
    limit: Math.min(Number(limit) || 100, 500),
    offset: Number(offset) || 0,
  }));
});

router.get('/tickets/search', (req, res) => {
  const q = req.query.q || '';
  if (!q.trim()) return res.json([]);
  res.json(ticketService.ftsSearch(q, { limit: Math.min(Number(req.query.limit) || 50, 200) }));
});

router.get('/tickets/export.csv', (req, res) => {
  const { status, priority, category, team, q } = req.query;
  const csv = bulkService.exportCsv({ status, priority, category, team, q });
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', `attachment; filename="tickets-${Date.now()}.csv"`);
  res.send(csv);
});

router.get('/tickets/:id', (req, res) => {
  const ticket = ticketService.get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'ticket not found' });
  const audit = ticketService.getAuditTrail(req.params.id);
  const notes = ticketService.getNotes(req.params.id);
  const attachments = ticketService.getAttachments(req.params.id);
  const tags = ticketService.getTags(req.params.id);
  const escalations = escalationService.historyForTicket(req.params.id);
  res.json({ ticket, audit, notes, attachments, tags, escalations });
});

router.patch('/tickets/:id', (req, res) => {
  const actor = `agent:${req.agent?.id || 'anonymous'}`;
  try {
    const updated = ticketService.update(req.params.id, req.body || {}, actor);
    if (!updated) return res.status(404).json({ error: 'ticket not found' });
    res.json(updated);
  } catch (err) {
    metricsService.inc('api_errors');
    res.status(400).json({ error: err.message });
  }
});

router.post('/tickets/:id/notes', (req, res) => {
  const actor = `agent:${req.agent?.id || 'anonymous'}`;
  const note = (req.body && req.body.note) || '';
  if (!note.trim()) return res.status(400).json({ error: 'note is required' });
  try {
    res.json(ticketService.addNote(req.params.id, note, actor, req.body.is_internal !== false));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/tickets/:id/audit', (req, res) => res.json(ticketService.getAuditTrail(req.params.id)));

router.get('/tickets/:id/attachments', (req, res) => res.json(ticketService.getAttachments(req.params.id)));

router.get('/tickets/:id/attachments/:attId', (req, res) => {
  const att = attachmentService.get(req.params.attId);
  if (!att || att.ticket_id !== req.params.id) return res.status(404).json({ error: 'attachment not found' });
  res.download(attachmentService.absolutePath(att.storage_path), att.filename);
});

router.get('/tickets/:id/tags', (req, res) => res.json(ticketService.getTags(req.params.id)));

router.post('/tickets/:id/tags', (req, res) => {
  const { name, color } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const tag = ticketService.addTag(req.params.id, name, color);
  res.status(201).json(tag);
});

router.delete('/tickets/:id/tags/:tagId', (req, res) => {
  ticketService.removeTag(req.params.id, Number(req.params.tagId));
  res.json({ ok: true });
});

router.post('/tickets/:id/suggest-reply', async (req, res) => {
  try { res.json(await ticketService.suggestReply(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/tickets/:id/suggest-resolution', async (req, res) => {
  try { res.json(await ticketService.suggestResolution(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/tickets/:id/assign-best', (req, res) => {
  const ticket = ticketService.get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'ticket not found' });
  const agent = agentService.findBestAgent({ team: ticket.assigned_team, category: ticket.category });
  if (!agent) return res.status(404).json({ error: 'no available agent' });
  const updated = ticketService.update(req.params.id, { assigned_agent_id: agent.id }, `agent:${req.agent?.id || 'system'}`);
  res.json({ ticket: updated, agent });
});

router.post('/tickets/:id/escalate', (req, res) => {
  const actor = `agent:${req.agent?.id || 'system'}`;
  const result = escalationService.escalateManual(req.params.id, actor);
  if (!result) return res.status(400).json({ error: 'cannot escalate (ticket not found or max level reached)' });
  res.json(result);
});

router.post('/tickets/:id/merge', (req, res) => {
  const { parentId } = req.body || {};
  if (!parentId) return res.status(400).json({ error: 'parentId is required' });
  try {
    const merged = ticketService.mergeInto(req.params.id, parentId, `agent:${req.agent?.id || 'system'}`);
    res.json(merged);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---------------------------------------------------------------
// Agents
// ---------------------------------------------------------------
router.get('/agents', (req, res) => {
  const { team, role, isActive, q } = req.query;
  res.json(agentService.list({ team, role, isActive: isActive === undefined ? undefined : isActive === 'true', q }));
});

router.get('/agents/workload', (_req, res) => res.json(agentService.workload()));
router.get('/agents/leaderboard', (_req, res) => res.json(reportService.agentPerformance()));

router.post('/agents', (req, res) => {
  try {
    const a = agentService.create(req.body || {});
    res.status(201).json(a);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/agents/:id', (req, res) => {
  const a = agentService.get(req.params.id);
  if (!a) return res.status(404).json({ error: 'agent not found' });
  res.json(a);
});

router.patch('/agents/:id', (req, res) => {
  try {
    const a = agentService.update(req.params.id, req.body || {});
    if (!a) return res.status(404).json({ error: 'agent not found' });
    res.json(a);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/agents/:id', (req, res) => {
  try {
    if (!agentService.remove(req.params.id)) return res.status(404).json({ error: 'agent not found' });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/agents/:id/api-keys', (req, res) => res.json(agentService.listApiKeys(req.params.id)));

router.post('/agents/:id/api-keys', (req, res) => {
  try {
    const { name, expiresInDays } = req.body || {};
    const result = agentService.createApiKey(req.params.id, { name, expiresInDays });
    res.status(201).json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/agents/:id/api-keys/:keyId', (req, res) => {
  if (agentService.revokeApiKey(req.params.keyId)) res.json({ ok: true });
  else res.status(404).json({ error: 'key not found' });
});

// ---------------------------------------------------------------
// Knowledge Base
// ---------------------------------------------------------------
router.get('/kb', (req, res) => {
  const { category, tag, q, limit, offset } = req.query;
  res.json(kbService.list({ category, tag, q, limit: Number(limit) || 50, offset: Number(offset) || 0 }));
});

router.get('/kb/search', (req, res) => {
  res.json(kbService.list({ q: req.query.q, limit: Number(req.query.limit) || 20 }));
});

router.get('/kb/stats', (_req, res) => res.json(kbService.stats()));

router.post('/kb', (req, res) => {
  try {
    const a = kbService.create({ ...req.body || {}, authorId: req.agent?.id });
    res.status(201).json(a);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/kb/:id', (req, res) => {
  const a = kbService.get(req.params.id);
  if (!a) return res.status(404).json({ error: 'article not found' });
  res.json(a);
});

router.patch('/kb/:id', (req, res) => {
  const a = kbService.update(req.params.id, req.body || {});
  if (!a) return res.status(404).json({ error: 'article not found' });
  res.json(a);
});

router.delete('/kb/:id', (req, res) => {
  if (kbService.remove(req.params.id)) res.json({ ok: true });
  else res.status(404).json({ error: 'article not found' });
});

router.post('/kb/:id/view', (req, res) => { kbService.incrementView(req.params.id); res.json({ ok: true }); });
router.post('/kb/:id/helpful', (req, res) => { kbService.markHelpful(req.params.id); res.json({ ok: true }); });

// ---------------------------------------------------------------
// Customers
// ---------------------------------------------------------------
router.get('/customers', (req, res) => {
  const { q, isVip, limit, offset } = req.query;
  res.json(customerService.list({ q, isVip: isVip === undefined ? undefined : isVip === 'true', limit: Number(limit) || 50, offset: Number(offset) || 0 }));
});

router.get('/customers/:email', (req, res) => {
  const c = customerService.get360(decodeURIComponent(req.params.email));
  if (!c) return res.status(404).json({ error: 'customer not found' });
  res.json(c);
});

router.post('/customers/:email/vip', (req, res) => {
  const profile = customerService.getByEmail(decodeURIComponent(req.params.email));
  if (!profile) return res.status(404).json({ error: 'customer not found' });
  res.json(customerService.markVip(profile.id, req.body?.isVip !== false));
});

router.patch('/customers/:email/notes', (req, res) => {
  const profile = customerService.getByEmail(decodeURIComponent(req.params.email));
  if (!profile) return res.status(404).json({ error: 'customer not found' });
  res.json(customerService.updateNotes(profile.id, req.body?.notes || ''));
});

// ---------------------------------------------------------------
// Routing
// ---------------------------------------------------------------
router.get('/routing', (_req, res) => res.json(routingService.listConfig()));
router.put('/routing/:category', (req, res) => {
  const team = (req.body && req.body.team) || '';
  if (!team) return res.status(400).json({ error: 'team is required' });
  res.json(routingService.setTeam(decodeURIComponent(req.params.category), team));
});

// ---------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------
router.get('/notifications/channels', (_req, res) => res.json(notificationService.listChannels()));
router.post('/notifications/channels', (req, res) => {
  const { name, type, target, events } = req.body || {};
  if (!name || !type || !target) return res.status(400).json({ error: 'name, type, target required' });
  res.status(201).json(notificationService.addChannel({ name, type, target, events: events || [] }));
});
router.delete('/notifications/channels/:id', (req, res) => {
  if (notificationService.removeChannel(req.params.id)) res.json({ ok: true });
  else res.status(404).json({ error: 'channel not found' });
});
router.get('/notifications', (req, res) => {
  res.json(notificationService.listNotifications({ status: req.query.status, limit: Number(req.query.limit) || 100 }));
});

// ---------------------------------------------------------------
// Escalations
// ---------------------------------------------------------------
router.get('/escalations', (req, res) => {
  res.json(escalationService.listEscalated({ limit: Number(req.query.limit) || 50 }));
});

router.post('/escalations/sweep', (_req, res) => {
  const performed = escalationService.sweep();
  res.json({ swept: performed.length, escalations: performed });
});

// ---------------------------------------------------------------
// Reports
// ---------------------------------------------------------------
router.get('/reports/full', (_req, res) => res.json(reportService.full()));
router.get('/reports/timeseries', (req, res) => {
  const days = Number(req.query.days) || 30;
  res.json({ created: reportService.timeseriesCreated(days), resolved: reportService.timeseriesResolved(days) });
});
router.get('/reports/agents', (_req, res) => res.json(reportService.agentPerformance()));
router.get('/reports/teams', (_req, res) => res.json(reportService.teamWorkload()));
router.get('/reports/sla', (_req, res) => res.json(reportService.slaCompliance()));
router.get('/reports/spam', (_req, res) => res.json(reportService.spamStats()));
router.get('/reports/sentiment', (req, res) => res.json(reportService.sentimentTrend(Number(req.query.days) || 30)));
router.get('/reports/response-times', (_req, res) => res.json(reportService.responseTimes()));

// ---------------------------------------------------------------
// Bulk operations
// ---------------------------------------------------------------
router.post('/bulk/update', (req, res) => {
  const { ticketIds, patch } = req.body || {};
  if (!Array.isArray(ticketIds) || !ticketIds.length) return res.status(400).json({ error: 'ticketIds required' });
  if (!patch || Object.keys(patch).length === 0) return res.status(400).json({ error: 'patch required' });
  res.json(bulkService.bulkUpdate(ticketIds, patch, `agent:${req.agent?.id || 'system'}`));
});

router.post('/bulk/assign', (req, res) => {
  const { ticketIds, agentId } = req.body || {};
  if (!Array.isArray(ticketIds) || !agentId) return res.status(400).json({ error: 'ticketIds and agentId required' });
  res.json(bulkService.bulkAssign(ticketIds, agentId, `agent:${req.agent?.id || 'system'}`));
});

router.post('/bulk/close', (req, res) => {
  const { ticketIds } = req.body || {};
  if (!Array.isArray(ticketIds)) return res.status(400).json({ error: 'ticketIds required' });
  res.json(bulkService.bulkClose(ticketIds, `agent:${req.agent?.id || 'system'}`));
});

router.post('/bulk/tag', (req, res) => {
  const { ticketIds, tagName } = req.body || {};
  if (!Array.isArray(ticketIds) || !tagName) return res.status(400).json({ error: 'ticketIds and tagName required' });
  res.json(bulkService.bulkAddTag(ticketIds, tagName, `agent:${req.agent?.id || 'system'}`));
});

router.post('/bulk/import', async (req, res) => {
  const payloads = Array.isArray(req.body) ? req.body : (req.body?.emails || []);
  if (!Array.isArray(payloads) || !payloads.length) return res.status(400).json({ error: 'array of email payloads required' });
  res.json(await bulkService.bulkImport(payloads, `agent:${req.agent?.id || 'system'}`));
});

// ---------------------------------------------------------------
// Samples & inbox
// ---------------------------------------------------------------
router.get('/samples', (_req, res) => {
  const dir = config.paths.samples;
  if (!fs.existsSync(dir)) return res.json([]);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const out = files.map((f) => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      return {
        filename: f, title: j.title || f, description: j.description || '',
        category_hint: j.category_hint || null, expected_priority: j.expected_priority || null,
        expected_spam: j.expected_spam || null, expected_language: j.expected_language || null,
      };
    } catch { return null; }
  }).filter(Boolean);
  res.json(out);
});

router.post('/samples/:filename/ingest', async (req, res) => {
  const file = path.join(config.paths.samples, path.basename(req.params.filename));
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'sample not found' });
  try {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    const inbound = emailService.parseWebhookPayload({
      ...payload,
      from: payload.from || `${payload.sender_name || 'Sample'} <${payload.sender_email}>`,
      body: payload.body || payload.email_body,
      receivedAt: payload.received_at || new Date().toISOString(),
    });
    const result = await ticketService.createFromEmail(inbound, { sendAck: true });
    res.status(201).json({
      ticket_id: result.ticket ? result.ticket.id : null,
      category: result.ticket?.category,
      priority: result.ticket?.priority,
      assigned_team: result.ticket?.assigned_team,
      confidence: result.ticket?.confidence_score,
      assigned_agent: result.assignedAgent,
      language: result.ticket?.language,
      is_spam: result.ticket?.is_spam,
      spam_score: result.spam?.spam_score,
      spam_auto_rejected: result.spam?.autoRejected || false,
      kb_suggestions: (result.kbSuggestions || []).map((a) => ({ id: a.id, title: a.title, match_score: a.match_score })),
      duplicate_of: result.duplicate ? result.duplicate.id : null,
      ai_used_mock: result.ai.usedMock,
      ack_sent: result.ack.sent,
      warnings: result.warnings,
      expected: {
        category: payload.category_hint,
        priority: payload.expected_priority,
        spam: payload.expected_spam,
        language: payload.expected_language,
      },
      matched:
        (payload.category_hint ? payload.category_hint === result.ticket?.category : true) &&
        (payload.expected_priority ? payload.expected_priority === result.ticket?.priority : true) &&
        (payload.expected_spam ? payload.expected_spam === !!result.ticket?.is_spam : true) &&
        (payload.expected_language ? payload.expected_language === result.ticket?.language : true),
    });
  } catch (err) {
    log.error('Sample ingest failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------
// Public demo ingestion (no token required; rate-limited)
// ---------------------------------------------------------------
const PUBLIC_INGEST_DISABLED = String(process.env.API_DISABLE_PUBLIC_INGEST || '').toLowerCase() === 'true';
const publicLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

router.post('/ingest', publicLimiter, express.json({ limit: '25mb' }), async (req, res) => {
  if (PUBLIC_INGEST_DISABLED) return res.status(403).json({ error: 'public ingest disabled' });
  try {
    const inbound = emailService.parseWebhookPayload(req.body);
    const v = emailService.validateInbound(inbound);
    if (!v.ok) return res.status(400).json({ error: 'invalid payload', details: v.errors });
    const result = await ticketService.createFromEmail(inbound, { sendAck: true });
    res.status(201).json({
      ticket_id: result.ticket?.id, status: result.ticket?.status,
      category: result.ticket?.category, priority: result.ticket?.priority,
      assigned_team: result.ticket?.assigned_team, confidence: result.ticket?.confidence_score,
      assigned_agent: result.assignedAgent,
      language: result.ticket?.language,
      is_spam: result.ticket?.is_spam, spam_score: result.spam?.spam_score,
      spam_auto_rejected: result.spam?.autoRejected || false,
      kb_suggestions: (result.kbSuggestions || []).map((a) => ({ id: a.id, title: a.title })),
      duplicate_of: result.duplicate ? result.duplicate.id : null,
      ai_used_mock: result.ai.usedMock, ack_sent: result.ack.sent, warnings: result.warnings,
    });
  } catch (err) {
    log.error('public ingest failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

router.post('/ingest/eml', publicLimiter, uploadMem.single('file'), async (req, res) => {
  if (PUBLIC_INGEST_DISABLED) return res.status(403).json({ error: 'public ingest disabled' });
  try {
    if (!req.file) return res.status(400).json({ error: 'no file uploaded' });
    const inbound = emailService.parseEmlString(req.file.buffer.toString('utf8'), req.file.originalname);
    const v = emailService.validateInbound(inbound);
    if (!v.ok) return res.status(400).json({ error: 'invalid eml', details: v.errors });
    const result = await ticketService.createFromEmail(inbound, { sendAck: true });
    res.status(201).json({
      ticket_id: result.ticket?.id, status: result.ticket?.status,
      category: result.ticket?.category, priority: result.ticket?.priority,
      assigned_team: result.ticket?.assigned_team, confidence: result.ticket?.confidence_score,
      assigned_agent: result.assignedAgent,
      language: result.ticket?.language, is_spam: result.ticket?.is_spam,
      spam_auto_rejected: result.spam?.autoRejected || false,
      duplicate_of: result.duplicate ? result.duplicate.id : null,
      ai_used_mock: result.ai.usedMock, ack_sent: result.ack.sent, warnings: result.warnings,
    });
  } catch (err) {
    log.error('public eml ingest failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------
// Inbox log
// ---------------------------------------------------------------
router.get('/inbox-log', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json(db.all(`SELECT * FROM inbox_log ORDER BY id DESC LIMIT @limit`, { limit }));
});

module.exports = router;
