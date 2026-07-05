'use strict';

/**
 * Ticket Service (Production v2) — the orchestrator.
 *
 * Pipeline:
 *   1. Ingest inbound email (already parsed by emailService)
 *   2. Spam detection — auto-reject above threshold, flag above lower threshold
 *   3. Duplicate detection — link if same sender + same fingerprint in 24h
 *   4. AI analysis — full structured JSON (category, priority, sentiment, ...)
 *   5. PII redaction — produce a redacted copy of the body
 *   6. Resolve team (routing) and best agent (workload balancing)
 *   7. Persist ticket (with spam_score, language, pii_redacted_body, customer_id)
 *   8. Upsert customer profile (360 view)
 *   9. Persist attachments
 *  10. Suggest KB articles (RAG-lite) and cache on the ticket
 *  11. Send acknowledgment email
 *  12. Audit every step
 *  13. Notify (Slack/Teams/etc.) on critical priority, spam, escalation
 *  14. Return the created ticket + AI insights
 *
 * Manual review ops:
 *   - edit fields (with audit diffs)
 *   - change status (auto-set first_response_at / resolved_at)
 *   - add internal note
 *   - generate AI reply / resolution suggestion
 *   - list / filter / search (FTS5 powered)
 *   - merge duplicate
 */

const db = require('../database/db');
const config = require('../config');
const logger = require('../utils/logger').child('ticket');
const aiService = require('./aiService');
const ackService = require('./ackService');
const routingService = require('./routingService');
const attachmentService = require('./attachmentService');
const auditService = require('./auditService');
const customerService = require('./customerService');
const agentService = require('./agentService');
const kbService = require('./kbService');
const notificationService = require('./notificationService');
const metricsService = require('./metricsService');
const workflowService = require('./workflowService');
const threadingService = require('./threadingService');
const webhookOutService = require('./webhookOutService');
const slaPolicyService = require('./slaPolicyService');
const {
  generateTicketId,
  nowIso,
  computeSlaDue,
  fingerprint,
  truncate,
} = require('../utils/helpers');
const {
  asString,
  asArray,
  asNumber,
  asCategory,
  asPriority,
  asSentiment,
  asStatus,
  normalizeEmail,
} = require('../utils/validator');

const log = logger;

const TERMINAL_STATUSES = ['Resolved', 'Closed', 'Rejected', 'Spam'];

// ---------------------------------------------------------------
// Create ticket from inbound email (the full pipeline)
// ---------------------------------------------------------------
/**
 * @param {import('./emailService').InboundEmail} inbound
 * @param {object} [opts]
 * @param {boolean} [opts.sendAck=true]
 * @param {boolean} [opts.skipSpamCheck=false]
 * @returns {Promise<{ticket:object, ai:object, ack:object, duplicate:object|null, spam:object|null, warnings:string[]}>}
 */
async function createFromEmail(inbound, opts = {}) {
  const { sendAck = true, skipSpamCheck = false } = opts;
  const warnings = [];

  // ---------- Step 1: spam detection ----------
  let spamResult = null;
  let isSpam = false;
  let spamAutoRejected = false;
  if (config.spam.enabled && !skipSpamCheck) {
    spamResult = await aiService.detectSpam({ subject: inbound.subject, body: inbound.body });
    if (spamResult.spam_score >= config.spam.autoRejectThreshold) {
      spamAutoRejected = true;
      log.warn('Spam auto-rejected', { sender: inbound.senderEmail, score: spamResult.spam_score });
      metricsService.inc('spam_detected');
      return {
        ticket: null,
        spam: { autoRejected: true, ...spamResult },
        ack: { sent: false },
        duplicate: null,
        warnings: [`spam auto-rejected (score ${spamResult.spam_score})`],
        ai: {},
      };
    }
    if (spamResult.spam_score >= config.spam.threshold) {
      isSpam = true;
      metricsService.inc('spam_detected');
      notificationService.notify('spam_detected', {
        ticketId: null,
        senderEmail: inbound.senderEmail,
        subject: inbound.subject,
        spamScore: spamResult.spam_score,
        reasons: spamResult.reasons,
      });
    }
  }

  // ---------- Step 2: duplicate detection ----------
  const dup = detectDuplicate(inbound);
  if (dup) {
    log.info('Duplicate detected — linking to existing ticket', { existing: dup.id, sender: inbound.senderEmail });
    auditService.record({
      ticketId: dup.id, action: 'duplicated', actor: 'system',
      metadata: { from: inbound.senderEmail, subject: inbound.subject },
    });
  }

  // ---------- Step 3: AI analysis ----------
  const aiResult = await aiService.analyzeEmail({
    senderName: inbound.senderName,
    senderEmail: inbound.senderEmail,
    subject: inbound.subject,
    body: inbound.body,
  });
  if (!aiResult.ok) warnings.push('AI analysis failed; using fallback defaults');
  const ai = aiResult.data || {};
  if (aiResult.usedMock && !config.ai.useMock) warnings.push('LLM call failed and mock fallback was used');

  // If AI returned a spam_score and we didn't run the dedicated check, use AI's score
  if (!spamResult && typeof ai.spam_score === 'number') {
    spamResult = { spam_score: ai.spam_score, reasons: ['AI-flagged'] };
    if (ai.spam_score >= config.spam.threshold) isSpam = true;
  }

  // ---------- Step 4: PII redaction ----------
  const piiRedactedBody = aiService.redactPii(inbound.body || '');

  // ---------- Step 5: routing + agent assignment ----------
  const team = routingService.resolveTeam({
    category: ai.category,
    suggestedDepartment: ai.suggested_department,
  });
  let assignedAgent = null;
  if (!isSpam && config.features.bulkOps !== false) {
    try {
      assignedAgent = agentService.findBestAgent({ team, category: ai.category });
    } catch (err) { log.warn('Agent assignment failed', { error: err.message }); }
  }

  // ---------- Step 6: customer profile upsert ----------
  let customer = null;
  try {
    customer = customerService.upsertFromEmail({
      senderEmail: inbound.senderEmail,
      senderName: ai.customer_name || inbound.senderName,
      company: ai.company,
    });
  } catch (err) { log.warn('Customer upsert failed', { error: err.message }); }

  // ---------- Step 7: persist ticket ----------
  const ticketId = generateTicketId();
  const now = nowIso();
  const receivedAt = inbound.receivedAt || now;
  // Compute SLA using policy service (handles per-customer/category overrides + business hours)
  let slaDue;
  if (isSpam) {
    slaDue = null;
  } else {
    try {
      slaDue = slaPolicyService.computeSlaDue({
        priority: ai.priority || 'Medium',
        received_at: receivedAt,
        customer_id: customer?.id,
        category: ai.category || 'General Inquiry',
      });
    } catch (err) {
      log.warn('SLA policy computation failed; using default', { error: err.message });
      slaDue = computeSlaDue(ai.priority || 'Medium', new Date(receivedAt));
    }
  }

  const ticketRow = {
    id: ticketId,
    customer_name: ai.customer_name || inbound.senderName || '',
    company: ai.company || '',
    sender_email: normalizeEmail(inbound.senderEmail),
    sender_name: inbound.senderName || ai.customer_name || '',
    email_subject: inbound.subject || '(no subject)',
    email_body: inbound.body || '',
    issue_summary: ai.issue_summary || '',
    detailed_description: ai.detailed_description || '',
    category: ai.category || 'General Inquiry',
    priority: ai.priority || 'Medium',
    sentiment: ai.sentiment || 'Neutral',
    product_service: ai.product_service || 'General',
    suggested_department: ai.suggested_department || team,
    suggested_tags: JSON.stringify(ai.suggested_tags || []),
    confidence_score: ai.confidence_score ?? 50,
    assigned_team: isSpam ? null : team,
    assigned_agent_id: assignedAgent ? assignedAgent.id : null,
    status: isSpam ? 'Spam' : 'Open',
    internal_notes: '',
    received_at: receivedAt,
    last_updated: now,
    first_response_at: null,
    resolved_at: null,
    acknowledged: 0,
    acknowledged_at: null,
    sla_due_at: slaDue,
    sla_breached: 0,
    escalated: 0,
    escalated_at: null,
    escalation_level: 0,
    language: ai.language || 'en',
    is_spam: isSpam ? 1 : 0,
    spam_score: spamResult ? spamResult.spam_score : (ai.spam_score || 0),
    pii_redacted_body: piiRedactedBody,
    ai_resolution_suggestion: null,
    ai_kb_article_ids: null,
    raw_ai_response: aiResult.raw || JSON.stringify(ai),
    source: inbound.source === 'eml' ? 'email' : inbound.source,
    duplicate_of: dup ? dup.id : null,
    customer_id: customer ? customer.id : null,
    created_at: now,
    updated_at: now,
  };

  db.run(
    `INSERT INTO tickets (
       id, customer_name, company, sender_email, sender_name, email_subject, email_body,
       issue_summary, detailed_description, category, priority, sentiment, product_service,
       suggested_department, suggested_tags, confidence_score, assigned_team, assigned_agent_id, status,
       internal_notes, received_at, last_updated, first_response_at, resolved_at,
       acknowledged, acknowledged_at, sla_due_at, sla_breached, escalated, escalated_at, escalation_level,
       language, is_spam, spam_score, pii_redacted_body, ai_resolution_suggestion, ai_kb_article_ids,
       raw_ai_response, source, duplicate_of, customer_id, created_at, updated_at
     ) VALUES (
       @id, @customer_name, @company, @sender_email, @sender_name, @email_subject, @email_body,
       @issue_summary, @detailed_description, @category, @priority, @sentiment, @product_service,
       @suggested_department, @suggested_tags, @confidence_score, @assigned_team, @assigned_agent_id, @status,
       @internal_notes, @received_at, @last_updated, @first_response_at, @resolved_at,
       @acknowledged, @acknowledged_at, @sla_due_at, @sla_breached, @escalated, @escalated_at, @escalation_level,
       @language, @is_spam, @spam_score, @pii_redacted_body, @ai_resolution_suggestion, @ai_kb_article_ids,
       @raw_ai_response, @source, @duplicate_of, @customer_id, @created_at, @updated_at
     )`,
    ticketRow
  );

  metricsService.inc('tickets_created');
  auditService.record({ ticketId, action: 'created', actor: 'system', metadata: { source: ticketRow.source, receivedAt, isSpam, language: ticketRow.language, spamScore: ticketRow.spam_score } });
  if (!isSpam) {
    auditService.record({ ticketId, action: 'classified', actor: 'ai', metadata: { category: ticketRow.category, priority: ticketRow.priority, sentiment: ticketRow.sentiment, confidence: ticketRow.confidence_score, usedMock: aiResult.usedMock, language: ticketRow.language } });
    auditService.record({ ticketId, action: 'assigned', actor: 'system', field: 'assigned_team', newValue: team, metadata: { reason: 'auto-routing by category', agent: assignedAgent ? assignedAgent.id : null } });
  }

  // ---------- Step 8: attachments ----------
  if (inbound.attachments && inbound.attachments.length > 0) {
    attachmentService.persistForTicket(ticketId, inbound.attachments);
  }

  // ---------- Step 9: KB article suggestions (RAG-lite) ----------
  let kbSuggestions = [];
  if (!isSpam && config.features.knowledgeBase) {
    try {
      kbSuggestions = kbService.suggestForTicket(rowToTicket(ticketRow), 3);
      if (kbSuggestions.length) {
        const ids = kbSuggestions.map((a) => a.id);
        db.run(`UPDATE tickets SET ai_kb_article_ids = @ids WHERE id = @id`, { ids: JSON.stringify(ids), id: ticketId });
      }
    } catch (err) { log.warn('KB suggestion failed', { error: err.message }); }
  }

  // ---------- Step 10: acknowledgment ----------
  let ack = { sent: false };
  if (sendAck && !isSpam) {
    ack = await ackService.send(rowToTicket(ticketRow));
    db.run(`UPDATE tickets SET acknowledged = 1, acknowledged_at = @at WHERE id = @id`, { at: nowIso(), id: ticketId });
    auditService.record({ ticketId, action: 'acknowledged', actor: 'system', metadata: ack });
  }

  // ---------- Step 11: notifications ----------
  if (!isSpam && ai.priority === 'Critical') {
    notificationService.notify('critical_priority', {
      ticketId, senderEmail: ticketRow.sender_email, subject: ticketRow.email_subject,
      category: ticketRow.category, priority: ticketRow.priority, team,
    });
  }
  if (!isSpam) {
    notificationService.notify('ticket_created', {
      ticketId, senderEmail: ticketRow.sender_email, subject: ticketRow.email_subject,
      category: ticketRow.category, priority: ticketRow.priority, team,
    });
  }

  log.info('Ticket created', { ticketId, category: ticketRow.category, priority: ticketRow.priority, team, isSpam, agent: assignedAgent?.id });

  // ---------- Step 12 (NEW v3): Threading ----------
  if (!isSpam) {
    try { threadingService.findOrCreateThreadForTicket(rowToTicket(ticketRow)); }
    catch (err) { log.warn('Threading failed', { error: err.message }); }
  }

  // ---------- Step 13 (NEW v3): Fire workflow rules ----------
  if (!isSpam) {
    try {
      const workflowResults = workflowService.fireEvent('ticket_created', rowToTicket(ticketRow));
      if (workflowResults.length) log.info('Workflow rules fired', { count: workflowResults.length });
    } catch (err) { log.warn('Workflow fire failed', { error: err.message }); }
  }

  // ---------- Step 14 (NEW v3): Emit outbound webhook ----------
  if (!isSpam) {
    try {
      webhookOutService.emit('ticket_created', {
        ticketId, subject: ticketRow.email_subject, category: ticketRow.category,
        priority: ticketRow.priority, status: ticketRow.status,
        senderEmail: ticketRow.sender_email, team: ticketRow.assigned_team,
      }).catch((err) => log.warn('Outbound webhook emit failed', { error: err.message }));
    } catch (err) { log.warn('Outbound webhook emit failed', { error: err.message }); }
  }

  return {
    ticket: rowToTicket(ticketRow),
    ai: { ...ai, usedMock: aiResult.usedMock },
    ack,
    duplicate: dup ? { id: dup.id, subject: dup.subject } : null,
    spam: spamResult ? { autoRejected: false, ...spamResult } : null,
    kbSuggestions,
    assignedAgent: assignedAgent ? { id: assignedAgent.id, name: assignedAgent.name } : null,
    customer: customer ? { id: customer.id, totalTickets: customer.total_tickets } : null,
    warnings,
  };
}

// ---------------------------------------------------------------
// Duplicate detection: same sender + same body fingerprint in 24h
// ---------------------------------------------------------------
function detectDuplicate(inbound) {
  const fp = fingerprint(`${inbound.subject}|${inbound.body}`);
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const rows = db.all(
    `SELECT id, email_subject, sender_email, email_body FROM tickets
     WHERE sender_email = @email AND received_at >= @since
     ORDER BY received_at DESC LIMIT 5`,
    { email: normalizeEmail(inbound.senderEmail), since }
  );
  for (const r of rows) {
    if (fingerprint(`${r.email_subject}|${r.email_body}`) === fp) return r;
  }
  return null;
}

// ---------------------------------------------------------------
// List / filter / search (FTS5 when q looks like a search)
// ---------------------------------------------------------------
function list({ status, priority, category, team, agentId, isSpam, escalated, q, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = { limit, offset };
  if (status) { where.push('status = @status'); params.status = status; }
  if (priority) { where.push('priority = @priority'); params.priority = priority; }
  if (category) { where.push('category = @category'); params.category = category; }
  if (team) { where.push('assigned_team = @team'); params.team = team; }
  if (agentId) { where.push('assigned_agent_id = @agentId'); params.agentId = agentId; }
  if (isSpam !== undefined) { where.push('is_spam = @isSpam'); params.isSpam = isSpam ? 1 : 0; }
  if (escalated !== undefined) { where.push('escalated = @escalated'); params.escalated = escalated ? 1 : 0; }
  if (q) {
    where.push('(email_subject LIKE @q OR issue_summary LIKE @q OR sender_email LIKE @q OR id LIKE @q OR customer_name LIKE @q)');
    params.q = `%${q}%`;
  }
  const sql = `SELECT * FROM tickets ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY received_at DESC LIMIT @limit OFFSET @offset`;
  return db.all(sql, params).map(rowToTicket);
}

/**
 * Full-text search using the FTS5 index.
 */
function ftsSearch(query, { limit = 50 } = {}) {
  const safe = String(query || '').replace(/["']/g, '').trim().split(/\s+/).filter(Boolean).map((w) => `"${w}"`).join(' ');
  if (!safe) return [];
  try {
    const ftsRows = db.all(
      `SELECT t.* FROM tickets_fts f JOIN tickets t ON t.id = f.id
       WHERE tickets_fts MATCH @q
       ORDER BY bm25(tickets_fts)
       LIMIT @limit`,
      { q: safe, limit }
    );
    return ftsRows.map(rowToTicket);
  } catch (err) {
    log.warn('FTS search failed', { error: err.message, q: safe });
    return [];
  }
}

function get(id) {
  const row = db.get(`SELECT * FROM tickets WHERE id = @id`, { id });
  return row ? rowToTicket(row) : null;
}

function getAuditTrail(id) { return auditService.listForTicket(id); }

function getNotes(id) {
  return db.all(`SELECT * FROM ticket_notes WHERE ticket_id = @id ORDER BY id ASC`, { id });
}

function getAttachments(id) { return attachmentService.listForTicket(id); }

function getTags(id) {
  return db.all(
    `SELECT t.id, t.name, t.color FROM tags t
     JOIN ticket_tags tt ON tt.tag_id = t.id
     WHERE tt.ticket_id = @id`,
    { id }
  );
}

function addTag(id, name, color = '#6b7280') {
  const safeName = String(name || '').toLowerCase().trim();
  if (!safeName) return null;
  let tag = db.get(`SELECT id FROM tags WHERE name = @name`, { name: safeName });
  if (!tag) {
    db.run(`INSERT INTO tags (name, color, created_at) VALUES (@name, @color, @now)`, { name: safeName, color, now: nowIso() });
    tag = db.get(`SELECT id FROM tags WHERE name = @name`, { name: safeName });
  }
  db.run(`INSERT OR IGNORE INTO ticket_tags (ticket_id, tag_id) VALUES (@tid, @tagId)`, { tid: id, tagId: tag.id });
  return tag;
}

function removeTag(id, tagId) {
  db.run(`DELETE FROM ticket_tags WHERE ticket_id = @tid AND tag_id = @tagId`, { tid: id, tagId: tagId });
}

// ---------------------------------------------------------------
// Manual review operations
// ---------------------------------------------------------------
function update(id, patch, actor = 'system') {
  const ticket = get(id);
  if (!ticket) throw new Error('ticket not found');

  const allowed = [
    'customer_name', 'company', 'issue_summary', 'detailed_description',
    'category', 'priority', 'sentiment', 'product_service', 'assigned_team',
    'assigned_agent_id', 'status', 'internal_notes', 'email_subject',
  ];
  const setClauses = [];
  const params = { id, updatedAt: nowIso() };

  for (const key of allowed) {
    if (patch[key] === undefined) continue;
    let v = patch[key];
    if (key === 'category') v = asCategory(v);
    else if (key === 'priority') v = asPriority(v);
    else if (key === 'sentiment') v = asSentiment(v);
    else if (key === 'status') v = asStatus(v);
    else if (key === 'assigned_agent_id') v = v ? String(v) : null;
    else v = asString(v, 4000);

    if (String(ticket[key] ?? '') === String(v)) continue;
    setClauses.push(`${key} = @${key}`);
    params[key] = v;

    let action = 'edited';
    if (key === 'status') action = 'status_changed';
    else if (key === 'priority') action = 'priority_changed';
    else if (key === 'category') action = 'category_changed';
    else if (key === 'assigned_team' || key === 'assigned_agent_id') action = 'assigned';

    auditService.record({ ticketId: id, action, field: key, oldValue: ticket[key], newValue: v, actor });

    if (key === 'priority') {
      const newSla = computeSlaDue(v, new Date(ticket.received_at));
      setClauses.push('sla_due_at = @slaDue');
      params.slaDue = newSla;
    }

    // Status transitions: set first_response_at / resolved_at
    if (key === 'status') {
      if (v === 'In Progress' && !ticket.first_response_at) {
        setClauses.push('first_response_at = @fr');
        params.fr = nowIso();
      }
      if (v === 'Resolved' && !ticket.resolved_at) {
        setClauses.push('resolved_at = @rs');
        params.rs = nowIso();
        metricsService.inc('tickets_resolved');
        notificationService.notify('ticket_resolved', { ticketId: id, subject: ticket.email_subject });
        // Decrement customer open count
        if (ticket.customer_id) {
          try { customerService.decrementOpen(ticket.customer_id); } catch { /* ignore */ }
        }
      }
      if (v === 'Closed' && !ticket.resolved_at) {
        setClauses.push('resolved_at = @rs');
        params.rs = nowIso();
      }
      // Clear escalation when ticket moves to terminal state
      if (TERMINAL_STATUSES.includes(v) && ticket.escalated) {
        setClauses.push('escalated = 0');
      }
    }
  }

  if (setClauses.length === 0) return ticket;

  setClauses.push('last_updated = @updatedAt', 'updated_at = @updatedAt');
  db.run(`UPDATE tickets SET ${setClauses.join(', ')} WHERE id = @id`, params);

  const updated = get(id);

  // Fire workflow events for changes (NEW v3)
  try {
    if (patch.status) {
      workflowService.fireEvent('status_changed', updated, { firedByRule: null, oldTicket: ticket });
      if (patch.status === 'Resolved') workflowService.fireEvent('ticket_resolved', updated);
      if (patch.status === 'Closed') workflowService.fireEvent('ticket_closed', updated);
      if (patch.status === 'Rejected') workflowService.fireEvent('ticket_rejected', updated);
    }
    if (patch.priority) workflowService.fireEvent('priority_changed', updated, { oldTicket: ticket });
    if (patch.category) workflowService.fireEvent('category_changed', updated, { oldTicket: ticket });
    if (patch.assigned_agent_id) workflowService.fireEvent('ticket_assigned', updated, { oldTicket: ticket });
    // Generic update event
    workflowService.fireEvent('ticket_updated', updated, { oldTicket: ticket });
    // Emit outbound webhooks for key changes
    if (patch.status === 'Resolved') webhookOutService.emit('ticket_resolved', { ticketId: id, status: patch.status }).catch(() => {});
    if (patch.status === 'Closed') webhookOutService.emit('ticket_closed', { ticketId: id, status: patch.status }).catch(() => {});
  } catch (err) { log.warn('Workflow fire on update failed', { error: err.message }); }

  return updated;
}

function addNote(id, note, actor = 'system', isInternal = true) {
  const now = nowIso();
  db.run(
    `INSERT INTO ticket_notes (ticket_id, author, note, is_internal, created_at) VALUES (@id, @author, @note, @isInternal, @at)`,
    { id, author: actor, note: asString(note, 4000), isInternal: isInternal ? 1 : 0, at: now }
  );
  db.run(`UPDATE tickets SET internal_notes = @note, last_updated = @at, updated_at = @at WHERE id = @id`, { id, note: asString(note, 4000), at: now });
  auditService.record({ ticketId: id, action: 'note_added', actor, newValue: asString(note, 400) });
  // Fire workflow event (NEW v3)
  try {
    const ticket = get(id);
    if (ticket) workflowService.fireEvent('note_added', ticket, { note });
  } catch { /* ignore */ }
  return get(id);
}

function transitionStatus(id, newStatus, actor = 'system') {
  const ticket = get(id);
  if (!ticket) throw new Error('ticket not found');
  return update(id, { status: asStatus(newStatus) }, actor);
}

/**
 * AI reply suggestion (with KB context).
 */
async function suggestReply(id) {
  const ticket = get(id);
  if (!ticket) throw new Error('ticket not found');
  let kbArticles = [];
  if (ticket.ai_kb_article_ids) {
    try {
      const ids = JSON.parse(ticket.ai_kb_article_ids);
      kbArticles = ids.map((aid) => kbService.get(aid)).filter(Boolean);
    } catch { /* ignore */ }
  }
  return aiService.suggestReply(ticket, kbArticles);
}

/**
 * AI resolution suggestion (cached on the ticket).
 */
async function suggestResolution(id) {
  const ticket = get(id);
  if (!ticket) throw new Error('ticket not found');
  let kbArticles = [];
  if (ticket.ai_kb_article_ids) {
    try {
      const ids = JSON.parse(ticket.ai_kb_article_ids);
      kbArticles = ids.map((aid) => kbService.get(aid)).filter(Boolean);
    } catch { /* ignore */ }
  }
  const result = await aiService.suggestResolution(ticket, kbArticles);
  // Cache on the ticket
  db.run(`UPDATE tickets SET ai_resolution_suggestion = @s WHERE id = @id`,
    { s: JSON.stringify(result), id });
  return result;
}

/**
 * Merge a duplicate ticket into its parent.
 */
function mergeInto(childId, parentId, actor = 'system') {
  const child = get(childId);
  if (!child) throw new Error('child ticket not found');
  const parent = get(parentId);
  if (!parent) throw new Error('parent ticket not found');

  // Copy notes from child to parent
  const childNotes = getNotes(childId);
  for (const n of childNotes) {
    addNote(parentId, `[merged from ${childId}] ${n.note}`, n.author, true);
  }

  // Mark child as Closed + duplicate
  db.run(`UPDATE tickets SET status = 'Closed', duplicate_of = @pid, internal_notes = @note, last_updated = @now, updated_at = @now WHERE id = @cid`,
    { pid: parentId, note: `Merged into ${parentId}`, now: nowIso(), cid: childId });

  auditService.record({ ticketId: parentId, action: 'edited', field: 'merge', newValue: childId, actor, metadata: { source: 'merge' } });
  auditService.record({ ticketId: childId, action: 'status_changed', field: 'status', oldValue: child.status, newValue: 'Closed', actor, metadata: { merged_into: parentId } });

  return get(parentId);
}

// ---------------------------------------------------------------
// Stats for the dashboard
// ---------------------------------------------------------------
function stats() {
  const total = db.get(`SELECT COUNT(*) AS n FROM tickets`).n;
  const byStatus = db.all(`SELECT status, COUNT(*) AS n FROM tickets GROUP BY status`);
  const byPriority = db.all(`SELECT priority, COUNT(*) AS n FROM tickets GROUP BY priority`);
  const byCategory = db.all(`SELECT category, COUNT(*) AS n FROM tickets GROUP BY category`);
  const byTeam = db.all(`SELECT assigned_team, COUNT(*) AS n FROM tickets GROUP BY assigned_team`);
  const bySentiment = db.all(`SELECT sentiment, COUNT(*) AS n FROM tickets GROUP BY sentiment`);
  const byLanguage = db.all(`SELECT language, COUNT(*) AS n FROM tickets WHERE language IS NOT NULL GROUP BY language`);

  const now = nowIso();
  const termPlaceholders = TERMINAL_STATUSES.map((_, i) => `@t${i}`).join(',');
  const termParams = {};
  TERMINAL_STATUSES.forEach((s, i) => { termParams[`t${i}`] = s; });

  const breached = db.all(
    `SELECT id, email_subject, priority, sla_due_at, assigned_team, escalation_level
     FROM tickets
     WHERE status NOT IN (${termPlaceholders}) AND sla_due_at < @now
     ORDER BY sla_due_at ASC`,
    { ...termParams, now }
  );

  const escalated = db.get(
    `SELECT COUNT(*) AS n FROM tickets WHERE escalated = 1 AND status NOT IN (${termPlaceholders})`,
    termParams
  ).n;
  const spamCount = db.get(`SELECT COUNT(*) AS n FROM tickets WHERE is_spam = 1`).n;
  const avgConf = db.get(`SELECT AVG(confidence_score) AS v FROM tickets WHERE is_spam = 0`).v || 0;
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const recent = db.get(`SELECT COUNT(*) AS n FROM tickets WHERE received_at >= @since`, { since }).n;

  return {
    total,
    recent_24h: recent,
    escalated_open: escalated,
    spam_detected: spamCount,
    byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
    byPriority: Object.fromEntries(byPriority.map((r) => [r.priority, r.n])),
    byCategory: Object.fromEntries(byCategory.map((r) => [r.category, r.n])),
    byTeam: Object.fromEntries(byTeam.map((r) => [r.assigned_team || 'Unassigned', r.n])),
    bySentiment: Object.fromEntries(bySentiment.map((r) => [r.sentiment, r.n])),
    byLanguage: Object.fromEntries(byLanguage.map((r) => [r.language || 'unknown', r.n])),
    slaBreached: breached,
    avgConfidence: Math.round(avgConf * 10) / 10,
  };
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
function rowToTicket(row) {
  if (!row) return null;
  let tags = [];
  try { tags = JSON.parse(row.suggested_tags || '[]'); } catch { /* ignore */ }
  let kbIds = null;
  try { kbIds = row.ai_kb_article_ids ? JSON.parse(row.ai_kb_article_ids) : null; } catch { /* ignore */ }
  return {
    ...row,
    suggested_tags: tags,
    ai_kb_article_ids: kbIds,
    acknowledged: !!row.acknowledged,
    is_spam: !!row.is_spam,
    escalated: !!row.escalated,
    sla_breached: !!row.sla_breached,
  };
}

module.exports = {
  createFromEmail,
  detectDuplicate,
  list,
  ftsSearch,
  get,
  getAuditTrail,
  getNotes,
  getAttachments,
  getTags,
  addTag,
  removeTag,
  update,
  addNote,
  transitionStatus,
  suggestReply,
  suggestResolution,
  mergeInto,
  stats,
  rowToTicket,
  TERMINAL_STATUSES,
};
