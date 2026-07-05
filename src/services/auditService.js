'use strict';

/**
 * Audit trail — every meaningful action on a ticket is recorded immutably.
 * The audit_trail table is append-only; this service is the only writer.
 */

const db = require('../database/db');
const { nowIso } = require('../utils/helpers');

/**
 * Append an audit entry.
 * @param {object} args
 * @param {string} args.ticketId
 * @param {string} args.action     created | classified | assigned | acknowledged | status_changed | priority_changed | category_changed | note_added | edited | duplicated
 * @param {string} [args.field]    which field changed
 * @param {string} [args.oldValue]
 * @param {string} [args.newValue]
 * @param {string} [args.actor]    system | ai | agent:<name>
 * @param {object} [args.metadata] JSON-serialisable
 */
function record({ ticketId, action, field, oldValue, newValue, actor = 'system', metadata }) {
  if (!ticketId || !action) return;
  db.run(
    `INSERT INTO audit_trail (ticket_id, action, field, old_value, new_value, actor, metadata, created_at)
     VALUES (@ticketId, @action, @field, @oldValue, @newValue, @actor, @metadata, @createdAt)`,
    {
      ticketId,
      action,
      field: field || null,
      oldValue: oldValue == null ? null : String(oldValue),
      newValue: newValue == null ? null : String(newValue),
      actor,
      metadata: metadata ? JSON.stringify(metadata) : null,
      createdAt: nowIso(),
    }
  );
}

function listForTicket(ticketId) {
  return db.all(
    `SELECT * FROM audit_trail WHERE ticket_id = @ticketId ORDER BY id ASC`,
    { ticketId }
  );
}

module.exports = { record, listForTicket };
