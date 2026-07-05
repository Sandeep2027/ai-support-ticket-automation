'use strict';

/**
 * Ticket Threading Service — group related tickets into conversation threads.
 *
 * A thread links multiple tickets from the same customer about the same
 * issue. This is useful for:
 *   - Following up on a long-running issue
 *   - Showing the full conversation history to agents
 *   - Aggregating stats per thread
 *
 * Threading is automatic when:
 *   - Same customer + same category + within 7 days of the last ticket in the thread
 *
 * Agents can also manually link/unlink tickets to threads.
 */

const db = require('../database/db');
const { generateId, nowIso } = require('../utils/helpers');
const { asString } = require('../utils/validator');
const auditService = require('./auditService');
const logger = require('../utils/logger').child('threading');
const log = logger;

const AUTO_THREAD_WINDOW_DAYS = 7;

/**
 * Find or create a thread for a new ticket.
 * Called by ticketService on ticket creation.
 */
function findOrCreateThreadForTicket(ticket) {
  if (!ticket.sender_email && !ticket.customer_id) return null;

  // Find recent thread for this customer
  const since = new Date(Date.now() - AUTO_THREAD_WINDOW_DAYS * 86400 * 1000).toISOString();
  const customerId = ticket.customer_id || `email:${ticket.sender_email}`;

  const recentThread = db.get(
    `SELECT t.id, t.subject, t.updated_at, ttm.ticket_id AS last_ticket_id
     FROM ticket_threads t
     JOIN ticket_thread_map ttm ON ttm.thread_id = t.id
     WHERE (t.customer_id = @cid OR ttm.ticket_id IN (
       SELECT id FROM tickets WHERE sender_email = @email
     ))
     AND t.updated_at >= @since
     ORDER BY t.updated_at DESC LIMIT 1`,
    { cid: customerId, email: ticket.sender_email, since }
  );

  let threadId;
  if (recentThread) {
    threadId = recentThread.id;
  } else {
    // Create new thread
    threadId = generateId('thr');
    const now = nowIso();
    db.run(
      `INSERT INTO ticket_threads (id, subject, customer_id, created_at, updated_at)
       VALUES (@id, @subject, @cid, @now, @now)`,
      { id: threadId, subject: ticket.email_subject || '(no subject)', cid: customerId, now }
    );
    log.info('Thread created', { threadId, subject: ticket.email_subject });
  }

  // Get next position
  const maxPos = db.get(`SELECT MAX(position) AS p FROM ticket_thread_map WHERE thread_id = @tid`, { tid: threadId });
  const position = (maxPos && maxPos.p != null) ? maxPos.p + 1 : 0;

  db.run(
    `INSERT OR REPLACE INTO ticket_thread_map (ticket_id, thread_id, position) VALUES (@ticketId, @threadId, @position)`,
    { ticketId: ticket.id, threadId, position }
  );

  // Update thread's updated_at
  db.run(`UPDATE ticket_threads SET updated_at = @now WHERE id = @id`, { now: nowIso(), id: threadId });

  return threadId;
}

/**
 * Get the thread for a ticket (if any).
 */
function getThreadForTicket(ticketId) {
  const mapping = db.get(`SELECT thread_id FROM ticket_thread_map WHERE ticket_id = @ticketId`, { ticketId });
  if (!mapping) return null;
  return getThread(mapping.thread_id);
}

/**
 * Get a thread by ID, including all its tickets.
 */
function getThread(threadId) {
  const thread = db.get(`SELECT * FROM ticket_threads WHERE id = @id`, { id: threadId });
  if (!thread) return null;

  const tickets = db.all(
    `SELECT t.* FROM tickets t
     JOIN ticket_thread_map ttm ON ttm.ticket_id = t.id
     WHERE ttm.thread_id = @threadId
     ORDER BY ttm.position ASC`,
    { threadId }
  );

  return {
    ...thread,
    tickets,
    ticketCount: tickets.length,
  };
}

/**
 * Manually link a ticket to a thread.
 */
function linkTicketToThread(ticketId, threadId, actor = 'system') {
  const ticket = db.get(`SELECT id FROM tickets WHERE id = @id`, { id: ticketId });
  if (!ticket) throw new Error('ticket not found');
  const thread = db.get(`SELECT id FROM ticket_threads WHERE id = @id`, { id: threadId });
  if (!thread) throw new Error('thread not found');

  const maxPos = db.get(`SELECT MAX(position) AS p FROM ticket_thread_map WHERE thread_id = @tid`, { tid: threadId });
  const position = (maxPos && maxPos.p != null) ? maxPos.p + 1 : 0;

  db.run(
    `INSERT OR REPLACE INTO ticket_thread_map (ticket_id, thread_id, position) VALUES (@ticketId, @threadId, @position)`,
    { ticketId, threadId, position }
  );

  auditService.record({
    ticketId, action: 'edited', field: 'thread', newValue: threadId, actor,
    metadata: { threadId, position },
  });
  return { ticketId, threadId, position };
}

/**
 * Unlink a ticket from its thread.
 */
function unlinkTicket(ticketId, actor = 'system') {
  const mapping = db.get(`SELECT * FROM ticket_thread_map WHERE ticket_id = @ticketId`, { ticketId });
  if (!mapping) return { ok: false, reason: 'not in a thread' };

  db.run(`DELETE FROM ticket_thread_map WHERE ticket_id = @ticketId`, { ticketId });
  auditService.record({
    ticketId, action: 'edited', field: 'thread', oldValue: mapping.thread_id, actor,
    metadata: { unlinked: true },
  });
  return { ok: true, ticketId, unlinkedFrom: mapping.thread_id };
}

/**
 * List all threads (with pagination).
 */
function listThreads({ limit = 50, offset = 0 } = {}) {
  return db.all(
    `SELECT t.*, COUNT(ttm.ticket_id) AS ticket_count
     FROM ticket_threads t
     LEFT JOIN ticket_thread_map ttm ON ttm.thread_id = t.id
     GROUP BY t.id
     ORDER BY t.updated_at DESC
     LIMIT @limit OFFSET @offset`,
    { limit, offset }
  );
}

/**
 * Merge two threads (move all tickets from source to target).
 */
function mergeThreads(sourceThreadId, targetThreadId, actor = 'system') {
  if (sourceThreadId === targetThreadId) throw new Error('cannot merge a thread into itself');

  const source = db.get(`SELECT * FROM ticket_threads WHERE id = @id`, { id: sourceThreadId });
  const target = db.get(`SELECT * FROM ticket_threads WHERE id = @id`, { id: targetThreadId });
  if (!source) throw new Error('source thread not found');
  if (!target) throw new Error('target thread not found');

  // Get max position in target
  const maxPos = db.get(`SELECT MAX(position) AS p FROM ticket_thread_map WHERE thread_id = @tid`, { tid: targetThreadId });
  let nextPos = (maxPos && maxPos.p != null) ? maxPos.p + 1 : 0;

  // Move all tickets
  const sourceTickets = db.all(`SELECT ticket_id FROM ticket_thread_map WHERE thread_id = @tid ORDER BY position ASC`, { tid: sourceThreadId });
  for (const st of sourceTickets) {
    db.run(
      `UPDATE ticket_thread_map SET thread_id = @targetId, position = @pos WHERE ticket_id = @ticketId`,
      { targetId: targetThreadId, pos: nextPos++, ticketId: st.ticket_id }
    );
    auditService.record({
      ticketId: st.ticket_id, action: 'edited', field: 'thread',
      oldValue: sourceThreadId, newValue: targetThreadId, actor,
      metadata: { merged: true },
    });
  }

  // Delete the source thread
  db.run(`DELETE FROM ticket_threads WHERE id = @id`, { id: sourceThreadId });
  db.run(`UPDATE ticket_threads SET updated_at = @now WHERE id = @id`, { now: nowIso(), id: targetThreadId });

  log.info('Threads merged', { source: sourceThreadId, target: targetThreadId, ticketsMoved: sourceTickets.length });
  return { merged: sourceTickets.length, sourceThreadId, targetThreadId };
}

module.exports = {
  AUTO_THREAD_WINDOW_DAYS,
  findOrCreateThreadForTicket,
  getThreadForTicket, getThread,
  linkTicketToThread, unlinkTicket,
  listThreads, mergeThreads,
};
