'use strict';

/**
 * General-purpose helpers: ID generation, dates, debouncing, retries.
 */

const { v4: uuidv4 } = require('uuid');
const config = require('../config');

/** Short, human-friendly, sortable ticket ID, e.g. TKT-20260705-A1B2 */
function generateTicketId(date = new Date()) {
  const ymd =
    date.getUTCFullYear().toString() +
    String(date.getUTCMonth() + 1).padStart(2, '0') +
    String(date.getUTCDate()).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `TKT-${ymd}-${rand}`;
}

function generateId(prefix = '') {
  return prefix ? `${prefix}-${uuidv4()}` : uuidv4();
}

function nowIso() {
  return new Date().toISOString();
}

/** Compute the SLA due timestamp (ISO string) for a given priority. */
function computeSlaDue(priority, startDate = new Date()) {
  const hours = config.sla[priority] ?? config.sla.Medium;
  return new Date(startDate.getTime() + hours * 3600 * 1000).toISOString();
}

/** Sleep for ms. */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Retry an async function with exponential backoff.
 * @param {() => Promise<T>} fn
 * @param {object} opts
 */
async function withRetry(fn, opts = {}) {
  const { retries = 3, baseDelay = 500, factor = 2, jitter = 200 } = opts;
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      const delay = baseDelay * Math.pow(factor, attempt - 1) + Math.random() * jitter;
      await sleep(delay);
    }
  }
  throw lastErr;
}

/** Truncate text to n chars with an ellipsis. */
function truncate(s, n = 280) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Strip HTML tags from a string (best-effort). */
function stripHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** SHA-256-ish hash for duplicate detection (non-crypto, fast). */
function fingerprint(s) {
  if (!s) return '';
  const norm = String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  let h1 = 0xdeadbeef ^ norm.length;
  let h2 = 0x41c6ce57 ^ norm.length;
  for (let i = 0; i < norm.length; i++) {
    const ch = norm.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

module.exports = {
  generateTicketId,
  generateId,
  nowIso,
  computeSlaDue,
  sleep,
  withRetry,
  truncate,
  stripHtml,
  fingerprint,
};
