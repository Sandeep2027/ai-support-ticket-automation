'use strict';

/**
 * SQLite database layer.
 *
 * Uses better-sqlite3 (synchronous, fast, zero-config) so the rest of the
 * codebase can stay simple. The schema is loaded from schema.sql on boot.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const config = require('../config');

const DB_PATH = path.resolve(process.cwd(), config.db.path);
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let dbInstance = null;

/**
 * Open (or reuse) the SQLite connection and apply the schema idempotently.
 * @returns {import('better-sqlite3').Database}
 */
function getDb() {
  if (dbInstance) return dbInstance;

  // Ensure the parent directory exists
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  dbInstance = new Database(DB_PATH);
  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('foreign_keys = ON');

  // Apply schema (CREATE IF NOT EXISTS — safe to re-run)
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  dbInstance.exec(schema);

  return dbInstance;
}

/**
 * Run a parameterised query and return all rows.
 */
function all(sql, params = {}) {
  return getDb().prepare(sql).all(params);
}

/**
 * Run a parameterised query and return the first row (or undefined).
 */
function get(sql, params = {}) {
  return getDb().prepare(sql).get(params);
}

/**
 * Run a parameterised write (INSERT/UPDATE/DELETE). Returns the RunResult
 * (with `lastInsertRowid` / `changes`).
 */
function run(sql, params = {}) {
  return getDb().prepare(sql).run(params);
}

/**
 * Execute a function inside a transaction. If it throws, the transaction
 * is rolled back. better-sqlite3 transactions are synchronous.
 */
function transaction(fn) {
  return getDb().transaction(fn)();
}

/**
 * Close the connection (mainly for tests / graceful shutdown).
 */
function close() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

module.exports = { getDb, all, get, run, transaction, close, DB_PATH };
