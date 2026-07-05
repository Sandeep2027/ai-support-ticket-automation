'use strict';

/**
 * REST API v3 — advanced operations routes.
 *
 * Mounted under /api/v3 in app.js. Provides endpoints for:
 *   - Macros (canned responses)
 *   - SLA policies
 *   - Workflow rules
 *   - Custom fields
 *   - Scheduled reports
 *   - Outbound webhooks
 *   - Translations
 *   - Ticket similarity
 *   - Snoozes
 *   - Threading
 *   - System settings
 *   - Audit log search
 *   - Backup & restore
 *   - Deep health
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const logger = require('../utils/logger').child('api-v3');
const macroService = require('../services/macroService');
const slaPolicyService = require('../services/slaPolicyService');
const workflowService = require('../services/workflowService');
const customFieldService = require('../services/customFieldService');
const scheduledReportService = require('../services/scheduledReportService');
const webhookOutService = require('../services/webhookOutService');
const translationService = require('../services/translationService');
const ticketSimilarityService = require('../services/ticketSimilarityService');
const snoozeService = require('../services/snoozeService');
const threadingService = require('../services/threadingService');
const settingsService = require('../services/settingsService');
const auditSearchService = require('../services/auditSearchService');
const backupService = require('../services/backupService');
const healthService = require('../services/healthService');
const ticketService = require('../services/ticketService');
const metricsService = require('../services/metricsService');
const authService = require('../services/authService');

const router = express.Router();
const log = logger;

// Auth + metrics
router.use((req, _res, next) => { metricsService.inc('api_requests'); next(); });
router.use(authService.middleware);
const adminLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

// ===============================================================
// Macros
// ===============================================================

router.get('/macros', (req, res) => {
  const { category, team, q } = req.query;
  res.json(macroService.list({ category, team, q, limit: Number(req.query.limit) || 100 }));
});

router.get('/macros/variables', (_req, res) => {
  res.json({ variables: macroService.ALLOWED_VARIABLES });
});

router.post('/macros/validate', (req, res) => {
  res.json(macroService.validateTemplate(req.body?.template || ''));
});

router.get('/macros/:id', (req, res) => {
  const m = macroService.get(req.params.id);
  if (!m) return res.status(404).json({ error: 'macro not found' });
  res.json(m);
});

router.post('/macros', authService.requireWrite, (req, res) => {
  try {
    res.status(201).json(macroService.create({ ...req.body, authorId: req.agent?.id }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.patch('/macros/:id', authService.requireWrite, (req, res) => {
  const m = macroService.update(req.params.id, req.body || {});
  if (!m) return res.status(404).json({ error: 'macro not found' });
  res.json(m);
});

router.delete('/macros/:id', authService.requireWrite, (req, res) => {
  if (macroService.remove(req.params.id)) res.json({ ok: true });
  else res.status(404).json({ error: 'macro not found' });
});

router.post('/macros/:id/apply', async (req, res) => {
  try {
    const ticket = ticketService.get(req.body.ticketId);
    if (!ticket) return res.status(404).json({ error: 'ticket not found' });
    const customFields = customFieldService.getValuesMap(ticket.id);
    const result = macroService.apply(req.params.id, ticket, customFields, req.agent?.name || '');
    res.json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ===============================================================
// SLA Policies
// ===============================================================

router.get('/sla-policies', (req, res) => {
  res.json(slaPolicyService.list({ limit: Number(req.query.limit) || 100 }));
});

router.get('/sla-policies/:id', (req, res) => {
  const p = slaPolicyService.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'policy not found' });
  res.json(p);
});

router.post('/sla-policies', authService.requireWrite, (req, res) => {
  try { res.status(201).json(slaPolicyService.create(req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.patch('/sla-policies/:id', authService.requireWrite, (req, res) => {
  const p = slaPolicyService.update(req.params.id, req.body || {});
  if (!p) return res.status(404).json({ error: 'policy not found' });
  res.json(p);
});

router.delete('/sla-policies/:id', authService.requireWrite, (req, res) => {
  if (slaPolicyService.remove(req.params.id)) res.json({ ok: true });
  else res.status(404).json({ error: 'policy not found' });
});

router.get('/sla-policies/for-ticket/:ticketId', (req, res) => {
  const ticket = ticketService.get(req.params.ticketId);
  if (!ticket) return res.status(404).json({ error: 'ticket not found' });
  res.json({
    policy: slaPolicyService.getPolicyForTicket(ticket),
    remainingMinutes: slaPolicyService.remainingMinutes(ticket),
  });
});

// ===============================================================
// Workflow Rules
// ===============================================================

router.get('/workflows', (req, res) => {
  res.json(workflowService.list({ triggerEvent: req.query.triggerEvent, limit: Number(req.query.limit) || 100 }));
});

router.get('/workflows/events', (_req, res) => {
  res.json({ events: workflowService.TRIGGER_EVENTS, ops: workflowService.CONDITION_OPS, actions: workflowService.ACTION_TYPES });
});

router.get('/workflows/:id', (req, res) => {
  const w = workflowService.get(req.params.id);
  if (!w) return res.status(404).json({ error: 'rule not found' });
  res.json(w);
});

router.post('/workflows', authService.requireWrite, (req, res) => {
  try { res.status(201).json(workflowService.create(req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.patch('/workflows/:id', authService.requireWrite, (req, res) => {
  const w = workflowService.update(req.params.id, req.body || {});
  if (!w) return res.status(404).json({ error: 'rule not found' });
  res.json(w);
});

router.delete('/workflows/:id', authService.requireWrite, (req, res) => {
  if (workflowService.remove(req.params.id)) res.json({ ok: true });
  else res.status(404).json({ error: 'rule not found' });
});

router.get('/workflows/:id/executions', (req, res) => {
  res.json(workflowService.executionsForRule(req.params.id, { limit: Number(req.query.limit) || 50 }));
});

router.post('/workflows/:id/test', authService.requireWrite, (req, res) => {
  const ticket = ticketService.get(req.body.ticketId);
  if (!ticket) return res.status(404).json({ error: 'ticket not found' });
  const rule = workflowService.get(req.params.id);
  if (!rule) return res.status(404).json({ error: 'rule not found' });
  const matched = workflowService.evaluateAll(rule.conditions_parsed, ticket);
  res.json({
    ruleId: rule.id, ruleName: rule.name,
    matched,
    conditions: rule.conditions_parsed,
    ticket: { id: ticket.id, category: ticket.category, priority: ticket.priority, status: ticket.status },
  });
});

// ===============================================================
// Custom Fields
// ===============================================================

router.get('/custom-fields', (req, res) => {
  res.json(customFieldService.listDefinitions({ category: req.query.category, limit: Number(req.query.limit) || 100 }));
});

router.get('/custom-fields/types', (_req, res) => {
  res.json({ types: customFieldService.FIELD_TYPES });
});

router.get('/custom-fields/:id', (req, res) => {
  const f = customFieldService.getDefinition(req.params.id);
  if (!f) return res.status(404).json({ error: 'field not found' });
  res.json(f);
});

router.post('/custom-fields', authService.requireWrite, (req, res) => {
  try { res.status(201).json(customFieldService.createDefinition(req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.patch('/custom-fields/:id', authService.requireWrite, (req, res) => {
  const f = customFieldService.updateDefinition(req.params.id, req.body || {});
  if (!f) return res.status(404).json({ error: 'field not found' });
  res.json(f);
});

router.delete('/custom-fields/:id', authService.requireWrite, (req, res) => {
  if (customFieldService.removeDefinition(req.params.id)) res.json({ ok: true });
  else res.status(404).json({ error: 'field not found' });
});

router.get('/tickets/:ticketId/custom-fields', (req, res) => {
  res.json(customFieldService.getValuesForTicket(req.params.ticketId));
});

router.put('/tickets/:ticketId/custom-fields/:fieldName', authService.requireWrite, (req, res) => {
  try {
    res.json(customFieldService.setValue(req.params.ticketId, req.params.fieldName, req.body?.value));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ===============================================================
// Scheduled Reports
// ===============================================================

router.get('/scheduled-reports', (req, res) => {
  res.json(scheduledReportService.list({ limit: Number(req.query.limit) || 100 }));
});

router.get('/scheduled-reports/frequencies', (_req, res) => {
  res.json({ frequencies: scheduledReportService.FREQUENCIES });
});

router.get('/scheduled-reports/:id', (req, res) => {
  const r = scheduledReportService.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'report not found' });
  res.json(r);
});

router.post('/scheduled-reports', authService.requireWrite, (req, res) => {
  try { res.status(201).json(scheduledReportService.create(req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.patch('/scheduled-reports/:id', authService.requireWrite, (req, res) => {
  const r = scheduledReportService.update(req.params.id, req.body || {});
  if (!r) return res.status(404).json({ error: 'report not found' });
  res.json(r);
});

router.delete('/scheduled-reports/:id', authService.requireWrite, (req, res) => {
  if (scheduledReportService.remove(req.params.id)) res.json({ ok: true });
  else res.status(404).json({ error: 'report not found' });
});

router.post('/scheduled-reports/:id/run', authService.requireWrite, async (req, res) => {
  const r = scheduledReportService.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'report not found' });
  const content = scheduledReportService.generateContent(r);
  res.json({ ok: true, format: content.format, contentPreview: content.content.slice(0, 500) });
});

router.post('/scheduled-reports/sweep', authService.requireWrite, async (_req, res) => {
  res.json(await scheduledReportService.sweep());
});

// ===============================================================
// Outbound Webhooks
// ===============================================================

router.get('/webhooks-out', (req, res) => {
  res.json(webhookOutService.listSubscriptions({ isActive: req.query.isActive === undefined ? undefined : req.query.isActive === 'true' }));
});

router.get('/webhooks-out/events', (_req, res) => {
  res.json({ events: webhookOutService.EVENT_TYPES });
});

router.post('/webhooks-out', authService.requireWrite, (req, res) => {
  try { res.status(201).json(webhookOutService.createSubscription(req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.patch('/webhooks-out/:id', authService.requireWrite, (req, res) => {
  const s = webhookOutService.updateSubscription(req.params.id, req.body || {});
  if (!s) return res.status(404).json({ error: 'subscription not found' });
  res.json(s);
});

router.delete('/webhooks-out/:id', authService.requireWrite, (req, res) => {
  if (webhookOutService.removeSubscription(req.params.id)) res.json({ ok: true });
  else res.status(404).json({ error: 'subscription not found' });
});

router.get('/webhooks-out/deliveries', (req, res) => {
  res.json(webhookOutService.listDeliveries({
    status: req.query.status, subscriptionId: req.query.subscriptionId,
    limit: Number(req.query.limit) || 100, offset: Number(req.query.offset) || 0,
  }));
});

router.post('/webhooks-out/deliveries/:id/retry', authService.requireWrite, (req, res) => {
  try { res.json(webhookOutService.retryDelivery(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ===============================================================
// Translations
// ===============================================================

router.get('/translations/languages', (_req, res) => {
  res.json({ languages: translationService.SUPPORTED_LANGUAGES });
});

router.get('/translations/:ticketId', (req, res) => {
  res.json(translationService.listForTicket(req.params.ticketId));
});

router.post('/translations/:ticketId', async (req, res) => {
  try {
    const targetLanguage = req.body?.targetLanguage || 'en';
    res.json(await translationService.translateTicket(req.params.ticketId, targetLanguage));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/translations/:ticketId', authService.requireWrite, (req, res) => {
  translationService.invalidate(req.params.ticketId, req.query.targetLanguage);
  res.json({ ok: true });
});

// ===============================================================
// Ticket Similarity
// ===============================================================

router.get('/similarity/:ticketId', (req, res) => {
  try {
    res.json(ticketSimilarityService.findSimilar(req.params.ticketId, {
      limit: Number(req.query.limit) || 5,
      includeResolved: req.query.includeResolved !== 'false',
      minScore: Number(req.query.minScore) || 1,
    }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/similarity/:ticketId/duplicates', (req, res) => {
  try {
    res.json(ticketSimilarityService.findPotentialDuplicates(req.params.ticketId, {
      limit: Number(req.query.limit) || 3,
    }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ===============================================================
// Snoozes
// ===============================================================

router.get('/snoozes/:ticketId', (req, res) => {
  res.json({
    active: snoozeService.getActive(req.params.ticketId),
    history: snoozeService.historyForTicket(req.params.ticketId),
  });
});

router.post('/snoozes/:ticketId', authService.requireWrite, (req, res) => {
  try {
    res.status(201).json(snoozeService.snooze(
      req.params.ticketId,
      req.body?.snoozedUntil,
      req.body?.reason || '',
      `agent:${req.agent?.id || 'system'}`
    ));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/snoozes/:ticketId', authService.requireWrite, (req, res) => {
  try {
    res.json(snoozeService.wake(req.params.ticketId, `agent:${req.agent?.id || 'system'}`));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/snoozes/sweep', (_req, res) => {
  res.json(snoozeService.sweep());
});

// ===============================================================
// Threading
// ===============================================================

router.get('/threads', (req, res) => {
  res.json(threadingService.listThreads({
    limit: Number(req.query.limit) || 50,
    offset: Number(req.query.offset) || 0,
  }));
});

router.get('/threads/:id', (req, res) => {
  const t = threadingService.getThread(req.params.id);
  if (!t) return res.status(404).json({ error: 'thread not found' });
  res.json(t);
});

router.get('/tickets/:ticketId/thread', (req, res) => {
  const t = threadingService.getThreadForTicket(req.params.ticketId);
  if (!t) return res.status(404).json({ error: 'ticket not in a thread' });
  res.json(t);
});

router.post('/tickets/:ticketId/thread', authService.requireWrite, (req, res) => {
  try {
    res.json(threadingService.linkTicketToThread(req.params.ticketId, req.body?.threadId, `agent:${req.agent?.id || 'system'}`));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/tickets/:ticketId/thread', authService.requireWrite, (req, res) => {
  res.json(threadingService.unlinkTicket(req.params.ticketId, `agent:${req.agent?.id || 'system'}`));
});

router.post('/threads/merge', authService.requireWrite, (req, res) => {
  try {
    res.json(threadingService.mergeThreads(req.body?.sourceId, req.body?.targetId, `agent:${req.agent?.id || 'system'}`));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ===============================================================
// System Settings
// ===============================================================

router.get('/settings', (req, res) => {
  res.json(settingsService.list({ category: req.query.category, includeSensitive: req.agent?.role === 'admin' }));
});

router.get('/settings/categories', (_req, res) => {
  res.json({ categories: settingsService.listCategories() });
});

router.get('/settings/:key', (req, res) => {
  const v = settingsService.getWithMeta(req.params.key);
  if (!v) return res.status(404).json({ error: 'setting not found' });
  if (v.is_sensitive && req.agent?.role !== 'admin') v.value = '***REDACTED***';
  res.json(v);
});

router.put('/settings/:key', authService.requireWrite, (req, res) => {
  res.json(settingsService.set(req.params.key, req.body?.value, {
    description: req.body?.description,
    category: req.body?.category,
    isSensitive: req.body?.isSensitive,
    updatedBy: req.agent?.id,
  }));
});

router.delete('/settings/:key', authService.requireRole('admin'), (req, res) => {
  if (settingsService.remove(req.params.key)) res.json({ ok: true });
  else res.status(404).json({ error: 'setting not found' });
});

// ===============================================================
// Audit Log Search
// ===============================================================

router.get('/audit/search', (req, res) => {
  res.json(auditSearchService.search({
    ticketId: req.query.ticketId,
    action: req.query.action,
    actor: req.query.actor,
    field: req.query.field,
    valueContains: req.query.valueContains,
    startDate: req.query.startDate,
    endDate: req.query.endDate,
    limit: Number(req.query.limit) || 100,
    offset: Number(req.query.offset) || 0,
  }));
});

router.get('/audit/stats', (req, res) => {
  res.json(auditSearchService.stats({ startDate: req.query.startDate, endDate: req.query.endDate }));
});

router.get('/audit/export.csv', (req, res) => {
  const csv = auditSearchService.exportCsv({
    ticketId: req.query.ticketId, action: req.query.action,
    actor: req.query.actor, field: req.query.field,
    startDate: req.query.startDate, endDate: req.query.endDate,
  });
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', `attachment; filename="audit-${Date.now()}.csv"`);
  res.send(csv);
});

router.post('/audit/purge', authService.requireRole('admin'), (req, res) => {
  const days = Number(req.body?.days) || 365;
  res.json(auditSearchService.purgeOlderThan(days));
});

// ===============================================================
// Backup & Restore (admin only)
// ===============================================================

router.post('/backup', authService.requireRole('admin'), adminLimiter, (req, res) => {
  res.json(backupService.backup());
});

router.get('/backup', (_req, res) => {
  res.json(backupService.listBackups());
});

router.post('/backup/restore/:filename', authService.requireRole('admin'), (req, res) => {
  try { res.json(backupService.restore(req.params.filename)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/backup/:filename', authService.requireRole('admin'), (req, res) => {
  if (backupService.deleteBackup(req.params.filename)) res.json({ ok: true });
  else res.status(404).json({ error: 'backup not found' });
});

router.post('/backup/export-json', authService.requireRole('admin'), (req, res) => {
  res.json(backupService.exportJsonFile());
});

router.post('/backup/import-json', authService.requireRole('admin'), (req, res) => {
  try { res.json(backupService.importJson(req.body)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/backup/vacuum', authService.requireRole('admin'), (req, res) => {
  res.json(backupService.vacuum());
});

router.get('/backup/stats', (_req, res) => {
  res.json(backupService.stats());
});

// ===============================================================
// Deep Health
// ===============================================================

router.get('/health/deep', (_req, res) => {
  const h = healthService.deep();
  res.status(h.status === 'ok' ? 200 : 503).json(h);
});

router.get('/health/ready', (_req, res) => {
  const r = healthService.ready();
  res.status(r.status === 'ready' ? 200 : 503).json(r);
});

module.exports = router;
