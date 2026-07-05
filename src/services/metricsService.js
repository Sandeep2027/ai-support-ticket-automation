'use strict';

/**
 * Metrics service — Prometheus-format metrics endpoint + in-memory counters.
 *
 * Exposes:
 *   GET /api/metrics  → text/plain Prometheus exposition format
 *
 * Counters are kept in-memory; gauges are computed on-demand from the DB.
 */

const db = require('../database/db');
const { nowIso } = require('../utils/helpers');

const counters = {
  tickets_created: 0,
  tickets_resolved: 0,
  tickets_escalated: 0,
  spam_detected: 0,
  sla_breaches: 0,
  ai_calls: 0,
  ai_calls_failed: 0,
  api_requests: 0,
  api_errors: 0,
};

function inc(name, by = 1) {
  if (counters[name] !== undefined) counters[name] += by;
}

function reset() {
  for (const k of Object.keys(counters)) counters[k] = 0;
}

/**
 * Render metrics in Prometheus exposition format.
 */
function render() {
  const lines = [];
  const TERM = ['Resolved', 'Closed', 'Rejected', 'Spam'];

  // ---- Process metrics (constant) ----
  lines.push(`# HELP supportdesk_process_uptime_seconds Process uptime in seconds`);
  lines.push(`# TYPE supportdesk_process_uptime_seconds gauge`);
  lines.push(`supportdesk_process_uptime_seconds ${process.uptime().toFixed(2)}`);

  lines.push(`# HELP supportdesk_process_resident_memory_bytes Resident memory in bytes`);
  lines.push(`# TYPE supportdesk_process_resident_memory_bytes gauge`);
  lines.push(`supportdesk_process_resident_memory_bytes ${process.memoryUsage().rss}`);

  // ---- Counters ----
  lines.push(`# HELP supportdesk_tickets_created_total Total tickets created`);
  lines.push(`# TYPE supportdesk_tickets_created_total counter`);
  lines.push(`supportdesk_tickets_created_total ${counters.tickets_created}`);

  lines.push(`# HELP supportdesk_tickets_resolved_total Total tickets resolved`);
  lines.push(`# TYPE supportdesk_tickets_resolved_total counter`);
  lines.push(`supportdesk_tickets_resolved_total ${counters.tickets_resolved}`);

  lines.push(`# HELP supportdesk_tickets_escalated_total Total escalations`);
  lines.push(`# TYPE supportdesk_tickets_escalated_total counter`);
  lines.push(`supportdesk_tickets_escalated_total ${counters.tickets_escalated}`);

  lines.push(`# HELP supportdesk_spam_detected_total Total spam detected`);
  lines.push(`# TYPE supportdesk_spam_detected_total counter`);
  lines.push(`supportdesk_spam_detected_total ${counters.spam_detected}`);

  lines.push(`# HELP supportdesk_sla_breaches_total Total SLA breaches`);
  lines.push(`# TYPE supportdesk_sla_breaches_total counter`);
  lines.push(`supportdesk_sla_breaches_total ${counters.sla_breaches}`);

  lines.push(`# HELP supportdesk_ai_calls_total Total AI calls`);
  lines.push(`# TYPE supportdesk_ai_calls_total counter`);
  lines.push(`supportdesk_ai_calls_total ${counters.ai_calls}`);

  lines.push(`# HELP supportdesk_ai_calls_failed_total Total AI call failures`);
  lines.push(`# TYPE supportdesk_ai_calls_failed_total counter`);
  lines.push(`supportdesk_ai_calls_failed_total ${counters.ai_calls_failed}`);

  // ---- Gauges (computed from DB) ----
  const termPh = TERM.map((_, i) => `@t${i}`).join(',');
  const termParams = {};
  TERM.forEach((s, i) => { termParams[`t${i}`] = s; });

  const statusCounts = db.all(`SELECT status, COUNT(*) AS n FROM tickets GROUP BY status`);
  for (const { status, n } of statusCounts) {
    lines.push(`# HELP supportdesk_tickets_by_status Tickets by status`);
    lines.push(`# TYPE supportdesk_tickets_by_status gauge`);
    lines.push(`supportdesk_tickets_by_status{status="${status}"} ${n}`);
  }

  const priorityOpen = db.all(
    `SELECT priority, COUNT(*) AS n FROM tickets WHERE status NOT IN (${termPh}) GROUP BY priority`,
    termParams
  );
  for (const { priority, n } of priorityOpen) {
    lines.push(`# HELP supportdesk_open_tickets_by_priority Open tickets by priority`);
    lines.push(`# TYPE supportdesk_open_tickets_by_priority gauge`);
    lines.push(`supportdesk_open_tickets_by_priority{priority="${priority}"} ${n}`);
  }

  const teamOpen = db.all(
    `SELECT assigned_team AS team, COUNT(*) AS n FROM tickets WHERE status NOT IN (${termPh}) AND assigned_team IS NOT NULL GROUP BY assigned_team`,
    termParams
  );
  for (const { team, n } of teamOpen) {
    lines.push(`# HELP supportdesk_open_tickets_by_team Open tickets by team`);
    lines.push(`# TYPE supportdesk_open_tickets_by_team gauge`);
    lines.push(`supportdesk_open_tickets_by_team{team="${team}"} ${n}`);
  }

  const escalated = db.get(`SELECT COUNT(*) AS n FROM tickets WHERE escalated = 1 AND status NOT IN (${termPh})`, termParams);
  lines.push(`# HELP supportdesk_escalated_open Currently escalated open tickets`);
  lines.push(`# TYPE supportdesk_escalated_open gauge`);
  lines.push(`supportdesk_escalated_open ${escalated.n}`);

  lines.push(`# HELP supportdesk_api_requests_total Total API requests`);
  lines.push(`# TYPE supportdesk_api_requests_total counter`);
  lines.push(`supportdesk_api_requests_total ${counters.api_requests}`);

  lines.push(`# HELP supportdesk_api_errors_total Total API errors`);
  lines.push(`# TYPE supportdesk_api_errors_total counter`);
  lines.push(`supportdesk_api_errors_total ${counters.api_errors}`);

  return lines.join('\n') + '\n';
}

module.exports = { inc, reset, render, counters };
