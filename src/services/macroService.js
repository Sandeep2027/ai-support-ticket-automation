'use strict';

/**
 * Macro Service — canned response templates with variable substitution.
 *
 * Macros are pre-written responses that agents can insert into a reply with
 * one click. They support template variables that are auto-filled from the
 * ticket context, dramatically speeding up response time for common issues.
 *
 * Supported variables (resolved at apply time):
 *   {{customer_name}}        — ticket.customer_name
 *   {{first_name}}           — first word of customer_name
 *   {{sender_email}}         — ticket.sender_email
 *   {{ticket_id}}            — ticket.id
 *   {{category}}             — ticket.category
 *   {{priority}}             — ticket.priority
 *   {{assigned_team}}        — ticket.assigned_team
 *   {{assigned_agent_name}}  — agent's name (looked up)
 *   {{company}}              — ticket.company
 *   {{product_service}}      — ticket.product_service
 *   {{sla_due_at}}           — formatted SLA due date
 *   {{today}}                — today's date (YYYY-MM-DD)
 *   {{now}}                  — current timestamp (ISO)
 *   {{custom.<field_name>}}  — value of a custom field on the ticket
 *
 * Macros can be scoped to a category and/or team, so the UI only shows
 * relevant macros for the current ticket.
 */

const db = require('../database/db');
const { generateId, nowIso } = require('../utils/helpers');
const { asString, asArray } = require('../utils/validator');
const logger = require('../utils/logger').child('macros');
const log = logger;

const ALLOWED_VARIABLES = [
  'customer_name', 'first_name', 'sender_email', 'ticket_id', 'category',
  'priority', 'assigned_team', 'assigned_agent_name', 'company',
  'product_service', 'sla_due_at', 'today', 'now',
];

// ---------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------

function list({ category, team, q, isActive = true, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = { limit, offset };
  if (isActive !== undefined) { where.push('is_active = @ia'); params.ia = isActive ? 1 : 0; }
  if (category) { where.push('(category = @category OR category IS NULL)'); params.category = category; }
  if (team) { where.push('(team = @team OR team IS NULL)'); params.team = team; }
  if (q) { where.push('(name LIKE @q OR description LIKE @q OR body_template LIKE @q)'); params.q = `%${q}%`; }
  const sql = `SELECT * FROM macros ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY usage_count DESC, name ASC LIMIT @limit OFFSET @offset`;
  return db.all(sql, params).map(rowToMacro);
}

function get(id) {
  const row = db.get(`SELECT * FROM macros WHERE id = @id`, { id });
  return row ? rowToMacro(row) : null;
}

function create({ name, description, subjectTemplate, bodyTemplate, category, team, tags, authorId }) {
  if (!name) throw new Error('name is required');
  if (!bodyTemplate) throw new Error('bodyTemplate is required');
  const id = generateId('mac');
  const now = nowIso();
  const row = {
    id, name: asString(name, 100), description: asString(description, 500),
    subject_template: asString(subjectTemplate, 200) || null,
    body_template: asString(bodyTemplate, 10000),
    category: asString(category, 80) || null,
    team: asString(team, 80) || null,
    tags: JSON.stringify(asArray(tags, 10)),
    is_active: 1, usage_count: 0,
    author_id: authorId || null,
    created_at: now, updated_at: now,
  };
  db.run(
    `INSERT INTO macros (id, name, description, subject_template, body_template, category, team, tags, is_active, usage_count, author_id, created_at, updated_at)
     VALUES (@id, @name, @description, @subject_template, @body_template, @category, @team, @tags, @is_active, @usage_count, @author_id, @created_at, @updated_at)`,
    row
  );
  log.info('Macro created', { id, name });
  return get(id);
}

function update(id, patch) {
  const existing = get(id);
  if (!existing) return null;
  const allowed = ['name', 'description', 'subject_template', 'body_template', 'category', 'team', 'tags', 'is_active'];
  const setClauses = [];
  const params = { id, updatedAt: nowIso() };
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    let v = patch[k];
    if (k === 'tags') v = JSON.stringify(asArray(v, 10));
    else if (k === 'is_active') v = v ? 1 : 0;
    else if (k === 'body_template') v = asString(v, 10000);
    else if (k === 'subject_template') v = asString(v, 200) || null;
    else v = asString(v, 500);
    setClauses.push(`${k} = @${k}`);
    params[k] = v;
  }
  if (setClauses.length === 0) return existing;
  setClauses.push('updated_at = @updatedAt');
  db.run(`UPDATE macros SET ${setClauses.join(', ')} WHERE id = @id`, params);
  return get(id);
}

function remove(id) {
  const r = db.run(`DELETE FROM macros WHERE id = @id`, { id });
  return r.changes > 0;
}

// ---------------------------------------------------------------
// Variable substitution + apply
// ---------------------------------------------------------------

/**
 * Resolve template variables against a ticket context.
 * @param {string} template
 * @param {object} ticket  full ticket row
 * @param {object} [customFields]  { field_name: value, ... }
 * @param {object} [agentName]  name of the assigned agent
 * @returns {string}
 */
function renderTemplate(template, ticket, customFields = {}, agentName = '') {
  if (!template) return '';
  const vars = {
    customer_name: ticket.customer_name || '',
    first_name: (ticket.customer_name || '').split(' ')[0] || '',
    sender_email: ticket.sender_email || '',
    ticket_id: ticket.id || '',
    category: ticket.category || '',
    priority: ticket.priority || '',
    assigned_team: ticket.assigned_team || '',
    assigned_agent_name: agentName || '',
    company: ticket.company || '',
    product_service: ticket.product_service || '',
    sla_due_at: ticket.sla_due_at ? new Date(ticket.sla_due_at).toLocaleString() : '',
    today: new Date().toISOString().slice(0, 10),
    now: new Date().toISOString(),
  };

  let out = String(template);
  // Standard variables
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g'), v);
  }
  // Custom fields: {{custom.field_name}}
  out = out.replace(/\{\{\s*custom\.([a-zA-Z0-9_]+)\s*\}\}/g, (m, fieldName) => {
    return customFields[fieldName] !== undefined ? String(customFields[fieldName]) : '';
  });
  // Remove any unresolved variables
  out = out.replace(/\{\{[^}]+\}\}/g, '');
  return out;
}

/**
 * Apply a macro to a ticket — renders the template, increments usage count.
 * @returns {{subject: string, body: string}}
 */
function apply(macroId, ticket, customFields = {}, agentName = '') {
  const macro = get(macroId);
  if (!macro) throw new Error('macro not found');
  if (!macro.is_active) throw new Error('macro is inactive');

  // Check scope
  if (macro.category && macro.category !== ticket.category) {
    throw new Error(`macro is restricted to category "${macro.category}"`);
  }
  if (macro.team && macro.team !== ticket.assigned_team) {
    throw new Error(`macro is restricted to team "${macro.team}"`);
  }

  const subject = macro.subject_template ? renderTemplate(macro.subject_template, ticket, customFields, agentName) : '';
  const body = renderTemplate(macro.body_template, ticket, customFields, agentName);

  // Increment usage count
  db.run(`UPDATE macros SET usage_count = usage_count + 1, updated_at = @now WHERE id = @id`, { now: nowIso(), id: macroId });

  log.info('Macro applied', { macroId, ticketId: ticket.id, name: macro.name });
  return { subject, body, macro };
}

/**
 * Extract all variable names used in a template (for the editor UI).
 */
function extractVariables(template) {
  if (!template) return [];
  const vars = new Set();
  const re = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
  let m;
  while ((m = re.exec(template)) !== null) {
    vars.add(m[1]);
  }
  return Array.from(vars);
}

/**
 * Validate a template — returns { ok, errors[] }.
 */
function validateTemplate(template) {
  const errors = [];
  const used = extractVariables(template);
  for (const v of used) {
    if (v.startsWith('custom.')) continue; // custom fields are dynamic
    if (!ALLOWED_VARIABLES.includes(v)) {
      errors.push(`Unknown variable: {{${v}}}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function rowToMacro(row) {
  if (!row) return null;
  let tags = [];
  try { tags = JSON.parse(row.tags || '[]'); } catch { /* ignore */ }
  return {
    ...row,
    tags,
    is_active: !!row.is_active,
    variables_used: extractVariables(row.body_template || ''),
  };
}

module.exports = {
  ALLOWED_VARIABLES,
  list, get, create, update, remove,
  renderTemplate, apply, extractVariables, validateTemplate,
};
