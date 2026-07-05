'use strict';

/**
 * Audit Log Search Service — advanced querying of the append-only audit trail.
 *
 * Provides:
 *   - search() with filters (ticketId, action, actor, field, date range, value match)
 *   - export() to CSV
 *   - stats() — action counts, top actors, activity over time
 *   - retention() — purge old entries (admin-only)
 */

const db = require('../database/db');
const { nowIso } = require('../utils/helpers');

/**
 * Search the audit trail with filters.
 */
function search({
  ticketId, action, actor, field,
  valueContains,
  startDate, endDate,
  limit = 100, offset = 0,
  order = 'DESC',
} = {}) {
  const where = [];
  const params = { limit, offset };
  if (ticketId) { where.push('ticket_id = @ticketId'); params.ticketId = ticketId; }
  if (action) { where.push('action = @action'); params.action = action; }
  if (actor) { where.push('actor LIKE @actor'); params.actor = `%${actor}%`; }
  if (field) { where.push('field = @field'); params.field = field; }
  if (valueContains) {
    where.push('(old_value LIKE @vc OR new_value LIKE @vc OR metadata LIKE @vc)');
    params.vc = `%${valueContains}%`;
  }
  if (startDate) { where.push('created_at >= @startDate'); params.startDate = startDate; }
  if (endDate) { where.push('created_at <= @endDate'); params.endDate = endDate; }

  const sql = `SELECT * FROM audit_trail ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY id ${order === 'ASC' ? 'ASC' : 'DESC'} LIMIT @limit OFFSET @offset`;
  return db.all(sql, params);
}

/**
 * Get audit trail stats.
 */
function stats({ startDate, endDate } = {}) {
  const where = [];
  const params = {};
  if (startDate) { where.push('created_at >= @startDate'); params.startDate = startDate; }
  if (endDate) { where.push('created_at <= @endDate'); params.endDate = endDate; }
  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const total = db.get(`SELECT COUNT(*) AS n FROM audit_trail ${whereClause}`, params).n;
  const byAction = db.all(`SELECT action, COUNT(*) AS n FROM audit_trail ${whereClause} GROUP BY action ORDER BY n DESC`, params);
  const byActor = db.all(`SELECT actor, COUNT(*) AS n FROM audit_trail ${whereClause} GROUP BY actor ORDER BY n DESC LIMIT 20`, params);
  const fieldWhere = where.length ? where.concat(['field IS NOT NULL']).join(' AND ') : 'field IS NOT NULL';
  const byField = db.all(`SELECT field, COUNT(*) AS n FROM audit_trail WHERE ${fieldWhere} GROUP BY field ORDER BY n DESC LIMIT 20`, params);

  // Activity over time (per day for last 30 days)
  const since = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
  const timeseries = db.all(
    `SELECT DATE(created_at) AS day, COUNT(*) AS n FROM audit_trail WHERE created_at >= @since GROUP BY DATE(created_at) ORDER BY day ASC`,
    { since }
  );

  return { total, byAction, byActor, byField, timeseries };
}

/**
 * Export audit trail to CSV.
 */
function exportCsv({ ticketId, action, actor, field, startDate, endDate } = {}) {
  const rows = search({ ticketId, action, actor, field, startDate, endDate, limit: 50000, order: 'ASC' });
  const headers = ['id', 'ticket_id', 'action', 'field', 'old_value', 'new_value', 'actor', 'metadata', 'created_at'];
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(headers.map((h) => csvEscape(r[h])).join(','));
  }
  return lines.join('\n');
}

/**
 * Purge audit entries older than N days. Admin-only.
 */
function purgeOlderThan(days) {
  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();
  const r = db.run(`DELETE FROM audit_trail WHERE created_at < @cutoff`, { cutoff });
  return { purged: r.changes, olderThan: cutoff };
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

module.exports = { search, stats, exportCsv, purgeOlderThan };
