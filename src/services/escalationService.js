'use strict';

/**
 * Escalation service — monitors SLA breaches and escalates tickets
 * through configurable levels. Designed to be called by a periodic
 * sweeper (background job) and also exposed via API for manual triggers.
 */

const db = require('../database/db');
const config = require('../config');
const { nowIso } = require('../utils/helpers');
const logger = require('../utils/logger').child('escalation');
const notificationService = require('./notificationService');
const auditService = require('./auditService');
const agentService = require('./agentService');
const log = logger;

const TERMINAL_STATUSES = ['Resolved', 'Closed', 'Rejected', 'Spam'];

/**
 * Find tickets that have breached their SLA and are not yet escalated
 * to the appropriate level. Returns the list of tickets + the level to escalate to.
 */
function findBreaches() {
  const now = nowIso();
  const termPh = TERMINAL_STATUSES.map((_, i) => `@t${i}`).join(',');
  const termParams = {};
  TERMINAL_STATUSES.forEach((s, i) => { termParams[`t${i}`] = s; });
  const rows = db.all(
    `SELECT id, email_subject, priority, sla_due_at, assigned_team, assigned_agent_id, escalation_level
     FROM tickets
     WHERE status NOT IN (${termPh})
       AND sla_due_at < @now
     ORDER BY sla_due_at ASC`,
    { ...termParams, now }
  );

  const breaches = [];
  for (const r of rows) {
    const overdueMs = Date.now() - new Date(r.sla_due_at).getTime();
    const overdueMin = Math.floor(overdueMs / 60000);
    const targetLevel = computeTargetLevel(overdueMin);
    if (targetLevel > r.escalation_level) {
      breaches.push({ ...r, overdueMin, targetLevel });
    }
  }
  return breaches;
}

function computeTargetLevel(overdueMin) {
  let level = 0;
  for (let i = 0; i < config.escalation.levels.length; i++) {
    if (overdueMin >= config.escalation.levels[i].atMinutes) level = i + 1;
  }
  return level;
}

/**
 * Run one sweep — find breaches and escalate.
 * @returns {Array<object>} escalations performed
 */
function sweep() {
  if (!config.escalation.enabled) return [];
  const breaches = findBreaches();
  const performed = [];
  for (const b of breaches) {
    const result = escalate(b.id, b.targetLevel, `sla_breach (${b.overdueMin}min overdue)`);
    if (result) performed.push(result);
  }
  if (performed.length) {
    log.info('Escalation sweep complete', { count: performed.length });
  }
  return performed;
}

/**
 * Escalate a ticket to a specific level.
 * @param {string} ticketId
 * @param {number} level    1, 2, or 3
 * @param {string} reason
 * @param {string} [actor]  default 'system:escalator'
 */
function escalate(ticketId, level, reason, actor = 'system:escalator') {
  if (level < 1 || level > config.escalation.levels.length) return null;
  const ticket = db.get(`SELECT * FROM tickets WHERE id = @id`, { id: ticketId });
  if (!ticket) return null;
  if (TERMINAL_STATUSES.includes(ticket.status)) return null;

  const levelConfig = config.escalation.levels[level - 1];
  const now = nowIso();

  // Insert escalation record
  db.run(
    `INSERT INTO escalations (ticket_id, level, reason, from_agent_id, to_team, created_at)
     VALUES (@tid, @level, @reason, @fromAgt, @toTeam, @now)`,
    { tid: ticketId, level, reason, fromAgt: ticket.assigned_agent_id, toTeam: ticket.assigned_team, now }
  );

  // Update ticket
  db.run(
    `UPDATE tickets SET escalated = 1, escalated_at = @now, escalation_level = @level, sla_breached = 1, last_updated = @now, updated_at = @now
     WHERE id = @id`,
    { now, level, id: ticketId }
  );

  // Audit
  auditService.record({
    ticketId, action: 'escalated', actor,
    newValue: `level ${level} (${levelConfig.action})`,
    metadata: { reason, level, action: levelConfig.action, overdue: levelConfig.description },
  });

  // Notify
  const event = level === 1 ? 'sla_breach' : 'escalation';
  notificationService.notify(event, {
    ticketId,
    ticketSubject: ticket.email_subject,
    priority: ticket.priority,
    team: ticket.assigned_team,
    level,
    reason,
    action: levelConfig.action,
    description: levelConfig.description,
  });

  log.warn('Ticket escalated', { ticketId, level, reason });
  return { ticketId, level, reason, action: levelConfig.action };
}

/**
 * Manually escalate a ticket by one level.
 */
function escalateManual(ticketId, actor = 'agent:manual') {
  const ticket = db.get(`SELECT escalation_level FROM tickets WHERE id = @id`, { id: ticketId });
  if (!ticket) return null;
  return escalate(ticketId, ticket.escalation_level + 1, 'manual escalation', actor);
}

/**
 * Reset escalation state for a ticket (e.g. when agent picks it up).
 */
function clearEscalation(ticketId, actor = 'system') {
  db.run(
    `UPDATE tickets SET escalated = 0, escalation_level = 0, last_updated = @now, updated_at = @now WHERE id = @id`,
    { now: nowIso(), id: ticketId }
  );
  db.run(`UPDATE escalations SET resolved_at = @now WHERE ticket_id = @id AND resolved_at IS NULL`, { now: nowIso(), id: ticketId });
  auditService.record({ ticketId, action: 'escalation_cleared', actor });
}

/**
 * Get all escalation records for a ticket.
 */
function historyForTicket(ticketId) {
  return db.all(`SELECT * FROM escalations WHERE ticket_id = @id ORDER BY level ASC, created_at ASC`, { id: ticketId });
}

/**
 * List all currently-escalated tickets.
 */
function listEscalated({ limit = 50 } = {}) {
  const termPh = TERMINAL_STATUSES.map((_, i) => `@t${i}`).join(',');
  const termParams = {};
  TERMINAL_STATUSES.forEach((s, i) => { termParams[`t${i}`] = s; });
  return db.all(
    `SELECT t.id, t.email_subject, t.priority, t.assigned_team, t.escalation_level, t.escalated_at, t.sla_due_at
     FROM tickets t
     WHERE t.escalated = 1 AND t.status NOT IN (${termPh})
     ORDER BY t.escalation_level DESC, t.escalated_at ASC
     LIMIT @limit`,
    { ...termParams, limit }
  );
}

/**
 * Start the background sweeper. Returns the interval handle.
 */
function startSweeper() {
  if (!config.escalation.enabled) {
    log.info('Escalation engine disabled — skipping sweeper');
    return null;
  }
  const intervalMs = config.escalation.sweepIntervalMin * 60 * 1000;
  const handle = setInterval(() => {
    try { sweep(); } catch (err) { log.error('Escalation sweep failed', { error: err.message }); }
  }, intervalMs);
  log.info('Escalation sweeper started', { intervalMin: config.escalation.sweepIntervalMin });
  return handle;
}

module.exports = {
  findBreaches,
  sweep,
  escalate,
  escalateManual,
  clearEscalation,
  historyForTicket,
  listEscalated,
  startSweeper,
  computeTargetLevel,
};
