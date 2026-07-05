'use strict';

/**
 * Auth middleware — API key based.
 *
 * When config.auth.enabled is false, all requests act as the system admin agent.
 * When enabled, requests must include a valid X-API-Key header (or Authorization: Bearer).
 * Role-based access:
 *   admin  → everything
 *   agent  → read + write tickets, notes, KB
 *   viewer → read-only
 */

const config = require('../config');
const agentService = require('../services/agentService');

const SYSTEM_AGENT = {
  id: 'agt-system',
  name: 'System',
  email: 'system@localhost',
  team: 'Customer Success',
  role: 'admin',
  apiKeyId: null,
};

function extractKey(req) {
  // Try header first
  const header = req.header(config.auth.headerName);
  if (header) return header.trim();
  // Fall back to Authorization: Bearer
  const auth = req.header('Authorization');
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  // Query param (last resort — useful for webhooks/links)
  if (req.query.api_key) return String(req.query.api_key);
  return null;
}

function middleware(req, res, next) {
  if (!config.auth.enabled) {
    req.agent = SYSTEM_AGENT;
    return next();
  }

  const key = extractKey(req);
  if (!key) {
    return res.status(401).json({ error: 'authentication required', hint: `send ${config.auth.headerName} header` });
  }

  const agent = agentService.verifyApiKey(key);
  if (!agent) {
    return res.status(401).json({ error: 'invalid or revoked API key' });
  }

  req.agent = agent;
  next();
}

/**
 * Require a minimum role. Use after `middleware`.
 *   requireRole('admin')   → only admins
 *   requireRole('agent')   → admins + agents
 *   requireRole('viewer')  → everyone (read-only check)
 */
function requireRole(minRole) {
  const order = { viewer: 1, agent: 2, admin: 3 };
  return (req, res, next) => {
    const role = req.agent?.role || 'viewer';
    if ((order[role] || 0) < (order[minRole] || 0)) {
      return res.status(403).json({ error: 'insufficient role', required: minRole, current: role });
    }
    next();
  };
}

/**
 * Write operations require at least agent role.
 */
function requireWrite(req, res, next) {
  return requireRole('agent')(req, res, next);
}

module.exports = { middleware, requireRole, requireWrite, SYSTEM_AGENT };
