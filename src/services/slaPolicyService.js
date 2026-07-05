'use strict';

/**
 * SLA Policy Service — per-customer / per-category SLA overrides with
 * business-hours awareness.
 *
 * Default SLAs come from config (SLA_CRITICAL=2h, etc.). This service layers
 * overrides on top: a VIP customer can have a 1h Critical SLA, or a Sales
 * Inquiry can have a 4h Medium SLA regardless of customer.
 *
 * Business hours: when `business_hours_only=1`, the SLA clock only ticks
 * during business hours (configurable per-policy, defaults to Mon-Fri 09:00-17:00
 * in the policy's timezone). Outside business hours, the clock pauses.
 */

const db = require('../database/db');
const config = require('../config');
const { generateId, nowIso } = require('../utils/helpers');
const { asString } = require('../utils/validator');
const logger = require('../utils/logger').child('sla-policy');
const log = logger;

// Default business hours: Mon-Fri 09:00-17:00
const DEFAULT_BUSINESS_HOURS = {
  startHour: 9, endHour: 17,
  workDays: [1, 2, 3, 4, 5], // Mon-Fri (0=Sun)
};

// ---------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------

function list({ isActive = true, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = { limit, offset };
  if (isActive !== undefined) { where.push('is_active = @ia'); params.ia = isActive ? 1 : 0; }
  const sql = `SELECT * FROM sla_policies ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY priority, category, customer_id LIMIT @limit OFFSET @offset`;
  return db.all(sql, params).map(rowToPolicy);
}

function get(id) {
  const row = db.get(`SELECT * FROM sla_policies WHERE id = @id`, { id });
  return row ? rowToPolicy(row) : null;
}

function create({ name, priority, category, customerId, isVipOnly, responseHours, resolutionHours, businessHoursOnly, timezone }) {
  if (!name) throw new Error('name is required');
  const id = generateId('sla');
  const now = nowIso();
  const row = {
    id, name: asString(name, 100),
    priority: asString(priority, 20) || null,
    category: asString(category, 80) || null,
    customer_id: customerId || null,
    is_vip_only: isVipOnly ? 1 : 0,
    response_hours: responseHours != null ? Number(responseHours) : null,
    resolution_hours: resolutionHours != null ? Number(resolutionHours) : null,
    business_hours_only: businessHoursOnly ? 1 : 0,
    timezone: asString(timezone, 50) || 'UTC',
    is_active: 1,
    created_at: now, updated_at: now,
  };
  db.run(
    `INSERT INTO sla_policies (id, name, priority, category, customer_id, is_vip_only, response_hours, resolution_hours, business_hours_only, timezone, is_active, created_at, updated_at)
     VALUES (@id, @name, @priority, @category, @customer_id, @is_vip_only, @response_hours, @resolution_hours, @business_hours_only, @timezone, @is_active, @created_at, @updated_at)`,
    row
  );
  log.info('SLA policy created', { id, name });
  return get(id);
}

function update(id, patch) {
  const existing = get(id);
  if (!existing) return null;
  const allowed = ['name', 'priority', 'category', 'customer_id', 'is_vip_only', 'response_hours', 'resolution_hours', 'business_hours_only', 'timezone', 'is_active'];
  const setClauses = [];
  const params = { id, updatedAt: nowIso() };
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    let v = patch[k];
    if (k === 'is_vip_only' || k === 'business_hours_only' || k === 'is_active') v = v ? 1 : 0;
    else if (k === 'response_hours' || k === 'resolution_hours') v = v != null ? Number(v) : null;
    else v = asString(v, 100) || null;
    setClauses.push(`${k} = @${k}`);
    params[k] = v;
  }
  if (setClauses.length === 0) return existing;
  setClauses.push('updated_at = @updatedAt');
  db.run(`UPDATE sla_policies SET ${setClauses.join(', ')} WHERE id = @id`, params);
  return get(id);
}

function remove(id) {
  const r = db.run(`DELETE FROM sla_policies WHERE id = @id`, { id });
  return r.changes > 0;
}

// ---------------------------------------------------------------
// SLA computation
// ---------------------------------------------------------------

/**
 * Find the best-matching SLA policy for a ticket.
 * Order of precedence:
 *   1. Customer-specific policy (highest priority)
 *   2. VIP-only policy (if customer is VIP)
 *   3. Category-specific policy
 *   4. Priority-specific policy
 *   5. Global default (config.sla)
 */
function findPolicyForTicket(ticket) {
  // 1. Customer-specific
  if (ticket.customer_id) {
    const p = db.get(
      `SELECT * FROM sla_policies WHERE is_active = 1 AND customer_id = @cid AND (
         (priority = @priority OR priority IS NULL) AND
         (category = @category OR category IS NULL)
       ) ORDER BY priority IS NULL, category IS NULL LIMIT 1`,
      { cid: ticket.customer_id, priority: ticket.priority, category: ticket.category }
    );
    if (p) return rowToPolicy(p);
  }

  // 2. VIP-only
  const customer = ticket.customer_id ? db.get(`SELECT is_vip FROM customer_profiles WHERE id = @id`, { id: ticket.customer_id }) : null;
  if (customer && customer.is_vip) {
    const p = db.get(
      `SELECT * FROM sla_policies WHERE is_active = 1 AND is_vip_only = 1 AND customer_id IS NULL AND (
         (priority = @priority OR priority IS NULL) AND
         (category = @category OR category IS NULL)
       ) ORDER BY priority IS NULL, category IS NULL LIMIT 1`,
      { priority: ticket.priority, category: ticket.category }
    );
    if (p) return rowToPolicy(p);
  }

  // 3 & 4. Category/priority-specific
  const p = db.get(
    `SELECT * FROM sla_policies WHERE is_active = 1 AND customer_id IS NULL AND is_vip_only = 0 AND (
       (priority = @priority OR priority IS NULL) AND
       (category = @category OR category IS NULL)
     ) ORDER BY priority IS NULL, category IS NULL LIMIT 1`,
    { priority: ticket.priority, category: ticket.category }
  );
  if (p) return rowToPolicy(p);

  // 5. Default
  return null;
}

/**
 * Compute the SLA due timestamp for a ticket.
 * @param {object} ticket  must have priority, received_at, customer_id, category
 * @returns {string} ISO 8601 timestamp
 */
function computeSlaDue(ticket) {
  const policy = findPolicyForTicket(ticket);
  const priority = ticket.priority || 'Medium';

  // Resolution hours: policy override or config default
  let hours = config.sla[priority] ?? config.sla.Medium;
  if (policy && policy.resolution_hours != null) {
    hours = policy.resolution_hours;
  }

  const receivedAt = new Date(ticket.received_at || nowIso());

  if (policy && policy.business_hours_only) {
    return computeBusinessHoursDue(receivedAt, hours, policy.timezone);
  }
  return new Date(receivedAt.getTime() + hours * 3600 * 1000).toISOString();
}

/**
 * Add `hours` of business hours to a start date.
 * Default business hours: Mon-Fri 09:00-17:00 in the given timezone.
 */
function computeBusinessHoursDue(startAt, hours, timezone = 'UTC') {
  // Simple implementation: doesn't handle DST or non-UTC timezones perfectly.
  // For production, swap in a library like @js-joda or moment-timezone.
  let cursor = new Date(startAt);
  const bh = DEFAULT_BUSINESS_HOURS;
  let remainingMinutes = hours * 60;

  // Cap iterations to avoid infinite loop
  for (let i = 0; i < 10000 && remainingMinutes > 0; i++) {
    const day = cursor.getDay();
    const hour = cursor.getHours();
    const isWorkDay = bh.workDays.includes(day);
    const isWorkHour = hour >= bh.startHour && hour < bh.endHour;

    if (isWorkDay && isWorkHour) {
      // Find minutes remaining in the workday
      const endOfWorkDay = new Date(cursor);
      endOfWorkDay.setHours(bh.endHour, 0, 0, 0);
      const minutesLeftInDay = (endOfWorkDay - cursor) / 60000;

      if (remainingMinutes <= minutesLeftInDay) {
        cursor = new Date(cursor.getTime() + remainingMinutes * 60000);
        remainingMinutes = 0;
      } else {
        cursor = endOfWorkDay;
        remainingMinutes -= minutesLeftInDay;
      }
    } else {
      // Advance to the next hour boundary
      cursor = new Date(cursor.getTime() + 60 * 60000);
    }
  }

  return cursor.toISOString();
}

/**
 * Get the SLA policy that applies to a ticket (for display).
 */
function getPolicyForTicket(ticket) {
  return findPolicyForTicket(ticket);
}

/**
 * Get remaining SLA time for a ticket (in minutes).
 * Negative = already breached.
 */
function remainingMinutes(ticket) {
  if (!ticket.sla_due_at) return null;
  const due = new Date(ticket.sla_due_at).getTime();
  const now = Date.now();
  return Math.round((due - now) / 60000);
}

function rowToPolicy(row) {
  if (!row) return null;
  return {
    ...row,
    is_vip_only: !!row.is_vip_only,
    business_hours_only: !!row.business_hours_only,
    is_active: !!row.is_active,
  };
}

module.exports = {
  DEFAULT_BUSINESS_HOURS,
  list, get, create, update, remove,
  findPolicyForTicket, computeSlaDue, computeBusinessHoursDue, getPolicyForTicket, remainingMinutes,
};
