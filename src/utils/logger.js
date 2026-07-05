'use strict';

/**
 * Lightweight logger with timestamps, levels, and optional file output.
 * Avoids extra dependencies. Respects LOG_LEVEL.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const CURRENT = LEVELS[config.log.level] ?? LEVELS.info;

const LOG_DIR = path.resolve(config.paths.root, 'logs');
if (!fs.existsSync(LOG_DIR)) {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }
}
const LOG_FILE = path.join(LOG_DIR, 'app.log');
const ERROR_FILE = path.join(LOG_DIR, 'error.log');

function fmt(ts) {
  return new Date(ts).toISOString();
}

function write(line, level) {
  // stdout for human-readable dev output
  process.stdout.write(line + '\n');
  // append to rolling file (best-effort)
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
    if (level === 'error') fs.appendFileSync(ERROR_FILE, line + '\n');
  } catch { /* ignore disk errors */ }
}

function emit(level, msg, meta) {
  if (LEVELS[level] < CURRENT) return;
  const line = `[${fmt(Date.now())}] [${level.toUpperCase()}] ${msg}` +
    (meta ? ' ' + safeStringify(meta) : '');
  write(line, level);
}

function safeStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

module.exports = {
  debug: (m, x) => emit('debug', m, x),
  info: (m, x) => emit('info', m, x),
  warn: (m, x) => emit('warn', m, x),
  error: (m, x) => emit('error', m, x),
  child: (scope) => ({
    debug: (m, x) => emit('debug', `[${scope}] ${m}`, x),
    info: (m, x) => emit('info', `[${scope}] ${m}`, x),
    warn: (m, x) => emit('warn', `[${scope}] ${m}`, x),
    error: (m, x) => emit('error', `[${scope}] ${m}`, x),
  }),
};
