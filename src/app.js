'use strict';

/**
 * Express app factory (Production v2).
 *
 * Wires together:
 *   - Helmet (security headers)
 *   - CORS (configurable)
 *   - JSON / URL-encoded parsers
 *   - Morgan request logging
 *   - Rate limiting (per-route)
 *   - Auth middleware (mounted in api.js)
 *   - API routes (/api)
 *   - Webhook routes (/webhooks)
 *   - Static frontend (/)
 *   - Background jobs (escalation sweeper)
 *   - Graceful error handlers
 */

const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const logger = require('./utils/logger');
const db = require('./database/db');
const apiRoutes = require('./routes/api');
const apiV3Routes = require('./routes/api-v3');
const webhookRoutes = require('./routes/webhooks');
const escalationService = require('./services/escalationService');
const metricsService = require('./services/metricsService');
const scheduledReportService = require('./services/scheduledReportService');
const snoozeService = require('./services/snoozeService');
const backupService = require('./services/backupService');

let handles = [];

function createApp() {
  const app = express();

  // ---- Security & basics ----
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(cors({ origin: config.cors.origin }));
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(morgan(config.isProd ? 'combined' : 'dev'));

  // Per-request error counter
  app.use((req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode >= 500) metricsService.inc('api_errors');
    });
    next();
  });

  // Rate limit the API (generous; tune per deployment)
  app.use('/api', rateLimit({
    windowMs: 60 * 1000,
    max: 240,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too many requests' },
  }));
  app.use('/webhooks', rateLimit({ windowMs: 60 * 1000, max: 120 }));

  // ---- Ensure DB schema is initialised ----
  db.getDb(); // side-effect: opens connection + applies schema

  // ---- Static frontend ----
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---- Routes ----
  app.use('/api', apiRoutes);
  app.use('/api/v3', apiV3Routes);
  app.use('/webhooks', webhookRoutes);

  // ---- 404 / error handlers ----
  app.use((req, res) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/webhooks')) {
      return res.status(404).json({ error: 'not found' });
    }
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    logger.error('Unhandled error', { error: err.message, stack: err.stack, path: req.path });
    metricsService.inc('api_errors');
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'payload too large' });
    }
    res.status(500).json({ error: 'internal server error', message: err.message });
  });

  // ---- Start background jobs ----
  handles.push(escalationService.startSweeper());
  handles.push(scheduledReportService.startSweeper());
  handles.push(snoozeService.startSweeper());
  handles.push(backupService.startBackupSweeper(24)); // daily backup

  return app;
}

function stopBackgroundJobs() {
  for (const h of handles) {
    if (h) clearInterval(h);
  }
  handles = [];
  logger.info('All background jobs stopped');
}

module.exports = { createApp, stopBackgroundJobs };
