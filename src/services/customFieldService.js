'use strict';

/**
 * Custom Field Service — user-defined fields per ticket.
 *
 * Allows admins to add structured fields beyond the built-in ticket schema.
 * Supports types: text, number, date, select, multiselect, boolean, url, email.
 *
 * Fields can be restricted to a specific category (e.g. "Server URL" only for
 * Technical Support tickets) and marked as required or filterable.
 *
 * Values are stored in custom_field_values with typed columns (value_text,
 * value_number, value_bool) for efficient querying.
 */

const db = require('../database/db');
const { generateId, nowIso } = require('../utils/helpers');
const { asString, asArray } = require('../utils/validator');
const logger = require('../utils/logger').child('custom-fields');
const log = logger;

const FIELD_TYPES = ['text', 'number', 'date', 'select', 'multiselect', 'boolean', 'url', 'email'];

// ---------------------------------------------------------------
// Field definition CRUD
// ---------------------------------------------------------------

function listDefinitions({ isActive = true, category, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = { limit, offset };
  if (isActive !== undefined) { where.push('is_active = @ia'); params.ia = isActive ? 1 : 0; }
  if (category) {
    where.push('(applies_to_category = @category OR applies_to_category IS NULL)');
    params.category = category;
  }
  const sql = `SELECT * FROM custom_fields ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY sort_order ASC, label ASC LIMIT @limit OFFSET @offset`;
  return db.all(sql, params).map(rowToDefinition);
}

function getDefinition(id) {
  const row = db.get(`SELECT * FROM custom_fields WHERE id = @id`, { id });
  return row ? rowToDefinition(row) : null;
}

function createDefinition({ name, label, type, options, defaultValue, isRequired, isFilterable, appliesToCategory, sortOrder }) {
  if (!name) throw new Error('name is required');
  if (!label) throw new Error('label is required');
  if (!FIELD_TYPES.includes(type)) throw new Error(`type must be one of: ${FIELD_TYPES.join(', ')}`);

  // Validate name is a valid identifier (for {{custom.<name>}} template variables)
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error('name must start with lowercase letter and contain only lowercase letters, digits, and underscores');
  }

  if (['select', 'multiselect'].includes(type) && (!options || !Array.isArray(options) || !options.length)) {
    throw new Error(`${type} fields require an options array`);
  }

  const id = generateId('cf');
  const now = nowIso();
  const row = {
    id, name: asString(name, 50), label: asString(label, 100), type,
    options: options ? JSON.stringify(asArray(options, 100)) : null,
    default_value: defaultValue != null ? String(defaultValue) : null,
    is_required: isRequired ? 1 : 0,
    is_filterable: isFilterable !== false ? 1 : 0,
    applies_to_category: asString(appliesToCategory, 80) || null,
    sort_order: Number(sortOrder) || 0,
    is_active: 1,
    created_at: now, updated_at: now,
  };
  db.run(
    `INSERT INTO custom_fields (id, name, label, type, options, default_value, is_required, is_filterable, applies_to_category, sort_order, is_active, created_at, updated_at)
     VALUES (@id, @name, @label, @type, @options, @default_value, @is_required, @is_filterable, @applies_to_category, @sort_order, @is_active, @created_at, @updated_at)`,
    row
  );
  log.info('Custom field created', { id, name, type });
  return getDefinition(id);
}

function updateDefinition(id, patch) {
  const existing = getDefinition(id);
  if (!existing) return null;
  const allowed = ['name', 'label', 'type', 'options', 'default_value', 'is_required', 'is_filterable', 'applies_to_category', 'sort_order', 'is_active'];
  const setClauses = [];
  const params = { id, updatedAt: nowIso() };
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    let v = patch[k];
    if (k === 'options') v = v ? JSON.stringify(asArray(v, 100)) : null;
    else if (['is_required', 'is_filterable', 'is_active'].includes(k)) v = v ? 1 : 0;
    else if (k === 'sort_order') v = Number(v) || 0;
    else v = asString(v, 200);
    setClauses.push(`${k} = @${k}`);
    params[k] = v;
  }
  if (setClauses.length === 0) return existing;
  setClauses.push('updated_at = @updatedAt');
  db.run(`UPDATE custom_fields SET ${setClauses.join(', ')} WHERE id = @id`, params);
  return getDefinition(id);
}

function removeDefinition(id) {
  const r = db.run(`DELETE FROM custom_fields WHERE id = @id`, { id });
  return r.changes > 0;
}

// ---------------------------------------------------------------
// Value CRUD (per ticket)
// ---------------------------------------------------------------

/**
 * Get all custom field values for a ticket, joined with definitions.
 */
function getValuesForTicket(ticketId) {
  return db.all(
    `SELECT cfv.id, cfv.ticket_id, cfv.value_text, cfv.value_number, cfv.value_bool,
            cf.id AS field_id, cf.name, cf.label, cf.type, cf.options, cf.is_required
     FROM custom_field_values cfv
     JOIN custom_fields cf ON cf.id = cfv.field_id
     WHERE cfv.ticket_id = @ticketId AND cf.is_active = 1
     ORDER BY cf.sort_order ASC, cf.label ASC`,
    { ticketId }
  ).map((r) => ({
    id: r.id,
    ticket_id: r.ticket_id,
    field_id: r.field_id,
    name: r.name,
    label: r.label,
    type: r.type,
    value: extractValue(r),
    is_required: !!r.is_required,
    options: r.options ? JSON.parse(r.options) : null,
  }));
}

/**
 * Set a custom field value on a ticket. Handles type coercion.
 * @param {string} ticketId
 * @param {string} fieldName  the field name (not id)
 * @param {*} value
 */
function setValue(ticketId, fieldName, value) {
  const field = db.get(`SELECT * FROM custom_fields WHERE name = @name AND is_active = 1`, { name: fieldName });
  if (!field) throw new Error(`custom field not found: ${fieldName}`);

  // Validate value
  if (field.is_required && (value == null || value === '')) {
    throw new Error(`${field.label} is required`);
  }
  if (['select', 'multiselect'].includes(field.type)) {
    const opts = JSON.parse(field.options || '[]');
    if (field.type === 'select') {
      if (!opts.includes(value)) throw new Error(`value must be one of: ${opts.join(', ')}`);
    } else {
      const vals = Array.isArray(value) ? value : [value];
      for (const v of vals) {
        if (!opts.includes(v)) throw new Error(`value must be one of: ${opts.join(', ')}`);
      }
    }
  }

  // Coerce value based on type
  const valueText = ['text', 'date', 'select', 'url', 'email'].includes(field.type)
    ? (field.type === 'multiselect' ? null : String(value))
    : (field.type === 'multiselect' ? JSON.stringify(asArray(value, 50)) : null);
  const valueNumber = field.type === 'number' ? Number(value) : null;
  const valueBool = field.type === 'boolean' ? (value ? 1 : 0) : null;

  db.run(
    `INSERT INTO custom_field_values (ticket_id, field_id, value_text, value_number, value_bool, updated_at)
     VALUES (@ticketId, @fieldId, @vt, @vn, @vb, @now)
     ON CONFLICT(ticket_id, field_id) DO UPDATE SET
       value_text = @vt, value_number = @vn, value_bool = @vb, updated_at = @now`,
    { ticketId, fieldId: field.id, vt: valueText, vn: valueNumber, vb: valueBool, now: nowIso() }
  );

  return { ticketId, fieldName, value };
}

/**
 * Get a single custom field value for a ticket (by field name).
 */
function getValue(ticketId, fieldName) {
  const row = db.get(
    `SELECT cfv.*, cf.type, cf.name, cf.label
     FROM custom_field_values cfv
     JOIN custom_fields cf ON cf.id = cfv.field_id
     WHERE cfv.ticket_id = @ticketId AND cf.name = @fieldName`,
    { ticketId, fieldName }
  );
  return row ? extractValue(row) : null;
}

/**
 * Get all custom fields as a { name: value } map for a ticket.
 * Used by macroService.renderTemplate for {{custom.<name>}} substitution.
 */
function getValuesMap(ticketId) {
  const rows = getValuesForTicket(ticketId);
  const out = {};
  for (const r of rows) out[r.name] = r.value;
  return out;
}

/**
 * Filter tickets by a custom field value.
 * Returns ticket IDs matching the filter.
 */
function filterByCustomField(fieldName, value, op = 'eq') {
  const field = db.get(`SELECT * FROM custom_fields WHERE name = @name AND is_active = 1`, { name: fieldName });
  if (!field) return [];

  let sql, params;
  if (field.type === 'number') {
    sql = `SELECT ticket_id FROM custom_field_values WHERE field_id = @fid AND value_number ${op === 'gt' ? '>' : op === 'lt' ? '<' : '='} @val`;
    params = { fid: field.id, val: Number(value) };
  } else if (field.type === 'boolean') {
    sql = `SELECT ticket_id FROM custom_field_values WHERE field_id = @fid AND value_bool = @val`;
    params = { fid: field.id, val: value ? 1 : 0 };
  } else {
    if (op === 'eq') {
      sql = `SELECT ticket_id FROM custom_field_values WHERE field_id = @fid AND value_text = @val`;
    } else if (op === 'contains') {
      sql = `SELECT ticket_id FROM custom_field_values WHERE field_id = @fid AND value_text LIKE @val`;
    } else if (op === 'in') {
      const vals = Array.isArray(value) ? value : [value];
      sql = `SELECT ticket_id FROM custom_field_values WHERE field_id = @fid AND value_text IN (${vals.map(() => '?').join(',')})`;
      return db.all(sql, field.id, ...vals).map((r) => r.ticket_id);
    }
    params = { fid: field.id, val: op === 'contains' ? `%${value}%` : String(value) };
  }
  return db.all(sql, params).map((r) => r.ticket_id);
}

function extractValue(row) {
  if (!row) return null;
  if (row.type === 'number') return row.value_number;
  if (row.type === 'boolean') return !!row.value_bool;
  if (row.type === 'multiselect') {
    try { return JSON.parse(row.value_text || '[]'); } catch { return []; }
  }
  return row.value_text;
}

function rowToDefinition(row) {
  if (!row) return null;
  let options = null;
  try { options = row.options ? JSON.parse(row.options) : null; } catch { /* ignore */ }
  return {
    ...row,
    options,
    is_required: !!row.is_required,
    is_filterable: !!row.is_filterable,
    is_active: !!row.is_active,
  };
}

module.exports = {
  FIELD_TYPES,
  listDefinitions, getDefinition, createDefinition, updateDefinition, removeDefinition,
  getValuesForTicket, setValue, getValue, getValuesMap, filterByCustomField,
};
