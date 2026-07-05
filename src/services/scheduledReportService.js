'use strict';

/**
 * Scheduled Reports Service — email daily/weekly/monthly summaries.
 *
 * Reports are stored in scheduled_reports and dispatched by a background
 * sweeper (started in app.js). Each report has:
 *   - frequency: daily | weekly | monthly
 *   - recipient_emails: JSON array
 *   - filters_json: ticket filter criteria
 *   - format: html | csv | json
 *
 * The sweeper checks every minute for reports whose next_run_at has passed,
 * generates the report, emails it (or logs when SMTP disabled), and
 * schedules the next run.
 */

const db = require('../database/db');
const config = require('../config');
const { generateId, nowIso } = require('../utils/helpers');
const { asString, asArray } = require('../utils/validator');
const logger = require('../utils/logger').child('scheduled-reports');
const reportService = require('./reportService');
const ticketService = require('./ticketService');
const notificationService = require('./notificationService');
const log = logger;

const FREQUENCIES = ['daily', 'weekly', 'monthly'];

// ---------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------

function list({ isActive = true, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = { limit, offset };
  if (isActive !== undefined) { where.push('is_active = @ia'); params.ia = isActive ? 1 : 0; }
  const sql = `SELECT * FROM scheduled_reports ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY next_run_at ASC LIMIT @limit OFFSET @offset`;
  return db.all(sql, params).map(rowToReport);
}

function get(id) {
  const row = db.get(`SELECT * FROM scheduled_reports WHERE id = @id`, { id });
  return row ? rowToReport(row) : null;
}

function create({ name, description, frequency, dayOfWeek, dayOfMonth, hour, recipientEmails, filters, format = 'html' }) {
  if (!name) throw new Error('name is required');
  if (!FREQUENCIES.includes(frequency)) throw new Error(`frequency must be one of: ${FREQUENCIES.join(', ')}`);
  if (!Array.isArray(recipientEmails) || !recipientEmails.length) throw new Error('recipientEmails array required');

  const id = generateId('sr');
  const now = nowIso();
  const nextRun = computeNextRun(frequency, dayOfWeek, dayOfMonth, hour, new Date());
  const row = {
    id, name: asString(name, 100), description: asString(description, 500),
    frequency,
    day_of_week: dayOfWeek != null ? Number(dayOfWeek) : null,
    day_of_month: dayOfMonth != null ? Number(dayOfMonth) : null,
    hour: Number(hour) || 9,
    recipient_emails: JSON.stringify(recipientEmails),
    filters_json: filters ? JSON.stringify(filters) : null,
    format,
    last_run_at: null,
    next_run_at: nextRun,
    is_active: 1,
    created_at: now, updated_at: now,
  };
  db.run(
    `INSERT INTO scheduled_reports (id, name, description, frequency, day_of_week, day_of_month, hour, recipient_emails, filters_json, format, last_run_at, next_run_at, is_active, created_at, updated_at)
     VALUES (@id, @name, @description, @frequency, @day_of_week, @day_of_month, @hour, @recipient_emails, @filters_json, @format, @last_run_at, @next_run_at, @is_active, @created_at, @updated_at)`,
    row
  );
  log.info('Scheduled report created', { id, name, frequency, nextRun });
  return get(id);
}

function update(id, patch) {
  const existing = get(id);
  if (!existing) return null;
  const allowed = ['name', 'description', 'frequency', 'day_of_week', 'day_of_month', 'hour', 'recipient_emails', 'filters_json', 'format', 'is_active'];
  const setClauses = [];
  const params = { id, updatedAt: nowIso() };
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    let v = patch[k];
    if (k === 'recipient_emails') v = JSON.stringify(asArray(v, 50));
    else if (k === 'filters_json') v = v ? JSON.stringify(v) : null;
    else if (k === 'is_active') v = v ? 1 : 0;
    else if (['hour', 'day_of_week', 'day_of_month'].includes(k)) v = v != null ? Number(v) : null;
    else v = asString(v, 500);
    setClauses.push(`${k} = @${k}`);
    params[k] = v;
  }
  // Recompute next_run_at if frequency/hour/day changed
  if (patch.frequency || patch.hour != null || patch.day_of_week != null || patch.day_of_month != null) {
    const freq = patch.frequency || existing.frequency;
    const hour = patch.hour != null ? Number(patch.hour) : existing.hour;
    const dow = patch.day_of_week != null ? Number(patch.day_of_week) : existing.day_of_week;
    const dom = patch.day_of_month != null ? Number(patch.day_of_month) : existing.day_of_month;
    params.next_run_at = computeNextRun(freq, dow, dom, hour, new Date());
    setClauses.push('next_run_at = @next_run_at');
  }
  if (setClauses.length === 0) return existing;
  setClauses.push('updated_at = @updatedAt');
  db.run(`UPDATE scheduled_reports SET ${setClauses.join(', ')} WHERE id = @id`, params);
  return get(id);
}

function remove(id) {
  const r = db.run(`DELETE FROM scheduled_reports WHERE id = @id`, { id });
  return r.changes > 0;
}

// ---------------------------------------------------------------
// Next-run computation
// ---------------------------------------------------------------

function computeNextRun(frequency, dayOfWeek, dayOfMonth, hour, from) {
  const next = new Date(from);
  next.setUTCSeconds(0, 0);

  if (frequency === 'daily') {
    next.setUTCHours(hour, 0, 0, 0);
    if (next <= from) next.setUTCDate(next.getUTCDate() + 1);
  } else if (frequency === 'weekly') {
    const targetDay = dayOfWeek != null ? Number(dayOfWeek) : 1; // Monday default
    next.setUTCHours(hour, 0, 0, 0);
    let diff = (targetDay - next.getUTCDay() + 7) % 7;
    if (diff === 0 && next <= from) diff = 7;
    next.setUTCDate(next.getUTCDate() + diff);
  } else if (frequency === 'monthly') {
    const targetDate = dayOfMonth != null ? Number(dayOfMonth) : 1;
    next.setUTCHours(hour, 0, 0, 0);
    next.setUTCDate(targetDate);
    if (next <= from) next.setUTCMonth(next.getUTCMonth() + 1);
  }
  return next.toISOString();
}

// ---------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------

/**
 * Generate the report content for a scheduled report.
 */
function generateContent(report) {
  const filters = report.filters_parsed || {};
  const since = computeSince(report.frequency);

  // Get tickets matching filters and time window
  const tickets = ticketService.list({ ...filters, limit: 5000 });
  const recentTickets = tickets.filter((t) => new Date(t.received_at) >= since);

  // Build summary stats
  const stats = ticketService.stats();
  const reports = reportService.full();

  if (report.format === 'json') {
    return {
      format: 'json',
      content: JSON.stringify({
        reportName: report.name,
        period: { from: since.toISOString(), to: new Date().toISOString() },
        summary: {
          total_tickets: stats.total,
          recent_24h: stats.recent_24h,
          by_status: stats.byStatus,
          by_priority: stats.byPriority,
          by_category: stats.byCategory,
          sla_breached: stats.slaBreached.length,
          avg_confidence: stats.avgConfidence,
        },
        tickets: recentTickets.map((t) => ({
          id: t.id, subject: t.email_subject, category: t.category,
          priority: t.priority, status: t.status, received_at: t.received_at,
        })),
      }, null, 2),
    };
  }

  if (report.format === 'csv') {
    const headers = ['id', 'subject', 'category', 'priority', 'status', 'received_at', 'assigned_team'];
    const lines = [headers.join(',')];
    for (const t of recentTickets) {
      lines.push(headers.map((h) => csvEscape(t[h])).join(','));
    }
    return { format: 'csv', content: lines.join('\n'), filename: `report-${Date.now()}.csv` };
  }

  // Default: HTML
  const html = buildHtmlReport(report, recentTickets, stats, since);
  return { format: 'html', content: html };
}

function buildHtmlReport(report, tickets, stats, since) {
  const rows = tickets.slice(0, 100).map((t) => `
    <tr>
      <td style="padding:6px;border-bottom:1px solid #e5e7eb">${t.id}</td>
      <td style="padding:6px;border-bottom:1px solid #e5e7eb">${escapeHtml(t.email_subject || '')}</td>
      <td style="padding:6px;border-bottom:1px solid #e5e7eb">${t.category}</td>
      <td style="padding:6px;border-bottom:1px solid #e5e7eb">${t.priority}</td>
      <td style="padding:6px;border-bottom:1px solid #e5e7eb">${t.status}</td>
      <td style="padding:6px;border-bottom:1px solid #e5e7eb">${t.assigned_team || '—'}</td>
    </tr>`).join('');

  return `<div style="font-family:Arial,sans-serif;max-width:800px;margin:auto;color:#1f2937">
    <h2 style="color:#4f46e5">${escapeHtml(report.name)}</h2>
    <p style="color:#6b7280">${escapeHtml(report.description || '')}</p>
    <p>Period: ${since.toLocaleString()} to ${new Date().toLocaleString()}</p>

    <table style="width:100%;border-collapse:collapse;margin:16px 0;background:#f9fafb">
      <tr><td style="padding:8px">Total tickets</td><td style="padding:8px;font-weight:600">${stats.total}</td>
          <td style="padding:8px">SLA breached</td><td style="padding:8px;font-weight:600;color:#dc2626">${stats.slaBreached.length}</td></tr>
      <tr><td style="padding:8px">Escalated (open)</td><td style="padding:8px;font-weight:600">${stats.escalated_open}</td>
          <td style="padding:8px">Spam detected</td><td style="padding:8px;font-weight:600">${stats.spam_detected}</td></tr>
      <tr><td style="padding:8px">Avg AI confidence</td><td style="padding:8px;font-weight:600">${stats.avgConfidence}%</td>
          <td style="padding:8px">Recent (24h)</td><td style="padding:8px;font-weight:600">${stats.recent_24h}</td></tr>
    </table>

    <h3>Recent Tickets (max 100)</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#f3f4f6">
        <th style="padding:6px;text-align:left">ID</th>
        <th style="padding:6px;text-align:left">Subject</th>
        <th style="padding:6px;text-align:left">Category</th>
        <th style="padding:6px;text-align:left">Priority</th>
        <th style="padding:6px;text-align:left">Status</th>
        <th style="padding:6px;text-align:left">Team</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <p style="color:#6b7280;font-size:12px;margin-top:24px">Generated by AI Support Desk — scheduled report "${escapeHtml(report.name)}"</p>
  </div>`;
}

function computeSince(frequency) {
  const now = new Date();
  if (frequency === 'daily') return new Date(now.getTime() - 24 * 3600 * 1000);
  if (frequency === 'weekly') return new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  if (frequency === 'monthly') return new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  return new Date(now.getTime() - 24 * 3600 * 1000);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// ---------------------------------------------------------------
// Sweeper — find due reports, generate, send, reschedule
// ---------------------------------------------------------------

async function sweep() {
  const now = nowIso();
  const due = db.all(
    `SELECT * FROM scheduled_reports WHERE is_active = 1 AND next_run_at <= @now`,
    { now }
  );
  if (!due.length) return { swept: 0 };

  let swept = 0;
  for (const row of due) {
    const report = rowToReport(row);
    try {
      log.info('Generating scheduled report', { id: report.id, name: report.name });
      const result = generateContent(report);
      await deliverReport(report, result);

      // Reschedule
      const nextRun = computeNextRun(report.frequency, report.day_of_week, report.day_of_month, report.hour, new Date());
      db.run(
        `UPDATE scheduled_reports SET last_run_at = @now, next_run_at = @nextRun, updated_at = @now WHERE id = @id`,
        { now, nextRun, id: report.id }
      );
      swept++;
    } catch (err) {
      log.error('Scheduled report failed', { id: report.id, error: err.message });
      // Reschedule for next cycle to avoid retry storm
      const nextRun = new Date(Date.now() + 3600 * 1000).toISOString();
      db.run(`UPDATE scheduled_reports SET next_run_at = @nextRun WHERE id = @id`, { nextRun, id: report.id });
    }
  }
  return { swept };
}

async function deliverReport(report, result) {
  for (const email of report.recipient_emails) {
    if (result.format === 'csv') {
      // Send as attachment — for simplicity, log when SMTP disabled
      if (!config.smtp.enabled) {
        log.info(`[scheduled-report → ${email}] CSV (${result.content.length} bytes)`);
        continue;
      }
      // Real SMTP attachment would go here
      log.info(`[scheduled-report → ${email}] CSV (${result.content.length} bytes)`);
    } else {
      await notificationService.notify('scheduled_report', {
        ticketId: null,
        recipientEmail: email,
        reportName: report.name,
        format: result.format,
        contentPreview: result.content.slice(0, 200),
      });
      if (!config.smtp.enabled) {
        log.info(`[scheduled-report → ${email}] HTML (${result.content.length} bytes)`);
      }
    }
  }
}

function startSweeper() {
  const intervalMs = 60 * 1000; // check every minute
  const handle = setInterval(async () => {
    try { await sweep(); } catch (err) { log.error('Sweeper failed', { error: err.message }); }
  }, intervalMs);
  log.info('Scheduled reports sweeper started (60s interval)');
  return handle;
}

function rowToReport(row) {
  if (!row) return null;
  let recipients = [], filters = null;
  try { recipients = JSON.parse(row.recipient_emails || '[]'); } catch { /* ignore */ }
  try { filters = row.filters_json ? JSON.parse(row.filters_json) : null; } catch { /* ignore */ }
  return {
    ...row,
    recipient_emails: recipients,
    filters_parsed: filters,
    is_active: !!row.is_active,
  };
}

module.exports = {
  FREQUENCIES,
  list, get, create, update, remove,
  sweep, startSweeper, generateContent, computeNextRun,
};
