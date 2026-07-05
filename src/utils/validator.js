'use strict';

/**
 * Validation helpers for AI output and inbound email data.
 * Pure functions, fully unit-testable.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Loose E.164 / international + local phone format
const PHONE_RE = /^[+]?[\d\s().-]{7,20}$/;

const ALLOWED_CATEGORIES = [
  'Technical Support',
  'Billing',
  'Sales Inquiry',
  'Feature Request',
  'Bug Report',
  'Account Access',
  'Refund Request',
  'General Inquiry',
];

const ALLOWED_PRIORITIES = ['Critical', 'High', 'Medium', 'Low'];
const ALLOWED_SENTIMENTS = ['Positive', 'Neutral', 'Negative'];
const ALLOWED_STATUSES = [
  'Open',
  'In Progress',
  'Waiting for Customer',
  'Resolved',
  'Closed',
  'Rejected',
];

/**
 * Safely parse JSON. Returns { ok, data, error }.
 */
function safeJsonParse(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'input not a string', data: null };
  // Some LLMs wrap JSON in ```json fences; strip them.
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    return { ok: true, data: JSON.parse(s), error: null };
  } catch (e) {
    return { ok: false, error: e.message, data: null };
  }
}

function isString(v) { return typeof v === 'string'; }
function asString(v, max = 2000) {
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

function asArray(v, max = 50) {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => asString(x, 80))
    .filter(Boolean)
    .filter((x, i, a) => a.indexOf(x) === i) // de-dupe
    .slice(0, max);
}

function asNumber(v, dflt = 0, min = 0, max = 100) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}

function asCategory(v) {
  const s = asString(v);
  if (!s) return 'General Inquiry';
  // Fuzzy match against the allowed list (case-insensitive, hyphen/slash tolerant)
  const norm = s.toLowerCase().replace(/[-_/]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const c of ALLOWED_CATEGORIES) {
    if (c.toLowerCase() === norm) return c;
  }
  // Partial contains
  for (const c of ALLOWED_CATEGORIES) {
    if (norm.includes(c.toLowerCase()) || c.toLowerCase().includes(norm)) return c;
  }
  return 'General Inquiry';
}

function asPriority(v) {
  const s = asString(v).toLowerCase();
  if (!s) return 'Medium';
  if (s.includes('crit') || s.includes('urgent') || s.includes('p1')) return 'Critical';
  if (s.includes('high') || s.includes('p2')) return 'High';
  if (s.includes('low') || s.includes('p4')) return 'Low';
  if (s.includes('med') || s.includes('p3')) return 'Medium';
  return 'Medium';
}

function asSentiment(v) {
  const s = asString(v).toLowerCase();
  if (!s) return 'Neutral';
  if (s.includes('pos')) return 'Positive';
  if (s.includes('neg')) return 'Negative';
  return 'Neutral';
}

function asStatus(v) {
  const s = asString(v);
  return ALLOWED_STATUSES.includes(s) ? s : 'Open';
}

function isValidEmail(v) {
  return isString(v) && EMAIL_RE.test(v.trim());
}

function normalizeEmail(v) {
  return asString(v).toLowerCase();
}

function isValidPhone(v) {
  if (!v) return true; // phone is optional
  return PHONE_RE.test(String(v).trim());
}

module.exports = {
  ALLOWED_CATEGORIES,
  ALLOWED_PRIORITIES,
  ALLOWED_SENTIMENTS,
  ALLOWED_STATUSES,
  safeJsonParse,
  asString,
  asArray,
  asNumber,
  asCategory,
  asPriority,
  asSentiment,
  asStatus,
  isValidEmail,
  normalizeEmail,
  isValidPhone,
};
