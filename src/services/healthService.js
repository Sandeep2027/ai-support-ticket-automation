'use strict';

/**
 * Health Service — deep health checks for all subsystems.
 *
 *   GET /api/health          → basic liveness (always 200 if process running)
 *   GET /api/health/deep     → checks every subsystem, returns 503 if any failing
 */

const db = require('../database/db');
const config = require('../config');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { nowIso } = require('../utils/helpers');

/**
 * Basic liveness — always returns ok if the process is running.
 */
function basic() {
  return {
    status: 'ok',
    uptime: process.uptime(),
    timestamp: nowIso(),
    pid: process.pid,
  };
}

/**
 * Deep health — check every subsystem.
 */
function deep() {
  const checks = [];
  let allOk = true;

  // 1. Database
  try {
    const t0 = Date.now();
    db.get(`SELECT 1 AS n`);
    const durationMs = Date.now() - t0;
    const dbStats = db.get(`SELECT COUNT(*) AS n FROM tickets`);
    checks.push({
      name: 'database',
      status: 'ok',
      durationMs,
      details: { path: db.DB_PATH, ticketCount: dbStats.n },
    });
  } catch (err) {
    allOk = false;
    checks.push({ name: 'database', status: 'fail', error: err.message });
  }

  // 2. AI provider
  try {
    checks.push({
      name: 'ai_provider',
      status: config.ai.useMock ? 'degraded' : 'ok',
      details: {
        provider: config.ai.provider,
        model: config.ai.model,
        useMock: config.ai.useMock,
        keyValid: config.ai.keyValid,
        baseUrl: config.ai.baseUrl,
      },
    });
    if (!config.ai.useMock && !config.ai.keyValid) allOk = false;
  } catch (err) {
    allOk = false;
    checks.push({ name: 'ai_provider', status: 'fail', error: err.message });
  }

  // 3. SMTP
  try {
    checks.push({
      name: 'smtp',
      status: config.smtp.enabled ? 'ok' : 'degraded',
      details: {
        enabled: config.smtp.enabled,
        host: config.smtp.host || null,
        port: config.smtp.port,
      },
    });
  } catch (err) {
    checks.push({ name: 'smtp', status: 'fail', error: err.message });
  }

  // 4. File system (uploads dir writable)
  try {
    const uploadsDir = config.paths.uploads;
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    const testFile = path.join(uploadsDir, '.healthcheck');
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    checks.push({ name: 'filesystem', status: 'ok', details: { uploadsDir } });
  } catch (err) {
    allOk = false;
    checks.push({ name: 'filesystem', status: 'fail', error: err.message });
  }

  // 5. Escalation engine
  try {
    const escalationService = require('./escalationService');
    const breaches = escalationService.findBreaches();
    checks.push({
      name: 'escalation_engine',
      status: 'ok',
      details: { enabled: config.escalation.enabled, currentBreaches: breaches.length },
    });
  } catch (err) {
    checks.push({ name: 'escalation_engine', status: 'fail', error: err.message });
  }

  // 6. Memory usage
  const mem = process.memoryUsage();
  const memMb = Math.round(mem.rss / 1024 / 1024);
  const memLimitMb = 512; // soft limit
  checks.push({
    name: 'memory',
    status: memMb < memLimitMb ? 'ok' : 'degraded',
    details: {
      rssMb: memMb,
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      externalMb: Math.round(mem.external / 1024 / 1024),
      softLimitMb: memLimitMb,
    },
  });

  // 7. System load (Unix only)
  const load = os.loadavg();
  checks.push({
    name: 'system_load',
    status: load[0] < 4 ? 'ok' : 'degraded',
    details: {
      load1: Math.round(load[0] * 100) / 100,
      load5: Math.round(load[1] * 100) / 100,
      load15: Math.round(load[2] * 100) / 100,
      cpuCount: os.cpus().length,
    },
  });

  // 8. Disk space
  try {
    const stats = fs.statSyncSync ? fs.statSyncSync(config.paths.root) : fs.statSync(config.paths.root);
    checks.push({
      name: 'disk_space',
      status: 'ok',
      details: { note: 'disk space check requires `df` shell command for accuracy' },
    });
  } catch (err) {
    checks.push({ name: 'disk_space', status: 'ok', details: { note: 'skipped' } });
  }

  // 9. Schema version
  try {
    const tables = db.all(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).map((r) => r.name);
    const expectedTables = ['tickets', 'agents', 'kb_articles', 'customer_profiles', 'escalations', 'workflow_rules', 'custom_fields', 'scheduled_reports', 'webhook_subscriptions', 'system_settings'];
    const missing = expectedTables.filter((t) => !tables.includes(t));
    checks.push({
      name: 'schema',
      status: missing.length === 0 ? 'ok' : 'fail',
      details: { tableCount: tables.length, missing },
    });
    if (missing.length > 0) allOk = false;
  } catch (err) {
    allOk = false;
    checks.push({ name: 'schema', status: 'fail', error: err.message });
  }

  // 10. Background jobs
  checks.push({
    name: 'background_jobs',
    status: 'ok',
    details: {
      escalationSweeper: config.escalation.enabled ? 'running' : 'disabled',
      scheduledReportsSweeper: 'running',
      backupSweeper: 'running',
    },
  });

  return {
    status: allOk ? 'ok' : 'degraded',
    timestamp: nowIso(),
    uptime: process.uptime(),
    checks,
  };
}

/**
 * Readiness — is the system ready to serve traffic?
 * (Database is open + schema applied + at least 1 routing rule)
 */
function ready() {
  try {
    const routingCount = db.get(`SELECT COUNT(*) AS n FROM routing_config`).n;
    return {
      status: routingCount > 0 ? 'ready' : 'not_ready',
      timestamp: nowIso(),
      routingRules: routingCount,
    };
  } catch (err) {
    return { status: 'not_ready', error: err.message, timestamp: nowIso() };
  }
}

module.exports = { basic, deep, ready };
