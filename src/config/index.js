'use strict';

/**
 * Centralised configuration loader.
 *
 * Reads from process.env (with dotenv). The system uses **xAI Grok** as the
 * sole AI provider — only `GROK_API_KEY` is required for AI features.
 *
 * Required env vars for production:
 *   - GROK_API_KEY   (xAI API key, starts with "xai-")
 *   - SMTP_HOST      (e.g. smtp.gmail.com)
 *   - SMTP_PASS      (SMTP password or app-specific password)
 *   - SMTP_FROM      (sender email shown to customers, e.g. "Support <support@x.com>")
 *   - PORT           (server port, default 3000)
 *
 * When GROK_API_KEY is empty, the system falls back to a built-in rule-based
 * mock so the full pipeline can still be demoed. When SMTP_HOST is empty,
 * acknowledgment emails are logged to console instead of being sent.
 */

const path = require('path');
require('dotenv').config();

const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

const bool = (v, dflt = false) => {
  if (v === undefined || v === null || v === '') return dflt;
  return String(v).toLowerCase() === 'true';
};

// ---------------------------------------------------------------
// Grok (xAI) — the sole AI provider.
// Endpoint: https://api.x.ai/v1/chat/completions
// Auth:     Authorization: Bearer xai-...
// JSON mode: response_format: { type: 'json_object' } (supported on grok-2-*+)
// ---------------------------------------------------------------
const GROK_PRESET = {
  label: 'xAI Grok',
  baseUrl: 'https://api.x.ai/v1',
  defaultModel: 'grok-2-latest',
  models: ['grok-2-latest', 'grok-2-1212', 'grok-2-mini', 'grok-beta', 'grok-3', 'grok-4', 'grok-4-fast-reasoning', 'grok-code-fast-1'],
  notes: 'xAI Grok. API keys start with "xai-". Supports response_format=json_object.',
};

// ---------------------------------------------------------------
// Parse SMTP_FROM to extract a default SMTP_USER if not set.
// Example: SMTP_FROM="Support Desk <support@x.com>" → SMTP_USER defaults to "support@x.com"
// ---------------------------------------------------------------
function parseSmtpUserFrom(smtpFrom, smtpUser) {
  if (smtpUser && smtpUser.trim()) return smtpUser.trim();
  if (!smtpFrom) return '';
  // Extract email from "Name <email>" or plain "email@x.com"
  const m = String(smtpFrom).match(/<([^>]+)>/);
  if (m) return m[1].trim();
  // Plain email
  const m2 = String(smtpFrom).match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  if (m2) return m2[0];
  return '';
}

const config = {
  env: process.env.NODE_ENV || 'development',
  isProd: (process.env.NODE_ENV || 'development') === 'production',
  port: num(process.env.PORT, 3000),

  cors: {
    origin: (process.env.CORS_ORIGIN || '*').split(',').map((s) => s.trim()),
  },

  ai: {
    provider: 'grok',
    providerLabel: GROK_PRESET.label,
    apiKey: process.env.GROK_API_KEY || process.env.AI_API_KEY || '',
    baseUrl: (process.env.AI_BASE_URL || GROK_PRESET.baseUrl).replace(/\/+$/, ''),
    model: process.env.AI_MODEL || GROK_PRESET.defaultModel,
    maxTokens: num(process.env.AI_MAX_TOKENS, 1500),
    temperature: num(process.env.AI_TEMPERATURE, 0.2),
    forceMock: bool(process.env.AI_FORCE_MOCK, false),
    // Secondary model for cheaper tasks (spam/lang detection). Empty = use primary.
    secondaryModel: process.env.AI_SECONDARY_MODEL || '',
    // Per-request timeout (ms) for LLM calls
    timeoutMs: num(process.env.AI_TIMEOUT_MS, 30000),
    get useMock() {
      return this.forceMock || !this.apiKey;
    },
    // Whether the API key looks valid (starts with xai-)
    get keyValid() {
      if (!this.apiKey) return false;
      return this.apiKey.startsWith('xai-');
    },
  },

  email: {
    webhookToken: process.env.EMAIL_WEBHOOK_TOKEN || 'change-me-in-production',
    maxAttachmentMb: num(process.env.MAX_ATTACHMENT_MB, 25),
  },

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: num(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: parseSmtpUserFrom(process.env.SMTP_FROM, process.env.SMTP_USER),
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'Support Desk <support@example.com>',
    get enabled() {
      return !!this.host && !!this.pass && !!this.user;
    },
  },

  db: {
    path: process.env.DB_PATH || './data/support.db',
  },

  routing: {
    map: (() => {
      try {
        return process.env.ROUTING_MAP ? JSON.parse(process.env.ROUTING_MAP) : null;
      } catch {
        return null;
      }
    })(),
  },

  sla: {
    Critical: num(process.env.SLA_CRITICAL, 2),
    High: num(process.env.SLA_HIGH, 8),
    Medium: num(process.env.SLA_MEDIUM, 24),
    Low: num(process.env.SLA_LOW, 72),
  },

  escalation: {
    enabled: bool(process.env.ESCALATION_ENABLED, true),
    sweepIntervalMin: num(process.env.ESCALATION_SWEEP_MIN, 5),
    levels: [
      { atMinutes: 0, action: 'notify_team', description: 'SLA deadline reached — notify team' },
      { atMinutes: 30, action: 'notify_lead', description: '30 min overdue — notify team lead' },
      { atMinutes: 120, action: 'notify_admins', description: '2h overdue — notify all admins' },
    ],
  },

  spam: {
    enabled: bool(process.env.SPAM_ENABLED, true),
    threshold: num(process.env.SPAM_THRESHOLD, 70),
    autoRejectThreshold: num(process.env.SPAM_AUTO_REJECT, 90),
  },

  pii: {
    enabled: bool(process.env.PII_ENABLED, true),
    redactInBody: bool(process.env.PII_REDACT_BODY, true),
  },

  notifications: {
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',
    teamsWebhookUrl: process.env.TEAMS_WEBHOOK_URL || '',
    digestEmail: process.env.DIGEST_EMAIL || '',
    defaultEvents: ['ticket_created', 'sla_breach', 'escalation', 'spam_detected', 'critical_priority'],
  },

  auth: {
    enabled: bool(process.env.AUTH_ENABLED, false),
    headerName: 'X-API-Key',
  },

  log: {
    level: process.env.LOG_LEVEL || 'info',
  },

  paths: {
    root: process.cwd(),
    uploads: path.resolve(process.cwd(), 'uploads'),
    samples: path.resolve(process.cwd(), 'data', 'sample-emails'),
  },

  features: {
    knowledgeBase: bool(process.env.FEATURE_KB, true),
    autoResolution: bool(process.env.FEATURE_AUTO_RESOLUTION, true),
    duplicateDetection: bool(process.env.FEATURE_DUPLICATE, true),
    bulkOps: bool(process.env.FEATURE_BULK, true),
    metricsExport: bool(process.env.FEATURE_METRICS, true),
  },
};

module.exports = config;
