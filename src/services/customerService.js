'use strict';

/**
 * Customer service — 360-degree view of a customer across all their tickets.
 * Builds/updates a `customer_profiles` row whenever a ticket is created.
 */

const db = require('../database/db');
const crypto = require('crypto');
const { nowIso, fingerprint } = require('../utils/helpers');
const { normalizeEmail } = require('../utils/validator');

function customerIdFor(email) {
  return 'cus_' + crypto.createHash('sha1').update(normalizeEmail(email)).digest('hex').slice(0, 16);
}

/**
 * Upsert a customer profile based on an inbound email.
 * Updates ticket counts and last contact timestamp.
 */
function upsertFromEmail({ senderEmail, senderName, company }) {
  if (!senderEmail) return null;
  const id = customerIdFor(senderEmail);
  const email = normalizeEmail(senderEmail);
  const now = nowIso();

  const existing = db.get(`SELECT * FROM customer_profiles WHERE id = @id`, { id });
  if (existing) {
    db.run(
      `UPDATE customer_profiles
       SET name = COALESCE(@name, name),
           company = COALESCE(@company, company),
           total_tickets = total_tickets + 1,
           open_tickets = open_tickets + 1,
           last_contact_at = @now,
           updated_at = @now
       WHERE id = @id`,
      { id, name: senderName || null, company: company || null, now }
    );
  } else {
    db.run(
      `INSERT INTO customer_profiles (id, email, name, company, total_tickets, open_tickets, last_contact_at, created_at, updated_at)
       VALUES (@id, @email, @name, @company, 1, 1, @now, @now, @now)`,
      { id, email, name: senderName || null, company: company || null, now }
    );
  }
  return get(id);
}

/**
 * Decrease open ticket count when a ticket is resolved/closed/rejected.
 */
function decrementOpen(customerId) {
  if (!customerId) return;
  db.run(`UPDATE customer_profiles SET open_tickets = MAX(0, open_tickets - 1), updated_at = @now WHERE id = @id`,
    { id: customerId, now: nowIso() });
}

function get(id) {
  const row = db.get(`SELECT * FROM customer_profiles WHERE id = @id`, { id });
  return row ? rowToProfile(row) : null;
}

function getByEmail(email) {
  const row = db.get(`SELECT * FROM customer_profiles WHERE email = @email`, { email: normalizeEmail(email) });
  return row ? rowToProfile(row) : null;
}

function list({ q, isVip, limit = 50, offset = 0 } = {}) {
  const where = [];
  const params = { limit, offset };
  if (q) { where.push('(email LIKE @q OR name LIKE @q OR company LIKE @q)'); params.q = `%${q}%`; }
  if (isVip !== undefined) { where.push('is_vip = @vip'); params.vip = isVip ? 1 : 0; }
  const sql = `SELECT * FROM customer_profiles ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY last_contact_at DESC LIMIT @limit OFFSET @offset`;
  return db.all(sql, params).map(rowToProfile);
}

/**
 * Get the full 360 view: profile + all tickets + audit summary + sentiment trend.
 */
function get360(email) {
  const profile = getByEmail(email);
  if (!profile) return null;
  const tickets = db.all(`SELECT * FROM tickets WHERE customer_id = @id OR sender_email = @email ORDER BY received_at DESC`, { id: profile.id, email: normalizeEmail(email) });

  // Sentiment trend
  const sentiments = tickets.map((t) => t.sentiment).filter(Boolean);
  const sentimentTrend = sentiments.slice().reverse(); // oldest first

  // Stats
  const stats = {
    total: tickets.length,
    open: tickets.filter((t) => !['Resolved', 'Closed', 'Rejected', 'Spam'].includes(t.status)).length,
    resolved: tickets.filter((t) => t.status === 'Resolved').length,
    avgConfidence: tickets.length ? Math.round(tickets.reduce((s, t) => s + (t.confidence_score || 0), 0) / tickets.length) : 0,
    categories: Object.fromEntries(
      Object.entries(
        tickets.reduce((acc, t) => { acc[t.category] = (acc[t.category] || 0) + 1; return acc; }, {})
      ).sort((a, b) => b[1] - a[1])
    ),
  };

  return { profile, tickets, stats, sentimentTrend };
}

function markVip(id, isVip = true) {
  db.run(`UPDATE customer_profiles SET is_vip = @vip, updated_at = @now WHERE id = @id`, { id, vip: isVip ? 1 : 0, now: nowIso() });
  return get(id);
}

function updateNotes(id, notes) {
  db.run(`UPDATE customer_profiles SET notes = @notes, updated_at = @now WHERE id = @id`, { id, notes, now: nowIso() });
  return get(id);
}

function rowToProfile(row) {
  if (!row) return null;
  return {
    ...row,
    is_vip: !!row.is_vip,
  };
}

module.exports = {
  customerIdFor,
  upsertFromEmail,
  decrementOpen,
  get,
  getByEmail,
  list,
  get360,
  markVip,
  updateNotes,
};
