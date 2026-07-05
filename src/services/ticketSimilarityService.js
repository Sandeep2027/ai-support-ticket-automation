'use strict';

/**
 * Ticket Similarity Service — find similar past tickets using FTS5 + scoring.
 *
 * Used by agents to surface "customers with similar issues" and past resolution
 * paths. Also used to suggest duplicates for merge.
 *
 * Algorithm:
 *   1. Extract keywords from the query ticket's subject + body + summary
 *   2. Run FTS5 search against tickets_fts
 *   3. Score each candidate: FTS rank (BM25) + category match + priority match
 *   4. Filter out the query ticket itself and any tickets in the same thread
 *   5. Return top N with similarity scores
 */

const db = require('../database/db');
const logger = require('../utils/logger').child('similarity');
const log = logger;

/**
 * Find similar tickets to a given ticket.
 * @param {string} ticketId  the query ticket
 * @param {object} [opts]
 * @param {number} [opts.limit=5]  max results
 * @param {boolean} [opts.includeResolved=true]  include resolved tickets in results
 * @param {number} [opts.minScore=1]  minimum similarity score (0-100)
 */
function findSimilar(ticketId, { limit = 5, includeResolved = true, minScore = 1 } = {}) {
  const ticket = db.get(`SELECT * FROM tickets WHERE id = @id`, { id: ticketId });
  if (!ticket) throw new Error('ticket not found');

  // Build search query from subject + summary + tags
  const searchText = [
    ticket.email_subject || '',
    ticket.issue_summary || '',
    (ticket.suggested_tags ? JSON.parse(ticket.suggested_tags || '[]').join(' ') : ''),
  ].join(' ').trim();

  if (!searchText || searchText.length < 3) return [];

  // FTS5 search
  const safeQuery = searchText
    .toLowerCase()
    .replace(/["']/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 10)
    .map((w) => `"${w}"`)
    .join(' ');

  if (!safeQuery) return [];

  let candidates;
  try {
    candidates = db.all(
      `SELECT t.*, bm25(tickets_fts) AS fts_rank
       FROM tickets_fts f
       JOIN tickets t ON t.id = f.id
       WHERE tickets_fts MATCH @q AND t.id != @ticketId
       ORDER BY fts_rank
       LIMIT 50`,
      { q: safeQuery, ticketId }
    );
  } catch (err) {
    log.warn('FTS query failed', { error: err.message, q: safeQuery });
    return [];
  }

  // Score and filter
  const scored = candidates
    .filter((c) => includeResolved || !['Resolved', 'Closed'].includes(c.status))
    .map((c) => {
      let score = 0;
      // FTS rank (lower BM25 = better; convert to positive score)
      const ftsScore = Math.max(0, 50 + c.fts_rank * 10); // BM25 is negative
      score += ftsScore;

      // Category match
      if (c.category === ticket.category) score += 20;

      // Priority match
      if (c.priority === ticket.priority) score += 10;

      // Same customer (strong signal)
      if (c.sender_email === ticket.sender_email) score += 15;

      // Same team
      if (c.assigned_team === ticket.assigned_team) score += 5;

      // Tag overlap
      try {
        const cTags = JSON.parse(c.suggested_tags || '[]');
        const tTags = JSON.parse(ticket.suggested_tags || '[]');
        const overlap = cTags.filter((t) => tTags.includes(t)).length;
        score += overlap * 5;
      } catch { /* ignore */ }

      // Recency boost (newer = more relevant)
      const ageDays = (Date.now() - new Date(c.received_at).getTime()) / 86400000;
      if (ageDays < 7) score += 5;
      else if (ageDays < 30) score += 2;

      return {
        id: c.id,
        subject: c.email_subject,
        category: c.category,
        priority: c.priority,
        status: c.status,
        sentiment: c.sentiment,
        sender_email: c.sender_email,
        assigned_team: c.assigned_team,
        received_at: c.received_at,
        issue_summary: c.issue_summary,
        suggested_tags: JSON.parse(c.suggested_tags || '[]'),
        similarity_score: Math.round(Math.max(0, Math.min(100, score))),
      };
    })
    .filter((s) => s.similarity_score >= minScore)
    .sort((a, b) => b.similarity_score - a.similarity_score)
    .slice(0, limit);

  return scored;
}

/**
 * Find potential duplicates of a ticket (high-similarity tickets from the same sender).
 */
function findPotentialDuplicates(ticketId, { limit = 3 } = {}) {
  const ticket = db.get(`SELECT * FROM tickets WHERE id = @id`, { id: ticketId });
  if (!ticket) throw new Error('ticket not found');

  const similar = findSimilar(ticketId, { limit: 20, includeResolved: false, minScore: 30 });
  return similar
    .filter((s) => s.sender_email === ticket.sender_email || s.similarity_score >= 70)
    .slice(0, limit);
}

/**
 * Find tickets by free-text search (used by API /api/tickets/search).
 */
function search(query, { limit = 50 } = {}) {
  const safe = String(query || '')
    .replace(/["']/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `"${w}"`)
    .join(' ');
  if (!safe) return [];

  try {
    return db.all(
      `SELECT t.* FROM tickets_fts f JOIN tickets t ON t.id = f.id
       WHERE tickets_fts MATCH @q
       ORDER BY bm25(tickets_fts)
       LIMIT @limit`,
      { q: safe, limit }
    );
  } catch (err) {
    log.warn('FTS search failed', { error: err.message, q: safe });
    return [];
  }
}

module.exports = { findSimilar, findPotentialDuplicates, search };
