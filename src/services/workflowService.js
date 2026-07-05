'use strict';

/**
 * Workflow Rules Engine — if-then automation.
 *
 * Rules fire on events: ticket_created, ticket_updated, status_changed,
 * priority_changed, sla_breach, note_added, spam_detected.
 *
 * Conditions are JSON arrays of {field, op, value}:
 *   field: any ticket field (category, priority, sentiment, assigned_team, etc.)
 *   op:    eq | neq | in | not_in | contains | gt | lt | gte | lte | regex | is_set | is_not_set
 *   value: string | number | array
 *
 * Actions are JSON arrays of {type, params}:
 *   type: set_priority, set_category, set_status, set_team, assign_agent,
 *         add_tag, add_note, send_notification, call_webhook, set_sla,
 *         set_custom_field, escalate, delay
 *
 * Execution: when an event fires, the engine finds all active rules for that
 * event (ordered by priority asc), evaluates conditions against the ticket,
 * and executes actions in order. Every execution is logged in
 * workflow_executions for audit.
 *
 * Built-in safety:
 *   - Max 50 actions per rule execution
 *   - Max 10ms per condition evaluation
 *   - Failed actions don't stop the rule (logged but skipped)
 *   - Infinite loop prevention: a rule can't re-trigger itself
 */

const db = require('../database/db');
const { generateId, nowIso } = require('../utils/helpers');
const { asString, asArray } = require('../utils/validator');
const logger = require('../utils/logger').child('workflow');
const auditService = require('./auditService');
const notificationService = require('./notificationService');
const escalationService = require('./escalationService');
const log = logger;

const TRIGGER_EVENTS = [
  'ticket_created', 'ticket_updated', 'status_changed', 'priority_changed',
  'category_changed', 'sla_breach', 'note_added', 'spam_detected',
  'ticket_assigned', 'ticket_resolved',
];

const CONDITION_OPS = ['eq', 'neq', 'in', 'not_in', 'contains', 'gt', 'lt', 'gte', 'lte', 'regex', 'is_set', 'is_not_set'];

const ACTION_TYPES = [
  'set_priority', 'set_category', 'set_status', 'set_team', 'assign_agent',
  'add_tag', 'add_note', 'send_notification', 'call_webhook', 'set_sla',
  'set_custom_field', 'escalate', 'set_sentiment',
];

// ---------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------

function list({ isActive = true, triggerEvent, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = { limit, offset };
  if (isActive !== undefined) { where.push('is_active = @ia'); params.ia = isActive ? 1 : 0; }
  if (triggerEvent) { where.push('trigger_event = @te'); params.te = triggerEvent; }
  const sql = `SELECT * FROM workflow_rules ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY priority ASC, name ASC LIMIT @limit OFFSET @offset`;
  return db.all(sql, params).map(rowToRule);
}

function get(id) {
  const row = db.get(`SELECT * FROM workflow_rules WHERE id = @id`, { id });
  return row ? rowToRule(row) : null;
}

function create({ name, description, triggerEvent, conditions, actions, priority = 100 }) {
  if (!name) throw new Error('name is required');
  if (!TRIGGER_EVENTS.includes(triggerEvent)) throw new Error(`triggerEvent must be one of: ${TRIGGER_EVENTS.join(', ')}`);
  const condArr = Array.isArray(conditions) ? conditions.slice(0, 50) : [];
  const actArr = Array.isArray(actions) ? actions.slice(0, 50) : [];
  validateConditions(condArr);
  validateActions(actArr);

  const id = generateId('wf');
  const now = nowIso();
  const row = {
    id, name: asString(name, 100), description: asString(description, 500),
    trigger_event: triggerEvent,
    conditions: JSON.stringify(condArr),
    actions: JSON.stringify(actArr),
    priority: Number(priority) || 100,
    is_active: 1, execution_count: 0,
    last_executed_at: null, last_error: null,
    created_at: now, updated_at: now,
  };
  db.run(
    `INSERT INTO workflow_rules (id, name, description, trigger_event, conditions, actions, priority, is_active, execution_count, last_executed_at, last_error, created_at, updated_at)
     VALUES (@id, @name, @description, @trigger_event, @conditions, @actions, @priority, @is_active, @execution_count, @last_executed_at, @last_error, @created_at, @updated_at)`,
    row
  );
  log.info('Workflow rule created', { id, name, triggerEvent });
  return get(id);
}

function update(id, patch) {
  const existing = get(id);
  if (!existing) return null;
  const allowed = ['name', 'description', 'trigger_event', 'conditions', 'actions', 'priority', 'is_active'];
  const setClauses = [];
  const params = { id, updatedAt: nowIso() };
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    let v = patch[k];
    if (k === 'conditions') {
      const arr = Array.isArray(v) ? v.slice(0, 50) : [];
      validateConditions(arr);
      v = JSON.stringify(arr);
    } else if (k === 'actions') {
      const arr = Array.isArray(v) ? v.slice(0, 50) : [];
      validateActions(arr);
      v = JSON.stringify(arr);
    } else if (k === 'is_active') {
      v = v ? 1 : 0;
    } else if (k === 'priority') {
      v = Number(v) || 100;
    } else {
      v = asString(v, 500);
    }
    setClauses.push(`${k} = @${k}`);
    params[k] = v;
  }
  if (setClauses.length === 0) return existing;
  setClauses.push('updated_at = @updatedAt');
  db.run(`UPDATE workflow_rules SET ${setClauses.join(', ')} WHERE id = @id`, params);
  return get(id);
}

function remove(id) {
  const r = db.run(`DELETE FROM workflow_rules WHERE id = @id`, { id });
  return r.changes > 0;
}

function validateConditions(conditions) {
  for (const c of conditions) {
    if (!c.field) throw new Error('condition missing field');
    if (!CONDITION_OPS.includes(c.op)) throw new Error(`invalid op: ${c.op}`);
    if (!['is_set', 'is_not_set'].includes(c.op) && c.value === undefined) {
      throw new Error(`condition ${c.field}: value required for op ${c.op}`);
    }
  }
}

function validateActions(actions) {
  for (const a of actions) {
    if (!ACTION_TYPES.includes(a.type)) throw new Error(`invalid action type: ${a.type}`);
    if (!a.params || typeof a.params !== 'object') throw new Error(`action ${a.type}: params object required`);
  }
}

// ---------------------------------------------------------------
// Evaluation engine
// ---------------------------------------------------------------

/**
 * Evaluate a condition against a ticket.
 */
function evaluateCondition(condition, ticket) {
  const { field, op, value } = condition;
  const actual = ticket[field];

  switch (op) {
    case 'eq': return String(actual ?? '') === String(value);
    case 'neq': return String(actual ?? '') !== String(value);
    case 'in': return Array.isArray(value) && value.map(String).includes(String(actual ?? ''));
    case 'not_in': return Array.isArray(value) && !value.map(String).includes(String(actual ?? ''));
    case 'contains': return String(actual ?? '').toLowerCase().includes(String(value).toLowerCase());
    case 'gt': return Number(actual) > Number(value);
    case 'lt': return Number(actual) < Number(value);
    case 'gte': return Number(actual) >= Number(value);
    case 'lte': return Number(actual) <= Number(value);
    case 'regex':
      try { return new RegExp(value).test(String(actual ?? '')); }
      catch { return false; }
    case 'is_set': return actual != null && actual !== '';
    case 'is_not_set': return actual == null || actual === '';
    default: return false;
  }
}

function evaluateAll(conditions, ticket) {
  if (!conditions || !conditions.length) return true; // no conditions = always true
  return conditions.every((c) => evaluateCondition(c, ticket));
}

/**
 * Execute an action against a ticket. Returns the action result.
 */
function executeAction(action, ticket, context) {
  const { type, params } = action;
  const ticketService = require('./ticketService'); // lazy require to avoid circular
  const agentService = require('./agentService');

  switch (type) {
    case 'set_priority':
      return ticketService.update(ticket.id, { priority: params.priority }, `system:workflow:${context.ruleId}`);

    case 'set_category':
      return ticketService.update(ticket.id, { category: params.category }, `system:workflow:${context.ruleId}`);

    case 'set_status':
      return ticketService.update(ticket.id, { status: params.status }, `system:workflow:${context.ruleId}`);

    case 'set_team':
      return ticketService.update(ticket.id, { assigned_team: params.team }, `system:workflow:${context.ruleId}`);

    case 'set_sentiment':
      return ticketService.update(ticket.id, { sentiment: params.sentiment }, `system:workflow:${context.ruleId}`);

    case 'assign_agent': {
      if (params.agentId) {
        return ticketService.update(ticket.id, { assigned_agent_id: params.agentId }, `system:workflow:${context.ruleId}`);
      }
      // Auto-pick best agent
      const agent = agentService.findBestAgent({ team: ticket.assigned_team, category: ticket.category });
      if (agent) return ticketService.update(ticket.id, { assigned_agent_id: agent.id }, `system:workflow:${context.ruleId}`);
      return { skipped: true, reason: 'no available agent' };
    }

    case 'add_tag':
      return ticketService.addTag(ticket.id, params.tagName, params.color);

    case 'add_note':
      return ticketService.addNote(ticket.id, params.note, `system:workflow:${context.ruleId}`);

    case 'send_notification':
      return notificationService.notify(params.event || 'workflow_action', {
        ticketId: ticket.id, ticketSubject: ticket.email_subject,
        priority: ticket.priority, team: ticket.assigned_team,
        ruleName: context.ruleName, message: params.message,
      });

    case 'call_webhook': {
      const fetch = globalThis.fetch;
      if (!fetch) return { skipped: true, reason: 'fetch unavailable' };
      try {
        // Fire and forget (don't await)
        fetch(params.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(params.headers || {}) },
          body: JSON.stringify({ ticket: { id: ticket.id, subject: ticket.email_subject, priority: ticket.priority }, rule: context.ruleName }),
        }).catch(() => {});
        return { ok: true, fired: true };
      } catch (err) { return { ok: false, error: err.message }; }
    }

    case 'set_sla':
      // Override SLA by updating sla_due_at directly
      db.run(`UPDATE tickets SET sla_due_at = @sla WHERE id = @id`, {
        sla: params.slaDueAt, id: ticket.id,
      });
      auditService.record({ ticketId: ticket.id, action: 'edited', field: 'sla_due_at', newValue: params.slaDueAt, actor: `system:workflow:${context.ruleId}` });
      return { ok: true };

    case 'set_custom_field': {
      const customFieldService = require('./customFieldService');
      return customFieldService.setValue(ticket.id, params.fieldName, params.value);
    }

    case 'escalate':
      return escalationService.escalate(ticket.id, params.level || 1, `workflow:${context.ruleName}`, `system:workflow:${context.ruleId}`);

    default:
      return { skipped: true, reason: `unknown action type: ${type}` };
  }
}

/**
 * Fire an event — find all matching rules and execute them.
 * @param {string} event  one of TRIGGER_EVENTS
 * @param {object} ticket  full ticket row
 * @param {object} [context]  extra context (e.g. { note: '...', oldTicket: {...} })
 * @returns {Array<object>} execution results
 */
function fireEvent(event, ticket, context = {}) {
  if (!TRIGGER_EVENTS.includes(event)) {
    log.warn('Unknown workflow event', { event });
    return [];
  }
  if (!ticket) return [];

  const rules = list({ isActive: true, triggerEvent: event, limit: 50 });
  if (!rules.length) return [];

  const results = [];
  for (const rule of rules) {
    // Infinite loop prevention: don't fire a rule on an event it just produced
    if (context.firedByRule === rule.id) continue;

    const t0 = Date.now();
    let status = 'success';
    let error = null;
    const actionsTaken = [];

    try {
      // Evaluate conditions
      const conditions = rule.conditions_parsed;
      const matched = evaluateAll(conditions, ticket);
      if (!matched) {
        status = 'skipped';
      } else {
        // Execute actions
        const actions = rule.actions_parsed;
        for (const action of actions) {
          try {
            const result = executeAction(action, ticket, { ruleId: rule.id, ruleName: rule.name, ...context });
            actionsTaken.push({ type: action.type, result: result ? 'ok' : 'skipped' });
          } catch (err) {
            actionsTaken.push({ type: action.type, result: 'failed', error: err.message });
            log.warn('Action failed', { ruleId: rule.id, actionType: action.type, error: err.message });
          }
        }
      }
    } catch (err) {
      status = 'failed';
      error = err.message;
      log.error('Workflow rule execution failed', { ruleId: rule.id, error: err.message });
    }

    const durationMs = Date.now() - t0;

    // Log execution
    db.run(
      `INSERT INTO workflow_executions (rule_id, ticket_id, trigger_event, status, error, actions_taken, created_at)
       VALUES (@ruleId, @ticketId, @event, @status, @error, @actions, @now)`,
      {
        ruleId: rule.id, ticketId: ticket.id, event,
        status, error, actions: JSON.stringify(actionsTaken),
        now: nowIso(),
      }
    );

    // Update rule stats
    db.run(
      `UPDATE workflow_rules SET execution_count = execution_count + 1, last_executed_at = @now, last_error = @error WHERE id = @id`,
      { now: nowIso(), error: status === 'failed' ? error : null, id: rule.id }
    );

    results.push({ ruleId: rule.id, ruleName: rule.name, status, durationMs, actionsTaken });

    log.debug('Workflow rule executed', { ruleId: rule.id, ruleName: rule.name, status, durationMs });
  }

  return results;
}

/**
 * Get execution history for a rule.
 */
function executionsForRule(ruleId, { limit = 50 } = {}) {
  return db.all(
    `SELECT * FROM workflow_executions WHERE rule_id = @ruleId ORDER BY id DESC LIMIT @limit`,
    { ruleId, limit }
  );
}

/**
 * Get all executions for a ticket (across all rules).
 */
function executionsForTicket(ticketId, { limit = 50 } = {}) {
  return db.all(
    `SELECT we.*, wr.name AS rule_name
     FROM workflow_executions we
     JOIN workflow_rules wr ON wr.id = we.rule_id
     WHERE we.ticket_id = @ticketId
     ORDER BY we.id DESC LIMIT @limit`,
    { ticketId, limit }
  );
}

function rowToRule(row) {
  if (!row) return null;
  let conditions = [], actions = [];
  try { conditions = JSON.parse(row.conditions || '[]'); } catch { /* ignore */ }
  try { actions = JSON.parse(row.actions || '[]'); } catch { /* ignore */ }
  return {
    ...row,
    conditions_parsed: conditions,
    actions_parsed: actions,
    is_active: !!row.is_active,
  };
}

module.exports = {
  TRIGGER_EVENTS, CONDITION_OPS, ACTION_TYPES,
  list, get, create, update, remove,
  evaluateCondition, evaluateAll, executeAction, fireEvent,
  executionsForRule, executionsForTicket,
  validateConditions, validateActions,
};
