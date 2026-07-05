'use strict';

/**
 * AI Customer Support Ticket Automation — server entry point.
 *
 * Run:
 *   node server.js
 *
 * Env:
 *   PORT (default 3000) — see .env.example for the full list.
 */

const { createApp, stopBackgroundJobs } = require('./src/app');
const config = require('./src/config');
const logger = require('./src/utils/logger');
const db = require('./src/database/db');

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info('==========================================================');
  logger.info(`  AI Support Ticket Automation v3 running on port ${config.port}`);
  logger.info(`  Mode        : ${config.env}`);
  logger.info(`  AI provider : ${config.ai.useMock ? 'MOCK (rule-based)' : `${config.ai.providerLabel} — ${config.ai.model} @ ${config.ai.baseUrl}`}`);
  logger.info(`  AI key valid: ${config.ai.useMock ? 'n/a (mock)' : (config.ai.keyValid ? 'yes' : 'NO — check AI_API_KEY')}`);
  logger.info(`  SMTP        : ${config.smtp.enabled ? 'enabled' : 'disabled (acks logged to console)'}`);
  logger.info(`  Database    : ${db.DB_PATH}`);
  logger.info(`  Auth        : ${config.auth.enabled ? 'enabled (X-API-Key required)' : 'disabled (system admin mode)'}`);
  logger.info(`  Spam detect : ${config.spam.enabled ? `enabled (threshold ${config.spam.threshold}, auto-reject ${config.spam.autoRejectThreshold})` : 'disabled'}`);
  logger.info(`  PII redact  : ${config.pii.enabled ? 'enabled' : 'disabled'}`);
  logger.info(`  Escalation  : ${config.escalation.enabled ? `enabled (sweep every ${config.escalation.sweepIntervalMin}min)` : 'disabled'}`);
  logger.info(`  KB / RAG    : ${config.features.knowledgeBase ? 'enabled' : 'disabled'}`);
  logger.info(`  Slack notif : ${config.notifications.slackWebhookUrl ? 'enabled' : 'disabled'}`);
  logger.info(`  Teams notif : ${config.notifications.teamsWebhookUrl ? 'enabled' : 'disabled'}`);
  logger.info('  --- v3 advanced operations ---');
  logger.info('  Macros          : enabled (canned responses with variables)');
  logger.info('  SLA policies    : enabled (per-customer/category overrides + business hours)');
  logger.info('  Workflow rules  : enabled (if-then automation engine)');
  logger.info('  Custom fields   : enabled (user-defined fields per ticket)');
  logger.info('  Scheduled reps  : enabled (daily/weekly/monthly email summaries)');
  logger.info('  Outbound webhk  : enabled (HMAC-signed event delivery)');
  logger.info('  Translations    : enabled (AI-powered, cached)');
  logger.info('  Ticket similarity: enabled (FTS5 + scoring)');
  logger.info('  Snoozes         : enabled (temporarily hide tickets)');
  logger.info('  Threading       : enabled (conversation grouping)');
  logger.info('  Audit search    : enabled (advanced filtering + CSV export)');
  logger.info('  Backup/restore  : enabled (VACUUM INTO + JSON export)');
  logger.info('  Deep health     : enabled (/api/v3/health/deep)');
  logger.info('  System settings : enabled (runtime config store)');
  logger.info(`  Dashboard   : http://localhost:${config.port}`);
  logger.info(`  Webhook     : http://localhost:${config.port}/webhooks/email?token=<EMAIL_WEBHOOK_TOKEN>`);
  logger.info(`  Health      : http://localhost:${config.port}/api/health`);
  logger.info(`  Health deep : http://localhost:${config.port}/api/v3/health/deep`);
  logger.info(`  Metrics     : http://localhost:${config.port}/api/metrics`);
  logger.info(`  API v3 base : http://localhost:${config.port}/api/v3`);
  logger.info('==========================================================');
});

// Graceful shutdown
function shutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully`);
  stopBackgroundJobs();
  server.close(() => {
    db.close();
    logger.info('Process exited');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { error: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', { reason: String(reason) });
});

module.exports = server;
