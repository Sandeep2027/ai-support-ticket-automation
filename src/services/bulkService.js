'use strict';

/**
 * Bulk operations service — mass-assign, mass-status-change, mass-priority-change,
 * mass-tag, CSV import/export. Designed for power-user agent workflows.
 */

const db = require('../database/db');
const { nowIso } = require('../utils/helpers');
const auditService = require('./auditService');
const logger = require('../utils/logger').child('bulk');
const log = logger;

const ALLOWED_BULK_FIELDS = ['status', 'priority', 'category', 'assigned_team', 'assigned_agent_id', 'sentiment'];

/**
 * Bulk-update one field across many tickets.
 * @param {string[]} ticketIds
 * @param {object} patch    e.g. { status: 'In Progress' } or { assigned_team: 'Technical Support' }
 * @param {string} actor
 */
function bulkUpdate(ticketIds, patch, actor = 'system:bulk') {
  if (!Array.isArray(ticketIds) || !ticketIds.length) return { updated: 0, errors: [] };
  const errors = [];
  let updated = 0;
  const now = nowIso();

  // Validate patch
  const setClauses = [];
  const fieldUpdates = [];
  for (const k of ALLOWED_BULK_FIELDS) {
    if (patch[k] === undefined) continue;
    setClauses.push(`${k} = @${k}`);
    fieldUpdates.push([k, patch[k]]);
  }
  if (!setClauses.length) return { updated: 0, errors: ['no updatable fields in patch'] };
  setClauses.push('last_updated = @now', 'updated_at = @now');

  db.transaction(() => {
    for (const id of ticketIds) {
      const ticket = db.get(`SELECT * FROM tickets WHERE id = @id`, { id });
      if (!ticket) { errors.push(`${id}: not found`); continue; }
      const params = { id, now };
      for (const [k, v] of fieldUpdates) params[k] = v;
      try {
        db.run(`UPDATE tickets SET ${setClauses.join(', ')} WHERE id = @id`, params);
        for (const [k, v] of fieldUpdates) {
          auditService.record({ ticketId: id, action: k === 'status' ? 'status_changed' : k === 'priority' ? 'priority_changed' : k === 'category' ? 'category_changed' : k === 'assigned_team' ? 'assigned' : 'edited', field: k, oldValue: ticket[k], newValue: v, actor });
        }
        updated++;
      } catch (err) {
        errors.push(`${id}: ${err.message}`);
      }
    }
  });

  log.info('Bulk update', { updated, errors: errors.length, actor });
  return { updated, errors };
}

/**
 * Bulk-assign tickets to a single agent (with workload check).
 */
function bulkAssign(ticketIds, agentId, actor = 'system:bulk') {
  return bulkUpdate(ticketIds, { assigned_agent_id: agentId }, actor);
}

/**
 * Add a tag to many tickets.
 */
function bulkAddTag(ticketIds, tagName, actor = 'system:bulk') {
  // Use the structured ticket_tags table
  const { asString } = require('../utils/validator');
  const name = asString(tagName, 50).toLowerCase();
  if (!name) return { updated: 0, errors: ['invalid tag name'] };

  let tagRow = db.get(`SELECT id FROM tags WHERE name = @name`, { name });
  if (!tagRow) {
    db.run(`INSERT INTO tags (name, color, created_at) VALUES (@name, '#6b7280', @now)`, { name, now: nowIso() });
    tagRow = db.get(`SELECT id FROM tags WHERE name = @name`, { name });
  }
  let added = 0;
  const errors = [];
  for (const id of ticketIds) {
    try {
      db.run(`INSERT OR IGNORE INTO ticket_tags (ticket_id, tag_id) VALUES (@tid, @tagId)`, { tid: id, tagId: tagRow.id });
      auditService.record({ ticketId: id, action: 'edited', field: 'tag', newValue: name, actor });
      added++;
    } catch (err) {
      errors.push(`${id}: ${err.message}`);
    }
  }
  return { updated: added, errors };
}

/**
 * Bulk-close tickets (status → Closed).
 */
function bulkClose(ticketIds, actor = 'system:bulk') {
  const now = nowIso();
  let closed = 0;
  const errors = [];
  db.transaction(() => {
    for (const id of ticketIds) {
      const ticket = db.get(`SELECT status FROM tickets WHERE id = @id`, { id });
      if (!ticket) { errors.push(`${id}: not found`); continue; }
      db.run(`UPDATE tickets SET status = 'Closed', resolved_at = @now, last_updated = @now, updated_at = @now WHERE id = @id`, { id, now });
      auditService.record({ ticketId: id, action: 'status_changed', field: 'status', oldValue: ticket.status, newValue: 'Closed', actor });
      closed++;
    }
  });
  return { updated: closed, errors };
}

/**
 * Export tickets to CSV.
 */
function exportCsv({ status, priority, category, team, q, limit = 5000 } = {}) {
  const where = [];
  const params = { limit };
  if (status) { where.push('status = @status'); params.status = status; }
  if (priority) { where.push('priority = @priority'); params.priority = priority; }
  if (category) { where.push('category = @category'); params.category = category; }
  if (team) { where.push('assigned_team = @team'); params.team = team; }
  if (q) { where.push('(email_subject LIKE @q OR sender_email LIKE @q OR id LIKE @q)'); params.q = `%${q}%`; }

  const rows = db.all(
    `SELECT id, customer_name, sender_email, email_subject, category, priority, sentiment,
            product_service, assigned_team, status, confidence_score, is_spam, escalated,
            received_at, resolved_at, sla_due_at
     FROM tickets ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY received_at DESC LIMIT @limit`,
    params
  );

  const headers = ['id', 'customer_name', 'sender_email', 'email_subject', 'category', 'priority', 'sentiment', 'product_service', 'assigned_team', 'status', 'confidence_score', 'is_spam', 'escalated', 'received_at', 'resolved_at', 'sla_due_at'];
  const lines = [headers.join(',')];
  for (const r of rows) {
    const cells = headers.map((h) => csvEscape(r[h]));
    lines.push(cells.join(','));
  }
  return lines.join('\n');
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * Import tickets from a JSON array (bulk ingestion).
 */
async function bulkImport(payloads, actor = 'system:import') {
  const emailService = require('./emailService');
  const ticketService = require('./ticketService');
  const results = [];
  for (const p of payloads) {
    try {
      const inbound = emailService.parseWebhookPayload(p);
      const result = await ticketService.createFromEmail(inbound, { sendAck: false });
      results.push({ ok: true, ticketId: result.ticket.id, category: result.ticket.category, priority: result.ticket.priority });
    } catch (err) {
      results.push({ ok: false, error: err.message, payload: p });
    }
  }
  log.info('Bulk import', { total: payloads.length, ok: results.filter((r) => r.ok).length });
  return results;
}

module.exports = {
  bulkUpdate,
  bulkAssign,
  bulkAddTag,
  bulkClose,
  exportCsv,
  bulkImport,
};
