'use strict';

/**
 * System Settings Service — key-value config store.
 *
 * Stores runtime-configurable settings in the database so they can be
 * changed without restarting. Sensitive values (API keys, secrets) are
 * marked with is_sensitive=1 and redacted in list responses.
 */

const db = require('../database/db');
const { nowIso } = require('../utils/helpers');
const { asString } = require('../utils/validator');
const logger = require('../utils/logger').child('settings');
const log = logger;

function list({ category, includeSensitive = false } = {}) {
  const where = [];
  const params = {};
  if (category) { where.push('category = @category'); params.category = category; }
  const sql = `SELECT * FROM system_settings ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY category, key`;
  const rows = db.all(sql, params);
  return rows.map((r) => ({
    ...r,
    value: r.is_sensitive && !includeSensitive ? '***REDACTED***' : r.value,
    is_sensitive: !!r.is_sensitive,
  }));
}

function get(key) {
  const row = db.get(`SELECT * FROM system_settings WHERE key = @key`, { key });
  if (!row) return null;
  return row.value;
}

function getWithMeta(key) {
  const row = db.get(`SELECT * FROM system_settings WHERE key = @key`, { key });
  return row ? { ...row, is_sensitive: !!row.is_sensitive } : null;
}

function set(key, value, { description, category, isSensitive, updatedBy } = {}) {
  if (!key) throw new Error('key is required');
  const now = nowIso();
  db.run(
    `INSERT INTO system_settings (key, value, description, category, is_sensitive, updated_at, updated_by)
     VALUES (@key, @value, @description, @category, @isSensitive, @now, @updatedBy)
     ON CONFLICT(key) DO UPDATE SET
       value = @value,
       description = COALESCE(@description, description),
       category = COALESCE(@category, category),
       is_sensitive = COALESCE(@isSensitive, is_sensitive),
       updated_at = @now,
       updated_by = @updatedBy`,
    {
      key,
      value: asString(value, 5000),
      description: description || null,
      category: category || 'general',
      isSensitive: isSensitive ? 1 : 0,
      now,
      updatedBy: updatedBy || null,
    }
  );
  log.info('Setting updated', { key, category: category || 'general' });
  return getWithMeta(key);
}

function remove(key) {
  const r = db.run(`DELETE FROM system_settings WHERE key = @key`, { key });
  return r.changes > 0;
}

function listCategories() {
  return db.all(`SELECT DISTINCT category FROM system_settings ORDER BY category`).map((r) => r.category);
}

/**
 * Get multiple settings at once.
 */
function getMany(keys) {
  if (!Array.isArray(keys) || !keys.length) return {};
  const placeholders = keys.map(() => '?').join(',');
  const rows = db.all(`SELECT key, value FROM system_settings WHERE key IN (${placeholders})`, ...keys);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/**
 * Get a boolean setting (parses 'true'/'false'/'1'/'0').
 */
function getBool(key, dflt = false) {
  const v = get(key);
  if (v == null) return dflt;
  return String(v).toLowerCase() === 'true' || v === '1';
}

/**
 * Get a numeric setting.
 */
function getNumber(key, dflt = 0) {
  const v = get(key);
  if (v == null) return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

module.exports = {
  list, get, getWithMeta, set, remove, listCategories, getMany, getBool, getNumber,
};
