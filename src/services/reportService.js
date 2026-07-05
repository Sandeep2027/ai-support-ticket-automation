'use strict';

/**
 * Report service — advanced analytics for the dashboard.
 *
 * - Time-series (tickets per day/hour for last N periods)
 * - Agent performance (resolution rate, avg first-response, avg resolution time)
 * - Team workload distribution
 * - SLA compliance rate
 * - Sentiment trend
 * - Spam detection rate
 * - Category distribution over time
 */

const db = require('../database/db');
const { nowIso } = require('../utils/helpers');

const TERMINAL = ['Resolved', 'Closed', 'Rejected', 'Spam'];
const TERM_PH = TERMINAL.map((_, i) => `@t${i}`).join(',');
const TERM_PARAMS = {};
TERMINAL.forEach((s, i) => { TERM_PARAMS[`t${i}`] = s; });

// ---------------------------------------------------------------
// Time-series: tickets created per day for last N days
// ---------------------------------------------------------------
function timeseriesCreated(days = 30) {
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
  const rows = db.all(
    `SELECT DATE(received_at) AS day, COUNT(*) AS n
     FROM tickets
     WHERE received_at >= @since
     GROUP BY DATE(received_at)
     ORDER BY day ASC`,
    { since }
  );
  // Fill missing days with 0
  const map = Object.fromEntries(rows.map((r) => [r.day, r.n]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400 * 1000);
    const day = d.toISOString().slice(0, 10);
    out.push({ day, count: map[day] || 0 });
  }
  return out;
}

// Time-series: tickets resolved per day
function timeseriesResolved(days = 30) {
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
  const rows = db.all(
    `SELECT DATE(resolved_at) AS day, COUNT(*) AS n
     FROM tickets
     WHERE resolved_at >= @since AND status = 'Resolved'
     GROUP BY DATE(resolved_at)
     ORDER BY day ASC`,
    { since }
  );
  const map = Object.fromEntries(rows.map((r) => [r.day, r.n]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400 * 1000);
    const day = d.toISOString().slice(0, 10);
    out.push({ day, count: map[day] || 0 });
  }
  return out;
}

// ---------------------------------------------------------------
// Agent performance leaderboard
// ---------------------------------------------------------------
function agentPerformance() {
  const rows = db.all(
    `SELECT
       a.id, a.name, a.team,
       COUNT(t.id) AS total_assigned,
       SUM(CASE WHEN t.status = 'Resolved' THEN 1 ELSE 0 END) AS resolved_count,
       SUM(CASE WHEN t.status NOT IN (${TERM_PH}) THEN 1 ELSE 0 END) AS open_count,
       AVG(t.confidence_score) AS avg_confidence,
       AVG(CASE WHEN t.first_response_at IS NOT NULL THEN
         (julianday(t.first_response_at) - julianday(t.received_at)) * 24 * 60
       END) AS avg_first_response_min,
       AVG(CASE WHEN t.resolved_at IS NOT NULL THEN
         (julianday(t.resolved_at) - julianday(t.received_at)) * 24 * 60
       END) AS avg_resolution_min
     FROM agents a
     LEFT JOIN tickets t ON t.assigned_agent_id = a.id
     WHERE a.is_active = 1 AND a.id != 'agt-system'
     GROUP BY a.id
     ORDER BY resolved_count DESC`,
    TERM_PARAMS
  );
  return rows.map((r) => ({
    ...r,
    resolution_rate: r.total_assigned > 0 ? Math.round((r.resolved_count / r.total_assigned) * 100) : 0,
    avg_first_response_min: r.avg_first_response_min ? Math.round(r.avg_first_response_min) : null,
    avg_resolution_min: r.avg_resolution_min ? Math.round(r.avg_resolution_min) : null,
    avg_confidence: r.avg_confidence ? Math.round(r.avg_confidence) : 0,
  }));
}

// ---------------------------------------------------------------
// Team workload
// ---------------------------------------------------------------
function teamWorkload() {
  return db.all(
    `SELECT
       assigned_team AS team,
       COUNT(*) AS total,
       SUM(CASE WHEN status NOT IN (${TERM_PH}) THEN 1 ELSE 0 END) AS open,
       SUM(CASE WHEN status = 'Resolved' THEN 1 ELSE 0 END) AS resolved,
       SUM(CASE WHEN priority = 'Critical' AND status NOT IN (${TERM_PH}) THEN 1 ELSE 0 END) AS critical_open,
       SUM(CASE WHEN escalated = 1 THEN 1 ELSE 0 END) AS escalated,
       AVG(confidence_score) AS avg_confidence
     FROM tickets
     WHERE assigned_team IS NOT NULL
     GROUP BY assigned_team
     ORDER BY total DESC`,
    TERM_PARAMS
  ).map((r) => ({
    ...r,
    avg_confidence: r.avg_confidence ? Math.round(r.avg_confidence) : 0,
  }));
}

// ---------------------------------------------------------------
// SLA compliance
// ---------------------------------------------------------------
function slaCompliance() {
  const total = db.get(`SELECT COUNT(*) AS n FROM tickets WHERE sla_due_at IS NOT NULL`).n;
  const breached = db.get(`SELECT COUNT(*) AS n FROM tickets WHERE sla_breached = 1`).n;
  const byPriority = db.all(
    `SELECT priority,
       COUNT(*) AS total,
       SUM(sla_breached) AS breached
     FROM tickets
     WHERE sla_due_at IS NOT NULL
     GROUP BY priority`
  );
  return {
    total,
    breached,
    compliance_rate: total > 0 ? Math.round(((total - breached) / total) * 100) : 100,
    byPriority: byPriority.map((r) => ({
      priority: r.priority,
      total: r.total,
      breached: r.breached,
      compliance_rate: r.total > 0 ? Math.round(((r.total - r.breached) / r.total) * 100) : 100,
    })),
  };
}

// ---------------------------------------------------------------
// Sentiment trend (last N days)
// ---------------------------------------------------------------
function sentimentTrend(days = 30) {
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
  return db.all(
    `SELECT DATE(received_at) AS day, sentiment, COUNT(*) AS n
     FROM tickets
     WHERE received_at >= @since AND sentiment IS NOT NULL
     GROUP BY DATE(received_at), sentiment
     ORDER BY day ASC`,
    { since }
  );
}

// ---------------------------------------------------------------
// Spam stats
// ---------------------------------------------------------------
function spamStats() {
  const total = db.get(`SELECT COUNT(*) AS n FROM tickets`).n;
  const spam = db.get(`SELECT COUNT(*) AS n FROM tickets WHERE is_spam = 1`).n;
  const autoRejected = db.get(`SELECT COUNT(*) AS n FROM inbox_log WHERE status = 'skipped' AND reason LIKE '%spam%'`).n;
  return {
    total,
    spam_detected: spam,
    spam_rate: total > 0 ? Math.round((spam / total) * 1000) / 10 : 0,
    auto_rejected: autoRejected,
  };
}

// ---------------------------------------------------------------
// Category breakdown over time
// ---------------------------------------------------------------
function categoryTimeseries(days = 30) {
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
  return db.all(
    `SELECT DATE(received_at) AS day, category, COUNT(*) AS n
     FROM tickets
     WHERE received_at >= @since
     GROUP BY DATE(received_at), category
     ORDER BY day ASC`,
    { since }
  );
}

// ---------------------------------------------------------------
// First-response time / resolution time averages
// ---------------------------------------------------------------
function responseTimes() {
  const row = db.get(
    `SELECT
       AVG(CASE WHEN first_response_at IS NOT NULL THEN
         (julianday(first_response_at) - julianday(received_at)) * 24 * 60
       END) AS avg_first_response_min,
       AVG(CASE WHEN resolved_at IS NOT NULL THEN
         (julianday(resolved_at) - julianday(received_at)) * 24 * 60
       END) AS avg_resolution_min,
       AVG(CASE WHEN resolved_at IS NOT NULL THEN
         (julianday(resolved_at) - julianday(received_at)) * 24
       END) AS avg_resolution_hours
     FROM tickets`
  );
  return {
    avg_first_response_min: row.avg_first_response_min ? Math.round(row.avg_first_response_min) : null,
    avg_resolution_min: row.avg_resolution_min ? Math.round(row.avg_resolution_min) : null,
    avg_resolution_hours: row.avg_resolution_hours ? Math.round(row.avg_resolution_hours * 10) / 10 : null,
  };
}

// ---------------------------------------------------------------
// Master dashboard report
// ---------------------------------------------------------------
function full() {
  return {
    timeseries: {
      created: timeseriesCreated(30),
      resolved: timeseriesResolved(30),
      categories: categoryTimeseries(30),
    },
    agents: agentPerformance(),
    teams: teamWorkload(),
    sla: slaCompliance(),
    sentiment: sentimentTrend(30),
    spam: spamStats(),
    responseTimes: responseTimes(),
    generatedAt: nowIso(),
  };
}

module.exports = {
  timeseriesCreated,
  timeseriesResolved,
  agentPerformance,
  teamWorkload,
  slaCompliance,
  sentimentTrend,
  spamStats,
  categoryTimeseries,
  responseTimes,
  full,
};
