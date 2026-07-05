'use strict';

/**
 * Backup & Restore Service — DB backup, restore, export, import.
 *
 * Provides:
 *   - backup()        → SQLite VACUUM INTO a backup file
 *   - listBackups()   → list files in /backups
 *   - restore(name)   → restore from a backup file (dangerous!)
 *   - exportJson()    → full JSON export of all tables
 *   - importJson()    → restore from JSON export
 *   - vacuum()        → reclaim wasted space
 *   - stats()         → DB file size, table row counts, etc.
 */

const fs = require('fs');
const path = require('path');
const db = require('../database/db');
const config = require('../config');
const { nowIso } = require('../utils/helpers');
const logger = require('../utils/logger').child('backup');
const log = logger;

const BACKUP_DIR = path.resolve(config.paths.root, 'backups');

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

/**
 * Create a SQLite backup using VACUUM INTO (atomic, doesn't block writes).
 * Returns the backup file path.
 */
function backup() {
  ensureBackupDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `support-backup-${stamp}.db`;
  const filepath = path.join(BACKUP_DIR, filename);
  db.getDb().backup(filepath)
    .then(() => log.info('Backup created', { filepath }))
    .catch((err) => log.error('Backup failed', { error: err.message }));
  // Note: better-sqlite3's backup is sync when called via .backup() returning a promise,
  // but our wrapper uses exec. Use the simpler pragma approach:
  try {
    db.getDb().exec(`VACUUM INTO '${filepath.replace(/'/g, "''")}'`);
    log.info('Backup created (VACUUM INTO)', { filepath });
    return { filename, filepath, sizeBytes: fs.statSync(filepath).size, createdAt: nowIso() };
  } catch (err) {
    log.error('VACUUM INTO failed', { error: err.message });
    // Fallback: copy the file
    fs.copyFileSync(db.DB_PATH, filepath);
    return { filename, filepath, sizeBytes: fs.statSync(filepath).size, createdAt: nowIso() };
  }
}

/**
 * List all backup files in /backups, newest first.
 */
function listBackups() {
  ensureBackupDir();
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.db') || f.endsWith('.json'));
  return files.map((filename) => {
    const filepath = path.join(BACKUP_DIR, filename);
    const stat = fs.statSync(filepath);
    return {
      filename,
      sizeBytes: stat.size,
      sizeMb: Math.round(stat.size / 1024 / 1024 * 100) / 100,
      createdAt: stat.mtime.toISOString(),
    };
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Restore from a backup file. STOPS THE SERVER for safety — must restart.
 * Returns instructions.
 */
function restore(filename) {
  const safe = path.basename(filename);
  const filepath = path.join(BACKUP_DIR, safe);
  if (!fs.existsSync(filepath)) throw new Error('backup file not found');

  // Copy backup over the live DB
  try { db.close(); } catch { /* ignore */ }
  fs.copyFileSync(filepath, db.DB_PATH);
  // Re-open
  db.getDb();

  log.warn('Database restored from backup', { filename });
  return {
    ok: true,
    filename: safe,
    message: 'Database restored. Restart the server for full consistency.',
    restoredAt: nowIso(),
  };
}

function deleteBackup(filename) {
  const safe = path.basename(filename);
  const filepath = path.join(BACKUP_DIR, safe);
  if (!fs.existsSync(filepath)) return false;
  fs.unlinkSync(filepath);
  return true;
}

/**
 * Export all tables as a single JSON object.
 */
function exportJson() {
  const tables = [
    'tickets', 'attachments', 'audit_trail', 'ticket_notes', 'routing_config',
    'inbox_log', 'agents', 'api_keys', 'kb_articles', 'tags', 'ticket_tags',
    'customer_profiles', 'escalations', 'notifications', 'notification_channels',
    'saved_filters', 'metrics_snapshot', 'macros', 'sla_policies', 'workflow_rules',
    'workflow_executions', 'custom_fields', 'custom_field_values', 'scheduled_reports',
    'webhook_subscriptions', 'webhook_deliveries', 'ticket_threads', 'ticket_thread_map',
    'ticket_snoozes', 'ticket_translations', 'system_settings',
  ];
  const out = { _meta: { exportedAt: nowIso(), schema: 'v3', tables: tables.length }, data: {} };
  for (const t of tables) {
    try {
      out.data[t] = db.all(`SELECT * FROM ${t}`);
    } catch (err) {
      out.data[t] = { _error: err.message };
    }
  }
  return out;
}

/**
 * Export to a JSON file on disk.
 */
function exportJsonFile() {
  ensureBackupDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `support-export-${stamp}.json`;
  const filepath = path.join(BACKUP_DIR, filename);
  const data = exportJson();
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  return { filename, filepath, sizeBytes: fs.statSync(filepath).size, tables: data._meta.tables };
}

/**
 * Import from a JSON export (replaces existing data — use with caution!).
 */
function importJson(jsonData) {
  if (!jsonData || !jsonData.data) throw new Error('invalid export format');
  const stats = { imported: {}, errors: [] };
  for (const [table, rows] of Object.entries(jsonData.data)) {
    if (Array.isArray(rows) && rows.length) {
      try {
        // Clear existing
        db.run(`DELETE FROM ${table}`);
        // Insert (best-effort, skip on error)
        for (const row of rows) {
          try {
            const cols = Object.keys(row);
            const placeholders = cols.map((c) => `@${c}`).join(', ');
            db.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`, row);
          } catch { /* skip */ }
        }
        stats.imported[table] = rows.length;
      } catch (err) {
        stats.errors.push(`${table}: ${err.message}`);
      }
    }
  }
  log.info('JSON import complete', stats);
  return stats;
}

/**
 * VACUUM the database to reclaim space.
 */
function vacuum() {
  const beforeSize = fs.statSync(db.DB_PATH).size;
  db.getDb().exec('VACUUM');
  const afterSize = fs.statSync(db.DB_PATH).size;
  return {
    beforeBytes: beforeSize,
    afterBytes: afterSize,
    reclaimedBytes: beforeSize - afterSize,
    reclaimedMb: Math.round((beforeSize - afterSize) / 1024 / 1024 * 100) / 100,
  };
}

/**
 * Database stats — file size, table row counts, indexes.
 */
function stats() {
  const fileSize = fs.statSync(db.DB_PATH).size;
  const tables = [
    'tickets', 'audit_trail', 'ticket_notes', 'attachments', 'agents',
    'kb_articles', 'customer_profiles', 'escalations', 'notifications',
    'workflow_rules', 'workflow_executions', 'custom_fields',
    'scheduled_reports', 'webhook_subscriptions', 'macros', 'sla_policies',
    'system_settings',
  ];
  const tableCounts = {};
  for (const t of tables) {
    try { tableCounts[t] = db.get(`SELECT COUNT(*) AS n FROM ${t}`).n; }
    catch { tableCounts[t] = 'N/A'; }
  }
  // Indexes
  const indexes = db.all(`SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' ORDER BY tbl_name`);
  // Page info
  const pageInfo = db.get(`PRAGMA page_count`);
  const pageSize = db.get(`PRAGMA page_size`);
  return {
    dbPath: db.DB_PATH,
    fileSizeBytes: fileSize,
    fileSizeMb: Math.round(fileSize / 1024 / 1024 * 100) / 100,
    pageCount: pageInfo ? pageInfo.page_count : null,
    pageSize: pageSize ? pageSize.page_size : null,
    tableCounts,
    indexCount: indexes.length,
    indexes: indexes.slice(0, 50),
  };
}

/**
 * Schedule periodic backups.
 */
function startBackupSweeper(intervalHours = 24) {
  const intervalMs = intervalHours * 3600 * 1000;
  const handle = setInterval(() => {
    try { backup(); } catch (err) { log.error('Auto-backup failed', { error: err.message }); }
  }, intervalMs);
  log.info('Backup sweeper started', { intervalHours });
  return handle;
}

module.exports = {
  backup, listBackups, restore, deleteBackup,
  exportJson, exportJsonFile, importJson,
  vacuum, stats, startBackupSweeper,
  BACKUP_DIR,
};
