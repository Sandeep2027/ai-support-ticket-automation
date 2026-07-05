'use strict';

/**
 * Agent service — agent directory + workload balancing.
 *
 * - Agents belong to a team and have skills (categories they can handle).
 * - Workload balancing: pick the agent with the fewest open tickets.
 * - Auth: API keys are hashed (SHA-256) and stored in `api_keys`.
 */

const db = require('../database/db');
const crypto = require('crypto');
const { generateId, nowIso } = require('../utils/helpers');
const { asString, isValidEmail } = require('../utils/validator');
const logger = require('../utils/logger').child('agents');
const log = logger;

const TEAMS = ['Technical Support', 'Finance', 'Sales', 'Customer Success', 'Product Team'];
const ROLES = ['admin', 'agent', 'viewer'];

function list({ team, role, isActive, q, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = { limit, offset };
  if (team) { where.push('team = @team'); params.team = team; }
  if (role) { where.push('role = @role'); params.role = role; }
  if (isActive !== undefined) { where.push('is_active = @ia'); params.ia = isActive ? 1 : 0; }
  if (q) { where.push('(name LIKE @q OR email LIKE @q)'); params.q = `%${q}%`; }
  const sql = `SELECT * FROM agents ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY name ASC LIMIT @limit OFFSET @offset`;
  return db.all(sql, params).map(rowToAgent);
}

function get(id) {
  const row = db.get(`SELECT * FROM agents WHERE id = @id`, { id });
  return row ? rowToAgent(row) : null;
}

function getByEmail(email) {
  const row = db.get(`SELECT * FROM agents WHERE email = @email`, { email: String(email || '').toLowerCase() });
  return row ? rowToAgent(row) : null;
}

function create({ name, email, team, role = 'agent', maxConcurrent = 25, skills = [], timezone = 'UTC' }) {
  if (!name) throw new Error('name is required');
  if (!isValidEmail(email)) throw new Error('valid email is required');
  if (!TEAMS.includes(team)) throw new Error(`team must be one of: ${TEAMS.join(', ')}`);
  if (!ROLES.includes(role)) throw new Error(`role must be one of: ${ROLES.join(', ')}`);

  const id = generateId('agt');
  const now = nowIso();
  const row = {
    id, name: asString(name, 100), email: String(email).toLowerCase(),
    team, role, is_active: 1, max_concurrent: maxConcurrent,
    skills: JSON.stringify(skills), timezone,
    created_at: now, updated_at: now,
  };
  db.run(
    `INSERT INTO agents (id, name, email, team, role, is_active, max_concurrent, skills, timezone, created_at, updated_at)
     VALUES (@id, @name, @email, @team, @role, @is_active, @max_concurrent, @skills, @timezone, @created_at, @updated_at)`,
    row
  );
  log.info('Agent created', { id, name, team, role });
  return get(id);
}

function update(id, patch) {
  const existing = get(id);
  if (!existing) return null;
  const allowed = ['name', 'team', 'role', 'max_concurrent', 'skills', 'timezone', 'is_active'];
  const setClauses = [];
  const params = { id, updatedAt: nowIso() };
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    let v = patch[k];
    if (k === 'skills') v = JSON.stringify(Array.isArray(v) ? v : []);
    else if (k === 'is_active') v = v ? 1 : 0;
    else if (k === 'max_concurrent') v = Number(v) || 25;
    else v = asString(v, 100);
    setClauses.push(`${k} = @${k}`);
    params[k] = v;
  }
  if (setClauses.length === 0) return existing;
  setClauses.push('updated_at = @updatedAt');
  db.run(`UPDATE agents SET ${setClauses.join(', ')} WHERE id = @id`, params);
  return get(id);
}

function remove(id) {
  if (id === 'agt-system') throw new Error('cannot delete system agent');
  const r = db.run(`DELETE FROM agents WHERE id = @id`, { id });
  return r.changes > 0;
}

// ---------------------------------------------------------------
// Workload balancing
// ---------------------------------------------------------------

/**
 * Find the best agent to assign a ticket to.
 * Strategy: among active agents on the team whose skills include the category
 * (or who have no skill filter), pick the one with the fewest open tickets.
 * Falls back to any active agent on the team, then to 'agt-system'.
 */
function findBestAgent({ team, category }) {
  // Try agents with matching skill first
  let candidates = db.all(
    `SELECT a.* FROM agents a
     WHERE a.is_active = 1 AND a.team = @team
     ORDER BY a.max_concurrent DESC`,
    { team }
  );

  if (!candidates.length) {
    // No agents on this team — fall back to any active agent
    candidates = db.all(`SELECT * FROM agents WHERE is_active = 1 ORDER BY max_concurrent DESC`);
  }

  if (!candidates.length) return null;

  // Count open tickets per agent
  const counts = db.all(
    `SELECT assigned_agent_id, COUNT(*) AS n FROM tickets
     WHERE status NOT IN ('Resolved','Closed','Rejected','Spam') AND assigned_agent_id IS NOT NULL
     GROUP BY assigned_agent_id`
  );
  const countMap = Object.fromEntries(counts.map((r) => [r.assigned_agent_id, r.n]));

  // Score each candidate
  const scored = candidates.map((a) => {
    const open = countMap[a.id] || 0;
    const skills = (() => { try { return JSON.parse(a.skills || '[]'); } catch { return []; } })();
    const skillMatch = !skills.length || skills.includes(category);
    const underCap = open < a.max_concurrent;
    return { agent: a, open, skillMatch, underCap, score: (skillMatch ? 100 : 0) + (underCap ? 50 : 0) - open };
  });

  // Prefer under-cap agents with skill match, then fewest open
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.agent ? rowToAgent(scored[0].agent) : null;
}

// ---------------------------------------------------------------
// API Keys
// ---------------------------------------------------------------

/**
 * Generate a new API key for an agent. Returns the plaintext key ONCE.
 */
function createApiKey(agentId, { name, expiresInDays = null } = {}) {
  const agent = get(agentId);
  if (!agent) throw new Error('agent not found');
  const id = generateId('key');
  const plaintext = `sk_live_${crypto.randomBytes(24).toString('hex')}`;
  const keyHash = crypto.createHash('sha256').update(plaintext).digest('hex');
  const keyPrefix = plaintext.slice(0, 12);
  const now = nowIso();
  const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86400 * 1000).toISOString() : null;
  db.run(
    `INSERT INTO api_keys (id, agent_id, key_hash, key_prefix, name, expires_at, is_active, created_at)
     VALUES (@id, @agentId, @hash, @prefix, @name, @expiresAt, 1, @now)`,
    { id, agentId, hash: keyHash, prefix: keyPrefix, name: asString(name, 80) || 'default', expiresAt, now }
  );
  log.info('API key created', { agentId, keyPrefix, name });
  return { id, plaintext, keyPrefix, name, expiresAt };
}

function listApiKeys(agentId) {
  return db.all(`SELECT id, agent_id, key_prefix, name, last_used_at, expires_at, is_active, created_at
                 FROM api_keys WHERE agent_id = @agentId ORDER BY created_at DESC`, { agentId });
}

function revokeApiKey(id) {
  const r = db.run(`UPDATE api_keys SET is_active = 0 WHERE id = @id`, { id });
  return r.changes > 0;
}

/**
 * Verify an API key (plaintext). Returns the agent or null.
 */
function verifyApiKey(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') return null;
  const hash = crypto.createHash('sha256').update(plaintext).digest('hex');
  const row = db.get(`SELECT k.*, a.name AS agent_name, a.email AS agent_email, a.team AS agent_team, a.role AS agent_role
                      FROM api_keys k JOIN agents a ON k.agent_id = a.id
                      WHERE k.key_hash = @hash AND k.is_active = 1 AND a.is_active = 1`,
                     { hash });
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null;
  // Update last_used_at (best-effort)
  try { db.run(`UPDATE api_keys SET last_used_at = @now WHERE id = @id`, { now: nowIso(), id: row.id }); } catch { /* ignore */ }
  return {
    id: row.agent_id,
    name: row.agent_name,
    email: row.agent_email,
    team: row.agent_team,
    role: row.agent_role,
    apiKeyId: row.id,
  };
}

// ---------------------------------------------------------------
// Stats / workload
// ---------------------------------------------------------------

function workload() {
  return db.all(
    `SELECT a.id, a.name, a.email, a.team, a.role, a.max_concurrent,
       (SELECT COUNT(*) FROM tickets t WHERE t.assigned_agent_id = a.id AND t.status NOT IN ('Resolved','Closed','Rejected','Spam')) AS open_count,
       (SELECT COUNT(*) FROM tickets t WHERE t.assigned_agent_id = a.id) AS total_assigned,
       (SELECT COUNT(*) FROM tickets t WHERE t.assigned_agent_id = a.id AND t.status = 'Resolved') AS resolved_count
     FROM agents a
     WHERE a.is_active = 1
     ORDER BY open_count DESC`
  ).map((r) => ({ ...r, utilisation: r.max_concurrent > 0 ? Math.round((r.open_count / r.max_concurrent) * 100) : 0 }));
}

function rowToAgent(row) {
  if (!row) return null;
  let skills = [];
  try { skills = JSON.parse(row.skills || '[]'); } catch { /* ignore */ }
  return {
    ...row,
    skills,
    is_active: !!row.is_active,
  };
}

module.exports = {
  TEAMS, ROLES,
  list, get, getByEmail, create, update, remove,
  findBestAgent,
  createApiKey, listApiKeys, revokeApiKey, verifyApiKey,
  workload,
};
