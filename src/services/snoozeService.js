'use strict';

/**
 * Snooze Service — temporarily remove a ticket from the active queue.
 *
 * A snoozed ticket's status is preserved but it's hidden from default views
 * until the snooze expires. When the snooze wakes, the ticket reappears and
 * an audit event is recorded.
 *
 * Use cases:
 *   - "Waiting for customer to reply" (snooze 3 days)
 *   - "Bug fix in next release" (snooze 2 weeks)
 *   - "Customer on vacation" (snooze 1 week)
 */

const db = require('../database/db');
const { nowIso } = require('../utils/helpers');
const { asString } = require('../utils/validator');
const auditService = require('./auditService');
const logger = require('../utils/logger').child('snooze');
const log = logger;

/**
 * Snooze a ticket until a future time.
 * @param {string} ticketId
 * @param {string} snoozedUntil  ISO 8601 timestamp
 * @param {string} reason
 * @param {string} actor  agent:<id> | system
 */
function snooze(ticketId, snoozedUntil, reason = '', actor = 'system') {
  const ticket = db.get(`SELECT id, status FROM tickets WHERE id = @id`, { id: ticketId });
  if (!ticket) throw new Error('ticket not found');
  if (['Resolved', 'Closed', 'Rejected', 'Spam'].includes(ticket.status)) {
    throw new Error(`cannot snooze a ${ticket.status} ticket`);
  }

  const until = new Date(snoozedUntil);
  if (Number.isNaN(until.getTime())) throw new Error('invalid snoozedUntil date');
  if (until <= new Date()) throw new Error('snoozedUntil must be in the future');

  const now = nowIso();
  db.run(
    `INSERT INTO ticket_snoozes (ticket_id, snoozed_until, reason, snoozed_by, created_at)
     VALUES (@ticketId, @until, @reason, @actor, @now)`,
    { ticketId, until: until.toISOString(), reason: asString(reason, 500), actor, now }
  );

  // Mark the ticket as waiting for customer (visual hint)
  if (ticket.status === 'Open' || ticket.status === 'In Progress') {
    db.run(`UPDATE tickets SET status = 'Waiting for Customer', last_updated = @now, updated_at = @now WHERE id = @id`,
      { now, id: ticketId });
  }

  auditService.record({
    ticketId, action: 'snoozed', actor,
    newValue: until.toISOString(),
    metadata: { reason, snoozedUntil: until.toISOString() },
  });

  log.info('Ticket snoozed', { ticketId, until: until.toISOString(), reason });
  return { ticketId, snoozedUntil: until.toISOString(), reason, snoozedBy: actor };
}

/**
 * Wake a snoozed ticket early (manually).
 */
function wake(ticketId, actor = 'system') {
  const active = db.get(
    `SELECT * FROM ticket_snoozes WHERE ticket_id = @ticketId AND woke_at IS NULL ORDER BY id DESC LIMIT 1`,
    { ticketId }
  );
  if (!active) throw new Error('no active snooze on this ticket');

  db.run(`UPDATE ticket_snoozes SET woke_at = @now WHERE id = @id`, { now: nowIso(), id: active.id });

  // Restore status to Open
  db.run(`UPDATE tickets SET status = 'Open', last_updated = @now, updated_at = @now WHERE id = @id`,
    { now: nowIso(), id: ticketId });

  auditService.record({ ticketId, action: 'woke', actor });
  log.info('Ticket woke', { ticketId });
  return { ticketId, wokeAt: nowIso() };
}

/**
 * Get the active snooze for a ticket (if any).
 */
function getActive(ticketId) {
  return db.get(
    `SELECT * FROM ticket_snoozes WHERE ticket_id = @ticketId AND woke_at IS NULL ORDER BY id DESC LIMIT 1`,
    { ticketId }
  );
}

/**
 * Get snooze history for a ticket.
 */
function historyForTicket(ticketId) {
  return db.all(
    `SELECT * FROM ticket_snoozes WHERE ticket_id = @ticketId ORDER BY id DESC`,
    { ticketId }
  );
}

/**
 * Sweep — find snoozes that have expired and wake them.
 * Called by the background sweeper.
 */
function sweep() {
  const now = nowIso();
  const expired = db.all(
    `SELECT * FROM ticket_snoozes WHERE woke_at IS NULL AND snoozed_until <= @now`,
    { now }
  );
  if (!expired.length) return { swept: 0 };

  let swept = 0;
  for (const s of expired) {
    db.run(`UPDATE ticket_snoozes SET woke_at = @now WHERE id = @id`, { now, id: s.id });
    db.run(`UPDATE tickets SET status = 'Open', last_updated = @now, updated_at = @now WHERE id = @id AND status = 'Waiting for Customer'`,
      { now, id: s.ticket_id });
    auditService.record({
      ticketId: s.ticket_id, action: 'woke', actor: 'system:snooze-sweeper',
      metadata: { reason: 'snooze expired', snoozedUntil: s.snoozed_until },
    });
    swept++;
  }
  if (swept) log.info('Snooze sweep', { swept });
  return { swept };
}

function startSweeper() {
  const handle = setInterval(() => {
    try { sweep(); } catch (err) { log.error('Snooze sweep failed', { error: err.message }); }
  }, 60 * 1000);
  log.info('Snooze sweeper started (60s interval)');
  return handle;
}

module.exports = { snooze, wake, getActive, historyForTicket, sweep, startSweeper };
