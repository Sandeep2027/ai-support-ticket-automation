-- ============================================================
-- AI Customer Support Ticket Automation — SQLite Schema v2
-- ============================================================
-- Production schema with knowledge base, agents, escalations,
-- notifications, customer profiles, API keys, saved filters,
-- ticket tags, and SLA tracking.
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------
-- 1. Tickets (main table)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tickets (
    id                  TEXT PRIMARY KEY,
    customer_name       TEXT,
    company             TEXT,
    sender_email        TEXT NOT NULL,
    sender_name         TEXT,
    email_subject       TEXT,
    email_body          TEXT,
    issue_summary       TEXT,
    detailed_description TEXT,
    category            TEXT,
    priority            TEXT CHECK(priority IN ('Critical','High','Medium','Low')),
    sentiment           TEXT CHECK(sentiment IN ('Positive','Neutral','Negative')),
    product_service     TEXT,
    suggested_department TEXT,
    suggested_tags      TEXT,
    confidence_score    REAL,
    assigned_team       TEXT,
    assigned_agent_id   TEXT,                                -- FK agents.id (nullable)
    status              TEXT NOT NULL DEFAULT 'Open'
                        CHECK(status IN ('Open','In Progress','Waiting for Customer','Resolved','Closed','Rejected','Spam')),
    internal_notes      TEXT,
    received_at         TEXT NOT NULL,
    last_updated        TEXT NOT NULL,
    first_response_at   TEXT,                                 -- when agent first replied
    resolved_at         TEXT,
    acknowledged        INTEGER NOT NULL DEFAULT 0,
    acknowledged_at     TEXT,
    sla_due_at          TEXT,
    sla_breached        INTEGER NOT NULL DEFAULT 0,
    escalated           INTEGER NOT NULL DEFAULT 0,
    escalated_at        TEXT,
    escalation_level    INTEGER NOT NULL DEFAULT 0,
    language            TEXT,                                 -- ISO 639-1 (en, es, fr, de, ...)
    is_spam             INTEGER NOT NULL DEFAULT 0,
    spam_score          REAL DEFAULT 0,
    pii_redacted_body   TEXT,                                 -- body with PII redacted (for KB sharing)
    ai_resolution_suggestion TEXT,                            -- cached AI resolution hint
    ai_kb_article_ids   TEXT,                                 -- JSON array of suggested KB article IDs
    raw_ai_response     TEXT,
    source              TEXT NOT NULL DEFAULT 'email',
    duplicate_of        TEXT,
    customer_id         TEXT,                                 -- FK customer_profiles.id (nullable, populated by trigger)
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    FOREIGN KEY (assigned_agent_id) REFERENCES agents(id) ON DELETE SET NULL,
    FOREIGN KEY (duplicate_of) REFERENCES tickets(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tickets_status       ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_priority     ON tickets(priority);
CREATE INDEX IF NOT EXISTS idx_tickets_category     ON tickets(category);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned     ON tickets(assigned_team);
CREATE INDEX IF NOT EXISTS idx_tickets_agent        ON tickets(assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_tickets_received_at  ON tickets(received_at);
CREATE INDEX IF NOT EXISTS idx_tickets_email        ON tickets(sender_email);
CREATE INDEX IF NOT EXISTS idx_tickets_sla          ON tickets(sla_due_at) WHERE status NOT IN ('Resolved','Closed','Rejected','Spam');
CREATE INDEX IF NOT EXISTS idx_tickets_customer     ON tickets(customer_id);
CREATE INDEX IF NOT EXISTS idx_tickets_escalated    ON tickets(escalated) WHERE escalated = 1;
CREATE INDEX IF NOT EXISTS idx_tickets_spam         ON tickets(is_spam) WHERE is_spam = 1;

-- Full-text search on subject + body + summary (SQLite FTS5)
CREATE VIRTUAL TABLE IF NOT EXISTS tickets_fts USING fts5(
    id UNINDEXED, subject, body, summary, customer_name, sender_email,
    content='tickets', content_rowid='rowid',
    tokenize='porter unicode61'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS tickets_ai AFTER INSERT ON tickets BEGIN
    INSERT INTO tickets_fts(rowid, id, subject, body, summary, customer_name, sender_email)
    VALUES (new.rowid, new.id, new.email_subject, new.email_body, new.issue_summary, new.customer_name, new.sender_email);
END;
CREATE TRIGGER IF NOT EXISTS tickets_ad AFTER DELETE ON tickets BEGIN
    INSERT INTO tickets_fts(tickets_fts, rowid, id, subject, body, summary, customer_name, sender_email)
    VALUES ('delete', old.rowid, old.id, old.email_subject, old.email_body, old.issue_summary, old.customer_name, old.sender_email);
END;
CREATE TRIGGER IF NOT EXISTS tickets_au AFTER UPDATE ON tickets BEGIN
    INSERT INTO tickets_fts(tickets_fts, rowid, id, subject, body, summary, customer_name, sender_email)
    VALUES ('delete', old.rowid, old.id, old.email_subject, old.email_body, old.issue_summary, old.customer_name, old.sender_email);
    INSERT INTO tickets_fts(rowid, id, subject, body, summary, customer_name, sender_email)
    VALUES (new.rowid, new.id, new.email_subject, new.email_body, new.issue_summary, new.customer_name, new.sender_email);
END;

-- ------------------------------------------------------------
-- 2. Attachments
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attachments (
    id            TEXT PRIMARY KEY,
    ticket_id     TEXT NOT NULL,
    filename      TEXT NOT NULL,
    mime_type     TEXT,
    size_bytes    INTEGER,
    storage_path  TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_attachments_ticket ON attachments(ticket_id);

-- ------------------------------------------------------------
-- 3. Audit Trail (append-only)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_trail (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id     TEXT NOT NULL,
    action        TEXT NOT NULL,
    field         TEXT,
    old_value     TEXT,
    new_value     TEXT,
    actor         TEXT NOT NULL DEFAULT 'system',
    metadata      TEXT,
    created_at    TEXT NOT NULL,
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_audit_ticket ON audit_trail(ticket_id);
CREATE INDEX IF NOT EXISTS idx_audit_action  ON audit_trail(action);
CREATE INDEX IF NOT EXISTS idx_audit_actor   ON audit_trail(actor);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_trail(created_at);

-- ------------------------------------------------------------
-- 4. Internal Notes (full history)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_notes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id     TEXT NOT NULL,
    author        TEXT NOT NULL DEFAULT 'system',
    note          TEXT NOT NULL,
    is_internal   INTEGER NOT NULL DEFAULT 1,           -- 1=internal, 0=visible to customer
    created_at    TEXT NOT NULL,
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_notes_ticket ON ticket_notes(ticket_id);

-- ------------------------------------------------------------
-- 5. Routing Configuration (category -> team)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS routing_config (
    category      TEXT PRIMARY KEY,
    team          TEXT NOT NULL,
    is_active     INTEGER NOT NULL DEFAULT 1
);

INSERT OR IGNORE INTO routing_config (category, team) VALUES
    ('Technical Support',  'Technical Support'),
    ('Billing',            'Finance'),
    ('Sales Inquiry',      'Sales'),
    ('Feature Request',    'Product Team'),
    ('Bug Report',         'Product Team'),
    ('Account Access',     'Customer Success'),
    ('Refund Request',     'Finance'),
    ('General Inquiry',    'Customer Success');

-- ------------------------------------------------------------
-- 6. Inbox Log
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inbox_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id    TEXT,
    sender_email  TEXT,
    subject       TEXT,
    received_at   TEXT NOT NULL,
    status        TEXT NOT NULL,
    reason        TEXT,
    ticket_id     TEXT,
    is_spam       INTEGER DEFAULT 0,
    created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox_log(status);
CREATE INDEX IF NOT EXISTS idx_inbox_spam   ON inbox_log(is_spam);

-- ============================================================
-- PRODUCTION v2 TABLES
-- ============================================================

-- ------------------------------------------------------------
-- 7. Agents (support team members)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agents (
    id            TEXT PRIMARY KEY,                       -- agt-<uuid>
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    team          TEXT NOT NULL,                          -- Technical Support | Finance | Sales | Customer Success | Product Team
    role          TEXT NOT NULL DEFAULT 'agent',          -- admin | agent | viewer
    is_active     INTEGER NOT NULL DEFAULT 1,
    max_concurrent INTEGER NOT NULL DEFAULT 25,           -- workload cap
    skills        TEXT,                                    -- JSON array: ['Technical Support','Billing']
    timezone      TEXT DEFAULT 'UTC',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_team ON agents(team) WHERE is_active = 1;

-- Seed a default admin agent
INSERT OR IGNORE INTO agents (id, name, email, team, role, is_active, skills, created_at, updated_at)
VALUES ('agt-system', 'System', 'system@localhost', 'Customer Success', 'admin', 1, '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

-- ------------------------------------------------------------
-- 8. API Keys (for programmatic agent access)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_keys (
    id            TEXT PRIMARY KEY,                       -- key_<random>
    agent_id      TEXT NOT NULL,
    key_hash      TEXT NOT NULL UNIQUE,                   -- SHA-256 hash of the plaintext key
    key_prefix    TEXT NOT NULL,                          -- first 8 chars for identification
    name          TEXT NOT NULL,                          -- human label
    last_used_at  TEXT,
    expires_at    TEXT,                                    -- nullable
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_apikeys_hash ON api_keys(key_hash);

-- ------------------------------------------------------------
-- 9. Knowledge Base Articles (RAG source)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kb_articles (
    id            TEXT PRIMARY KEY,                       -- kb-<slug>
    title         TEXT NOT NULL,
    slug          TEXT NOT NULL UNIQUE,
    content       TEXT NOT NULL,                          -- markdown
    summary       TEXT,                                    -- one-line for cards
    category      TEXT,                                    -- Technical Support | Billing | ...
    tags          TEXT,                                    -- JSON array
    view_count    INTEGER NOT NULL DEFAULT 0,
    helpful_count INTEGER NOT NULL DEFAULT 0,
    is_published  INTEGER NOT NULL DEFAULT 1,
    author_id     TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    FOREIGN KEY (author_id) REFERENCES agents(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_category ON kb_articles(category) WHERE is_published = 1;

-- FTS for KB articles
CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
    id UNINDEXED, title, content, summary, tags,
    content='kb_articles', content_rowid='rowid',
    tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS kb_ai AFTER INSERT ON kb_articles BEGIN
    INSERT INTO kb_fts(rowid, id, title, content, summary, tags)
    VALUES (new.rowid, new.id, new.title, new.content, new.summary, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS kb_ad AFTER DELETE ON kb_articles BEGIN
    INSERT INTO kb_fts(kb_fts, rowid, id, title, content, summary, tags)
    VALUES ('delete', old.rowid, old.id, old.title, old.content, old.summary, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS kb_au AFTER UPDATE ON kb_articles BEGIN
    INSERT INTO kb_fts(kb_fts, rowid, id, title, content, summary, tags)
    VALUES ('delete', old.rowid, old.id, old.title, old.content, old.summary, old.tags);
    INSERT INTO kb_fts(rowid, id, title, content, summary, tags)
    VALUES (new.rowid, new.id, new.title, new.content, new.summary, new.tags);
END;

-- ------------------------------------------------------------
-- 10. Ticket Tags (structured tagging in addition to AI tags)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tags (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL UNIQUE,
    color         TEXT DEFAULT '#6b7280',
    created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_tags (
    ticket_id     TEXT NOT NULL,
    tag_id        INTEGER NOT NULL,
    PRIMARY KEY (ticket_id, tag_id),
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ticket_tags_tag ON ticket_tags(tag_id);

-- ------------------------------------------------------------
-- 11. Customer Profiles (360 view)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_profiles (
    id            TEXT PRIMARY KEY,                       -- cus_<hash>
    email         TEXT NOT NULL UNIQUE,
    name          TEXT,
    company       TEXT,
    total_tickets INTEGER NOT NULL DEFAULT 0,
    open_tickets  INTEGER NOT NULL DEFAULT 0,
    last_contact_at TEXT,
    lifetime_value REAL DEFAULT 0,                        -- summed gross amount if relevant
    is_vip        INTEGER NOT NULL DEFAULT 0,
    notes         TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customers_email ON customer_profiles(email);

-- ------------------------------------------------------------
-- 12. Escalations
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS escalations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id     TEXT NOT NULL,
    level         INTEGER NOT NULL,                       -- 1, 2, 3
    reason        TEXT NOT NULL,                          -- sla_breach | manual | spam_false_negative | ...
    from_agent_id TEXT,
    to_agent_id   TEXT,
    to_team       TEXT,
    created_at    TEXT NOT NULL,
    resolved_at   TEXT,
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_escalations_ticket ON escalations(ticket_id);
CREATE INDEX IF NOT EXISTS idx_escalations_level ON escalations(level);

-- ------------------------------------------------------------
-- 13. Notifications (outbound: Slack / Teams / Email digest)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    type          TEXT NOT NULL,                          -- slack | teams | email | webhook
    target        TEXT NOT NULL,                          -- channel URL / email / webhook URL
    event         TEXT NOT NULL,                          -- ticket_created | sla_breach | escalation | spam_detected | ...
    ticket_id     TEXT,
    payload       TEXT,                                    -- JSON
    status        TEXT NOT NULL DEFAULT 'pending',        -- pending | sent | failed
    error         TEXT,
    attempts      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    sent_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_notif_status ON notifications(status);

-- ------------------------------------------------------------
-- 14. Notification Channels (configured destinations)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_channels (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    type          TEXT NOT NULL,                          -- slack | teams | email | webhook
    target        TEXT NOT NULL,                          -- URL or email
    events        TEXT NOT NULL,                          -- JSON array of events to subscribe
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL
);

-- ------------------------------------------------------------
-- 15. Saved Filters (for power users)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saved_filters (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    agent_id      TEXT,
    query_json    TEXT NOT NULL,                          -- JSON: {status, priority, ...}
    is_shared     INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- ------------------------------------------------------------
-- 16. Metrics snapshot (for time-series dashboards)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS metrics_snapshot (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    bucket        TEXT NOT NULL,                          -- hour | day
    bucket_start  TEXT NOT NULL,                          -- ISO 8601 truncated
    open_count    INTEGER NOT NULL DEFAULT 0,
    in_progress   INTEGER NOT NULL DEFAULT 0,
    resolved_count INTEGER NOT NULL DEFAULT 0,
    rejected_count INTEGER NOT NULL DEFAULT 0,
    created_count INTEGER NOT NULL DEFAULT 0,
    sla_breached_count INTEGER NOT NULL DEFAULT 0,
    avg_confidence REAL DEFAULT 0,
    by_category_json TEXT,                                -- JSON
    by_priority_json TEXT,
    by_team_json   TEXT,
    created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metrics_bucket ON metrics_snapshot(bucket, bucket_start);

-- ============================================================
-- v3 PRODUCTION TABLES — advanced operations
-- ============================================================

-- ------------------------------------------------------------
-- 17. Macros (canned response templates with variables)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS macros (
    id            TEXT PRIMARY KEY,                       -- mac-<uuid>
    name          TEXT NOT NULL,
    description   TEXT,
    subject_template TEXT,                                -- optional subject template
    body_template TEXT NOT NULL,                          -- template with {{variables}}
    category      TEXT,                                    -- restrict to category (nullable = all)
    team          TEXT,                                    -- restrict to team (nullable = all)
    tags          TEXT,                                    -- JSON array of tags for filtering
    is_active     INTEGER NOT NULL DEFAULT 1,
    usage_count   INTEGER NOT NULL DEFAULT 0,
    author_id     TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    FOREIGN KEY (author_id) REFERENCES agents(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_macros_category ON macros(category) WHERE is_active = 1;
CREATE INDEX IF NOT EXISTS idx_macros_team ON macros(team) WHERE is_active = 1;

-- ------------------------------------------------------------
-- 18. SLA Policies (per-customer / per-category overrides)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sla_policies (
    id            TEXT PRIMARY KEY,                       -- sla-<uuid>
    name          TEXT NOT NULL,
    priority      TEXT,                                    -- apply to this priority (nullable = all)
    category      TEXT,                                    -- apply to this category (nullable = all)
    customer_id   TEXT,                                    -- apply to this customer (nullable = all)
    is_vip_only   INTEGER NOT NULL DEFAULT 0,
    response_hours  INTEGER,                               -- override SLA_CRITICAL etc.
    resolution_hours INTEGER,
    business_hours_only INTEGER NOT NULL DEFAULT 0,        -- 1 = skip weekends/off-hours
    timezone      TEXT DEFAULT 'UTC',
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    FOREIGN KEY (customer_id) REFERENCES customer_profiles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sla_policies_lookup ON sla_policies(priority, category, customer_id) WHERE is_active = 1;

-- ------------------------------------------------------------
-- 19. Workflow Rules (if-then automation engine)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workflow_rules (
    id            TEXT PRIMARY KEY,                       -- wf-<uuid>
    name          TEXT NOT NULL,
    description   TEXT,
    trigger_event TEXT NOT NULL,                          -- ticket_created | ticket_updated | status_changed | priority_changed | sla_breach | note_added
    conditions    TEXT NOT NULL,                          -- JSON array of {field, op, value}
    actions       TEXT NOT NULL,                          -- JSON array of {type, params}
    priority      INTEGER NOT NULL DEFAULT 100,           -- execution order (lower = first)
    is_active     INTEGER NOT NULL DEFAULT 1,
    execution_count INTEGER NOT NULL DEFAULT 0,
    last_executed_at TEXT,
    last_error    TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wf_rules_trigger ON workflow_rules(trigger_event) WHERE is_active = 1;

-- ------------------------------------------------------------
-- 20. Workflow Execution Log
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workflow_executions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id       TEXT NOT NULL,
    ticket_id     TEXT NOT NULL,
    trigger_event TEXT NOT NULL,
    status        TEXT NOT NULL,                          -- success | failed | skipped
    error         TEXT,
    actions_taken TEXT,                                    -- JSON
    created_at    TEXT NOT NULL,
    FOREIGN KEY (rule_id) REFERENCES workflow_rules(id) ON DELETE CASCADE,
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_wf_exec_rule ON workflow_executions(rule_id);
CREATE INDEX IF NOT EXISTS idx_wf_exec_ticket ON workflow_executions(ticket_id);

-- ------------------------------------------------------------
-- 21. Custom Fields (user-defined fields per ticket)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS custom_fields (
    id            TEXT PRIMARY KEY,                       -- cf-<uuid>
    name          TEXT NOT NULL,
    label         TEXT NOT NULL,
    type          TEXT NOT NULL,                          -- text | number | date | select | multiselect | boolean | url | email
    options       TEXT,                                    -- JSON array for select/multiselect
    default_value TEXT,
    is_required   INTEGER NOT NULL DEFAULT 0,
    is_filterable INTEGER NOT NULL DEFAULT 1,
    applies_to_category TEXT,                              -- restrict to category (nullable = all)
    sort_order    INTEGER NOT NULL DEFAULT 0,
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cf_active ON custom_fields(is_active, sort_order);

-- ------------------------------------------------------------
-- 22. Custom Field Values (per-ticket values)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS custom_field_values (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id     TEXT NOT NULL,
    field_id      TEXT NOT NULL,
    value_text    TEXT,
    value_number  REAL,
    value_bool    INTEGER,
    updated_at    TEXT NOT NULL,
    UNIQUE(ticket_id, field_id),
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
    FOREIGN KEY (field_id) REFERENCES custom_fields(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cfv_ticket ON custom_field_values(ticket_id);
CREATE INDEX IF NOT EXISTS idx_cfv_field ON custom_field_values(field_id);

-- ------------------------------------------------------------
-- 23. Scheduled Reports (email daily/weekly summaries)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scheduled_reports (
    id            TEXT PRIMARY KEY,                       -- sr-<uuid>
    name          TEXT NOT NULL,
    description   TEXT,
    frequency     TEXT NOT NULL,                          -- daily | weekly | monthly
    day_of_week   INTEGER,                                 -- 0=Sun..6=Sat (for weekly)
    day_of_month  INTEGER,                                 -- 1-31 (for monthly)
    hour          INTEGER NOT NULL DEFAULT 9,              -- 0-23 UTC
    recipient_emails TEXT NOT NULL,                       -- JSON array
    filters_json  TEXT,                                    -- JSON: {status, priority, team, ...}
    format        TEXT NOT NULL DEFAULT 'html',           -- html | csv | json
    last_run_at   TEXT,
    next_run_at   TEXT NOT NULL,
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sr_next_run ON scheduled_reports(next_run_at) WHERE is_active = 1;

-- ------------------------------------------------------------
-- 24. Webhook Subscriptions (outbound event delivery)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
    id            TEXT PRIMARY KEY,                       -- whsub-<uuid>
    name          TEXT NOT NULL,
    target_url    TEXT NOT NULL,
    secret        TEXT,                                    -- HMAC signing secret
    events        TEXT NOT NULL,                          -- JSON array of events
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription_id TEXT NOT NULL,
    event         TEXT NOT NULL,
    ticket_id     TEXT,
    payload       TEXT NOT NULL,                          -- JSON
    status        TEXT NOT NULL DEFAULT 'pending',        -- pending | delivered | failed
    attempts      INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TEXT,
    response_status INTEGER,
    response_body TEXT,
    created_at    TEXT NOT NULL,
    delivered_at  TEXT,
    FOREIGN KEY (subscription_id) REFERENCES webhook_subscriptions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_whdel_status ON webhook_deliveries(status);

-- ------------------------------------------------------------
-- 25. Ticket Threads (conversation threading)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_threads (
    id            TEXT PRIMARY KEY,                       -- thr-<uuid>
    subject       TEXT,
    customer_id   TEXT,                                    -- link to customer_profiles
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

-- Link table: tickets to threads (many tickets can belong to one thread)
CREATE TABLE IF NOT EXISTS ticket_thread_map (
    ticket_id     TEXT PRIMARY KEY,
    thread_id     TEXT NOT NULL,
    position      INTEGER NOT NULL DEFAULT 0,             -- order in thread
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
    FOREIGN KEY (thread_id) REFERENCES ticket_threads(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ttm_thread ON ticket_thread_map(thread_id);

-- ------------------------------------------------------------
-- 26. Snoozes (snooze a ticket until a future time)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_snoozes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id     TEXT NOT NULL,
    snoozed_until TEXT NOT NULL,                          -- ISO 8601
    reason        TEXT,
    snoozed_by    TEXT NOT NULL,                          -- agent:<id> | system
    woke_at       TEXT,                                    -- when snooze ended (nullable if still active)
    created_at    TEXT NOT NULL,
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_snooze_active ON ticket_snoozes(ticket_id) WHERE woke_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_snooze_until ON ticket_snoozes(snoozed_until) WHERE woke_at IS NULL;

-- ------------------------------------------------------------
-- 27. Translations (cached AI translations)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_translations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id     TEXT NOT NULL,
    target_language TEXT NOT NULL,                        -- ISO 639-1
    translated_subject TEXT,
    translated_body TEXT,
    model         TEXT,                                    -- which AI model produced this
    created_at    TEXT NOT NULL,
    UNIQUE(ticket_id, target_language),
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_trans_ticket ON ticket_translations(ticket_id);

-- ------------------------------------------------------------
-- 28. System Settings (key-value config store)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_settings (
    key           TEXT PRIMARY KEY,
    value         TEXT NOT NULL,
    description   TEXT,
    category      TEXT DEFAULT 'general',
    is_sensitive  INTEGER NOT NULL DEFAULT 0,
    updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by    TEXT
);

-- Seed default settings
INSERT OR IGNORE INTO system_settings (key, value, description, category) VALUES
    ('brand.name', 'AI Support Desk', 'Brand name shown in UI', 'branding'),
    ('brand.primary_color', '#4f46e5', 'Primary UI color hex', 'branding'),
    ('tickets.auto_assign', 'true', 'Auto-assign best agent on ticket creation', 'tickets'),
    ('tickets.auto_acknowledge', 'true', 'Send acknowledgment email automatically', 'tickets'),
    ('tickets.default_status', 'Open', 'Default status for new tickets', 'tickets'),
    ('tickets.allow_reopen', 'true', 'Allow reopening Resolved tickets within 7 days', 'tickets'),
    ('tickets.reopen_window_hours', '168', 'Hours after resolution during which reopen is allowed', 'tickets'),
    ('ai.auto_translate', 'false', 'Auto-translate non-English tickets to English', 'ai'),
    ('ai.confidence_threshold', '60', 'Below this confidence, flag for human review', 'ai'),
    ('notifications.notify_on_critical', 'true', 'Notify when Critical ticket is created', 'notifications'),
    ('security.ip_allowlist', '', 'Comma-separated IPs allowed to call webhooks', 'security'),
    ('security.require_https', 'false', 'Reject non-HTTPS requests in production', 'security');
