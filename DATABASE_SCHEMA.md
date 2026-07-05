# Database Schema (v2)

The system uses SQLite (`better-sqlite3`) with FTS5 full-text search.
The schema is portable to Postgres / MySQL / Airtable / Notion / NocoDB — the
column types and names are deliberately standard.

**DDL file**: `src/database/schema.sql` (applied automatically on first boot).

**v2 highlights**: 16 tables, 2 FTS5 virtual tables with auto-sync triggers,
indexes on every hot query path.

---

## ER overview

```
tickets 1───* attachments
        1───* audit_trail
        1───* ticket_notes
        1───* ticket_tags *──1 tags
        1───* escalations
        1───? tickets (duplicate_of self-reference)
        ?───1 customer_profiles
        ?───1 agents (assigned_agent_id)

agents 1───* api_keys
agents 1───* tickets (assigned_agent_id)

kb_articles (standalone, FTS5-indexed)
routing_config (standalone, editable)
inbox_log (standalone)
notifications (standalone audit)
notification_channels (standalone config)
saved_filters (?──1 agents)
metrics_snapshot (standalone time-series)
```

---

## Table: `tickets` (40+ columns)

The main ticket table. Every column required by the assignment is present
plus extras for SLA, audit, duplicate detection, AI insights, PII, spam, and customer 360.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | Human-friendly ID, format `TKT-YYYYMMDD-XXXX` |
| `customer_name` | TEXT | Sender's full name |
| `company` | TEXT | Sender's company (inferred by AI) |
| `sender_email` | TEXT NOT NULL | Customer's email address |
| `sender_name` | TEXT | Display name from the inbound email |
| `email_subject` | TEXT | Original subject line |
| `email_body` | TEXT | Original plain-text body |
| `issue_summary` | TEXT | AI-generated one-sentence summary |
| `detailed_description` | TEXT | AI-generated 2–4 sentence description |
| `category` | TEXT | One of 8 categories |
| `priority` | TEXT | Critical / High / Medium / Low |
| `sentiment` | TEXT | Positive / Neutral / Negative |
| `product_service` | TEXT | Product / plan / service mentioned |
| `suggested_department` | TEXT | AI's recommended team |
| `suggested_tags` | TEXT | JSON array of 1–6 kebab-case tags |
| `confidence_score` | REAL | 0–100 — AI confidence |
| `assigned_team` | TEXT | Resolved team |
| `assigned_agent_id` | TEXT FK → agents.id | Workload-balanced agent |
| `status` | TEXT | Open / In Progress / Waiting for Customer / Resolved / Closed / Rejected / **Spam** |
| `internal_notes` | TEXT | Latest agent note (full history in `ticket_notes`) |
| `received_at` | TEXT | ISO 8601 — when the email arrived |
| `last_updated` | TEXT | ISO 8601 — last state change |
| `first_response_at` | TEXT | ISO 8601 — when agent first responded (set on status → In Progress) |
| `resolved_at` | TEXT | ISO 8601 — when ticket was resolved/closed |
| `acknowledged` | INTEGER | 0/1 — whether the ack email was sent |
| `acknowledged_at` | TEXT | ISO 8601 |
| `sla_due_at` | TEXT | ISO 8601 — computed from priority SLA |
| `sla_breached` | INTEGER | 0/1 — set by escalation sweeper |
| `escalated` | INTEGER | 0/1 — currently escalated |
| `escalated_at` | TEXT | ISO 8601 — when first escalated |
| `escalation_level` | INTEGER | 0/1/2/3 — current escalation level |
| `language` | TEXT | ISO 639-1 (en, es, fr, de, it, pt, ja, zh, ko, ar, hi, ru) |
| `is_spam` | INTEGER | 0/1 — flagged as spam (above threshold) |
| `spam_score` | REAL | 0–100 |
| `pii_redacted_body` | TEXT | Body with PII replaced by `[REDACTED_EMAIL]` etc. |
| `ai_resolution_suggestion` | TEXT | Cached JSON of `suggestResolution` output |
| `ai_kb_article_ids` | TEXT | JSON array of suggested KB article IDs |
| `raw_ai_response` | TEXT | Full LLM JSON output (for audit/debug) |
| `source` | TEXT | `email` / `webhook` / `manual` / `api` |
| `duplicate_of` | TEXT FK → tickets.id | Set when this ticket is a duplicate |
| `customer_id` | TEXT FK → customer_profiles.id | Linked customer profile |
| `created_at` | TEXT | ISO 8601 |
| `updated_at` | TEXT | ISO 8601 |

**Indexes**: status, priority, category, assigned_team, assigned_agent_id,
received_at, sender_email, customer_id, escalated (partial), is_spam (partial),
sla_due_at (partial — only open tickets).

---

## Table: `tickets_fts` (FTS5 virtual table)

Full-text search index over ticket subject + body + summary + customer_name + sender_email.

- **Tokenizer**: `porter unicode61` — Porter stemming + Unicode-aware
- **Sync**: automatic via `tickets_ai` / `tickets_ad` / `tickets_au` triggers
- **Query**: `SELECT * FROM tickets_fts WHERE tickets_fts MATCH 'word1 word2' ORDER BY bm25(tickets_fts)`
- **API**: `GET /api/tickets/search?q=...`

---

## Table: `attachments`

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | `att-<uuid>` |
| `ticket_id` | TEXT FK → tickets.id | Owning ticket |
| `filename` | TEXT | Original filename |
| `mime_type` | TEXT | MIME type |
| `size_bytes` | INTEGER | File size |
| `storage_path` | TEXT | Relative path under `uploads/` |
| `created_at` | TEXT | ISO 8601 |

---

## Table: `audit_trail` (append-only)

**No `UPDATE` or `DELETE` ever targets this table.** Every state change is recorded here.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `ticket_id` | TEXT FK → tickets.id | |
| `action` | TEXT | `created`, `classified`, `assigned`, `acknowledged`, `status_changed`, `priority_changed`, `category_changed`, `note_added`, `edited`, `duplicated`, `escalated`, `escalation_cleared` |
| `field` | TEXT | Which field changed |
| `old_value` | TEXT | Previous value |
| `new_value` | TEXT | New value |
| `actor` | TEXT | `system` / `ai` / `agent:<id>` / `system:bulk` / `system:escalator` |
| `metadata` | TEXT | JSON blob with extra context |
| `created_at` | TEXT | ISO 8601 |

**Indexes**: ticket_id, action, actor, created_at.

---

## Table: `ticket_notes`

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `ticket_id` | TEXT FK → tickets.id | |
| `author` | TEXT | `system` / `agent:<id>` |
| `note` | TEXT | Note content |
| `is_internal` | INTEGER | 1=internal, 0=visible to customer |
| `created_at` | TEXT | ISO 8601 |

---

## Table: `routing_config`

Editable category → team mapping.

| Column | Type | Description |
|--------|------|-------------|
| `category` | TEXT PK | One of the 8 categories |
| `team` | TEXT | Target team name |
| `is_active` | INTEGER | 0/1 — soft-disable |

Default seed covers all 8 categories. Editable via `PUT /api/routing/:category`.

---

## Table: `inbox_log`

Every inbound message — processed, skipped, or failed — is logged here.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `message_id` | TEXT | RFC 822 Message-ID |
| `sender_email` | TEXT | |
| `subject` | TEXT | |
| `received_at` | TEXT | ISO 8601 |
| `status` | TEXT | `processed` / `skipped` / `failed` |
| `reason` | TEXT | Why it was skipped/failed |
| `ticket_id` | TEXT | FK if a ticket was created |
| `is_spam` | INTEGER | 0/1 |
| `created_at` | TEXT | ISO 8601 |

---

## Table: `agents` (NEW in v2)

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | `agt-<uuid>` (system agent = `agt-system`) |
| `name` | TEXT | Display name |
| `email` | TEXT UNIQUE | Agent email |
| `team` | TEXT | Technical Support / Finance / Sales / Customer Success / Product Team |
| `role` | TEXT | `admin` / `agent` / `viewer` |
| `is_active` | INTEGER | 0/1 |
| `max_concurrent` | INTEGER | Workload cap (default 25) |
| `skills` | TEXT | JSON array of categories the agent can handle |
| `timezone` | TEXT | IANA timezone (default UTC) |
| `created_at` / `updated_at` | TEXT | ISO 8601 |

**Seed**: `agt-system` admin agent is created on first boot.

---

## Table: `api_keys` (NEW in v2)

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | `key-<uuid>` |
| `agent_id` | TEXT FK → agents.id | Owning agent |
| `key_hash` | TEXT UNIQUE | SHA-256 hash of the plaintext key |
| `key_prefix` | TEXT | First 12 chars of plaintext (for identification in UI) |
| `name` | TEXT | Human label (e.g. "postman", "ci-bot") |
| `last_used_at` | TEXT | ISO 8601 (updated on each request) |
| `expires_at` | TEXT | ISO 8601 (nullable = never) |
| `is_active` | INTEGER | 0/1 |
| `created_at` | TEXT | ISO 8601 |

Plaintext keys are formatted `sk_live_<48 hex chars>` and shown only once on creation.

---

## Table: `kb_articles` (NEW in v2)

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | `kb-<uuid>` |
| `title` | TEXT | Article title |
| `slug` | TEXT UNIQUE | URL-safe slug (auto-generated from title + ID suffix) |
| `content` | TEXT | Markdown content |
| `summary` | TEXT | One-line summary for cards |
| `category` | TEXT | One of the 8 categories |
| `tags` | TEXT | JSON array |
| `view_count` | INTEGER | Incremented on each view |
| `helpful_count` | INTEGER | Incremented when agent marks helpful |
| `is_published` | INTEGER | 0/1 |
| `author_id` | TEXT FK → agents.id | Author |
| `created_at` / `updated_at` | TEXT | ISO 8601 |

---

## Table: `kb_fts` (FTS5 virtual table, NEW in v2)

Full-text search index over KB article title + content + summary + tags.
Same trigger pattern as `tickets_fts`.

---

## Table: `tags` (NEW in v2)

Structured tagging (separate from AI-suggested `suggested_tags` JSON).

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `name` | TEXT UNIQUE | Lowercase tag name |
| `color` | TEXT | Hex color (default `#6b7280`) |
| `created_at` | TEXT | ISO 8601 |

---

## Table: `ticket_tags` (NEW in v2)

Many-to-many junction between tickets and tags.

| Column | Type | Description |
|--------|------|-------------|
| `ticket_id` | TEXT FK → tickets.id | |
| `tag_id` | INTEGER FK → tags.id | |
| | PRIMARY KEY (ticket_id, tag_id) | |

---

## Table: `customer_profiles` (NEW in v2)

Aggregated customer view.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | `cus_<sha1-prefix>` (deterministic from email) |
| `email` | TEXT UNIQUE | Lowercased email |
| `name` | TEXT | Latest known name |
| `company` | TEXT | Latest known company |
| `total_tickets` | INTEGER | Counter |
| `open_tickets` | INTEGER | Counter (decremented on resolve/close) |
| `last_contact_at` | TEXT | ISO 8601 |
| `lifetime_value` | REAL | Summed gross amount if relevant |
| `is_vip` | INTEGER | 0/1 |
| `notes` | TEXT | Free-form notes about the customer |
| `created_at` / `updated_at` | TEXT | ISO 8601 |

---

## Table: `escalations` (NEW in v2)

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `ticket_id` | TEXT FK → tickets.id | |
| `level` | INTEGER | 1, 2, or 3 |
| `reason` | TEXT | `sla_breach (Xmin overdue)` / `manual` / ... |
| `from_agent_id` | TEXT FK → agents.id | Agent who had it before escalation |
| `to_agent_id` | TEXT FK → agents.id | New agent (nullable) |
| `to_team` | TEXT | Team to notify |
| `created_at` | TEXT | ISO 8601 |
| `resolved_at` | TEXT | ISO 8601 (nullable, set when ticket leaves escalation) |

---

## Table: `notifications` (NEW in v2)

Audit log of every outbound notification.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `type` | TEXT | `slack` / `teams` / `email` / `webhook` |
| `target` | TEXT | URL or email |
| `event` | TEXT | `ticket_created` / `critical_priority` / `sla_breach` / `escalation` / `spam_detected` / `ticket_resolved` |
| `ticket_id` | TEXT | FK (nullable) |
| `payload` | TEXT | JSON context |
| `status` | TEXT | `pending` / `sent` / `failed` |
| `error` | TEXT | Error message if failed |
| `attempts` | INTEGER | Number of send attempts |
| `created_at` / `sent_at` | TEXT | ISO 8601 |

---

## Table: `notification_channels` (NEW in v2)

Configured destinations (DB-backed; env vars are an alternative).

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | `ch-<uuid>` |
| `name` | TEXT | Human label |
| `type` | TEXT | `slack` / `teams` / `email` / `webhook` |
| `target` | TEXT | URL or email |
| `events` | TEXT | JSON array of subscribed events |
| `is_active` | INTEGER | 0/1 |
| `created_at` | TEXT | ISO 8601 |

---

## Table: `saved_filters` (NEW in v2)

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | |
| `name` | TEXT | Filter name |
| `agent_id` | TEXT FK → agents.id | Owner (nullable = shared) |
| `query_json` | TEXT | JSON: `{status, priority, ...}` |
| `is_shared` | INTEGER | 0/1 |
| `created_at` | TEXT | ISO 8601 |

---

## Table: `metrics_snapshot` (NEW in v2)

Periodic snapshots for time-series dashboards.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `bucket` | TEXT | `hour` / `day` |
| `bucket_start` | TEXT | ISO 8601 truncated |
| `open_count` | INTEGER | |
| `in_progress` | INTEGER | |
| `resolved_count` | INTEGER | |
| `rejected_count` | INTEGER | |
| `created_count` | INTEGER | |
| `sla_breached_count` | INTEGER | |
| `avg_confidence` | REAL | |
| `by_category_json` / `by_priority_json` / `by_team_json` | TEXT | JSON breakdowns |
| `created_at` | TEXT | ISO 8601 |

---

## Mapping to assignment requirements

All required columns are present (and many more):

| Required column | Our column |
|-----------------|------------|
| Ticket ID | `id` |
| Customer Name | `customer_name` |
| Company | `company` |
| Sender Email | `sender_email` |
| Email Subject | `email_subject` |
| Email Body | `email_body` (+ `pii_redacted_body`) |
| Issue Summary | `issue_summary` |
| Category | `category` |
| Priority | `priority` |
| Sentiment | `sentiment` |
| Product | `product_service` |
| Suggested Department | `suggested_department` (+ `assigned_team`) |
| Tags | `suggested_tags` (JSON) + `tags`/`ticket_tags` (structured) |
| Confidence Score | `confidence_score` |
| Assigned Team | `assigned_team` (+ `assigned_agent_id`) |
| Status | `status` (includes `Spam`) |
| Internal Notes | `internal_notes` (full history in `ticket_notes`) |
| Attachments | `attachments` table |
| Received At | `received_at` |
| Last Updated | `last_updated` |

**Plus extras for production hardening**: `acknowledged`, `acknowledged_at`,
`first_response_at`, `resolved_at`, `sla_due_at`, `sla_breached`, `escalated`,
`escalated_at`, `escalation_level`, `language`, `is_spam`, `spam_score`,
`pii_redacted_body`, `ai_resolution_suggestion`, `ai_kb_article_ids`,
`raw_ai_response`, `source`, `duplicate_of`, `customer_id`.

---

## Portability notes

- **Postgres**: change `INTEGER PRIMARY KEY AUTOINCREMENT` to `SERIAL` / `BIGSERIAL`, `TEXT` → `TEXT`, `REAL` → `DOUBLE PRECISION`. FTS5 → `tsvector` + `tsquery` with GIN indexes. Add `NOW()` defaults.
- **MySQL**: same as Postgres but `DATETIME(3)` for timestamps. FTS5 → `FULLTEXT` index.
- **Airtable**: create one table per logical entity; `suggested_tags` becomes a multi-select; `audit_trail` becomes a linked record to `tickets`; FTS not needed (Airtable has built-in search).
- **Notion**: similar to Airtable; use a database per entity.
- **NocoDB**: import the SQLite file directly, or replay `schema.sql` (NocoDB accepts ANSI SQL — drop the FTS5 virtual tables and triggers).
