# AI Customer Support Ticket Automation v3

> Production-grade AI workflow that ingests customer support emails, classifies
> them with an LLM (xAI **Grok** by default, also supports OpenAI / Claude /
> Gemini / Groq / local), prioritises & routes them, sends acknowledgments,
> runs SLA escalation, detects spam, redacts PII, suggests KB articles (RAG),
> and tracks the full ticket lifecycle with an immutable audit trail.
>
> **v3 adds**: macros, SLA policies, workflow rules engine, custom fields,
> scheduled reports, outbound webhooks (HMAC-signed), translations, ticket
> similarity, snoozes, threading, audit log search, backup/restore, deep
> health checks, system settings, and 3 comprehensive test suites.

Built for **Round 3 — Task 4** of the AI Engineer technical assignment.
Upgraded through v1 → v2 (Grok + RAG + agents + escalations + customer 360)
→ **v3** (macros + SLA policies + workflow rules + custom fields + scheduled
reports + outbound webhooks + translations + ticket similarity + snoozes +
threading + audit search + backup/restore + deep health + system settings).

---

## What it does (v2 — production-grade)

### Core pipeline (Step 1 → Step 10 of the assignment)
| Step | What happens | Where in the code |
|------|--------------|-------------------|
| 1. Email Monitoring | Inbound emails via JSON webhook or `.eml` upload | `src/services/emailService.js`, `src/routes/webhooks.js` |
| 2. AI Ticket Analysis | LLM call with strict JSON contract | `src/services/aiService.js` |
| 3. Classification | 8 categories, validated + coerced | `src/utils/validator.js` |
| 4. Priority Detection | Critical / High / Medium / Low | `aiService.js` system prompt |
| 5. Data Validation | Safe JSON, enum coercion, dedup, email validation, malformed-response repair | `aiService.js`, `validator.js` |
| 6. Create Support Ticket | Persisted to SQLite; default `Open` | `src/services/ticketService.js` |
| 7. Automatic Assignment | Category → team → **best agent** (workload-balanced) | `routingService.js`, `agentService.js` |
| 8. Customer Acknowledgment | HTML + plain-text ack via SMTP (logged when disabled) | `src/services/ackService.js` |
| 9. Manual Agent Review | Web UI: edit fields, change status/priority/category, reassign, add notes, AI insights | `public/ticket.html`, `src/routes/api.js` |
| 10. Ticket Resolution Workflow | Open → In Progress → Waiting for Customer → Resolved → Closed (audited) | `ticketService.transitionStatus` |

### v2 advanced operations (NEW)

| Feature | Description |
|---------|-------------|
| **🤖 xAI Grok integration** | Default provider. Set `AI_PROVIDER=grok` + `GROK_API_KEY=xai-...` and you're live. Also supports OpenAI / Claude / Gemini / Groq / local. |
| **🛡️ Spam detection** | AI scores every email 0–100. Above `SPAM_THRESHOLD=70` → flagged; above `SPAM_AUTO_REJECT=90` → rejected entirely (no ticket created). |
| **🌍 Multi-language detection** | AI returns ISO 639-1 code (en, es, fr, de, it, pt, ja, zh, ko, ar, hi, ru). Dashboard shows language distribution. |
| **🔒 PII redaction** | All emails, phones, credit cards, SSNs, IBANs, and IPs are redacted into a separate `pii_redacted_body` column safe for external sharing. |
| **📚 Knowledge Base (RAG)** | Markdown articles with FTS5 search. AI suggests up to 3 articles per ticket based on category + tag + keyword overlap. |
| **🤖 AI Resolution Plan** | One-click `POST /api/tickets/:id/suggest-resolution` returns diagnosis, ordered steps, estimated effort, engineering flag, confidence. |
| **🤖 AI Reply Draft** | One-click `POST /api/tickets/:id/suggest-reply` generates a customer-facing reply grounded in suggested KB articles. |
| **👥 Agent directory + workload balancing** | Create agents, assign skills, generate API keys. New tickets auto-assign to the agent with fewest open tickets & matching skill. |
| **🔑 Agent API keys (SHA-256 hashed)** | Issue `sk_live_...` keys per agent. Role-based access (admin / agent / viewer). |
| **⏰ SLA escalation engine** | Background sweeper (every 5 min) auto-escalates overdue tickets through 3 configurable levels: notify team → notify lead → notify admins. |
| **🔔 Multi-channel notifications** | Slack, Microsoft Teams, generic webhooks, email digest. Configure via env vars or DB-backed channels. Fires on `ticket_created`, `critical_priority`, `sla_breach`, `escalation`, `spam_detected`, `ticket_resolved`. |
| **👤 Customer 360** | Auto-built customer profile aggregating every ticket from the same email. View total/open tickets, last contact, VIP flag, lifetime value, sentiment trend. |
| **📊 Advanced analytics** | Time-series (created vs resolved per day), agent leaderboard, team workload, SLA compliance by priority, sentiment trend, spam stats, response/resolution times. |
| **📦 Bulk operations** | Mass-update status / priority / category / agent, bulk-close, bulk-tag, CSV export, JSON import. |
| **🏷️ Structured tags** | Custom tags table with colors, in addition to AI-suggested tags. |
| **🔎 Full-text search** | SQLite FTS5 across ticket subject + body + summary + customer. `GET /api/tickets/search?q=...` |
| **📈 Prometheus metrics** | `GET /api/metrics` exposes counters + gauges in Prometheus exposition format. |
| **🧾 Audit trail** | Append-only `audit_trail` table records every state change with old/new values and actor. |
| **🔀 Duplicate ticket merging** | Merge a duplicate into its parent (copies notes, closes child, links parent). |

### v3 advanced operations (NEW)

| Feature | Description |
|---------|-------------|
| **📝 Macros (canned responses)** | Pre-written reply templates with `{{variables}}` auto-filled from ticket context (customer_name, ticket_id, category, custom fields, etc.). Scoped to category/team. Usage tracking. |
| **⏰ SLA policies** | Per-customer / per-category / per-priority SLA overrides with business-hours awareness. VIP customers get tighter SLAs. Skips weekends/off-hours when configured. |
| **⚙️ Workflow rules engine** | If-then automation: 10 trigger events (ticket_created, status_changed, sla_breach, note_added, etc.), 12 condition operators (eq, neq, in, contains, regex, is_set, ...), 12 action types (set_priority, add_tag, escalate, send_notification, call_webhook, ...). Execution logged for audit. |
| **🏷️ Custom fields** | User-defined fields per ticket (text, number, date, select, multiselect, boolean, url, email). Required validation, filterable, scoped to category. Used in macro templates via `{{custom.field_name}}`. |
| **📅 Scheduled reports** | Daily/weekly/monthly email summaries with ticket filters. HTML/CSV/JSON formats. Background sweeper dispatches due reports and reschedules. |
| **🔗 Outbound webhooks** | Subscribe external systems to 12 event types. HMAC-SHA256 signed payloads. 5-attempt retry with exponential backoff (1s→5s→30s→2min→10min). Delivery audit log. |
| **🌍 AI translations** | Translate ticket subject + body to any of 28 languages. Cached per ticket+language pair. Auto-translate option for non-English tickets. |
| **🔍 Ticket similarity** | FTS5 + scoring finds similar past tickets (BM25 rank + category match + tag overlap + recency). Surfaces "customers with similar issues" and potential duplicates. |
| **💤 Snoozes** | Temporarily hide a ticket until a future time (e.g. "waiting for customer", "bug fix in next release"). Background sweeper auto-wakes expired snoozes. |
| **🧵 Threading** | Group related tickets from the same customer into conversation threads. Automatic (same customer + category + within 7 days) or manual. Merge threads. |
| **🔎 Audit log search** | Advanced filtering (ticketId, action, actor, field, value contains, date range) + CSV export + stats (top actors, action counts, activity timeseries). Retention purge. |
| **💾 Backup & restore** | SQLite VACUUM INTO backups (atomic, non-blocking). JSON export/import. VACUUM reclamation. Daily auto-backup. Restore requires server restart. |
| **🏥 Deep health checks** | 10 subsystem checks: database, AI provider, SMTP, filesystem, escalation engine, memory, system load, schema, background jobs. Returns 503 if any failing. |
| **⚙️ System settings** | Runtime-configurable key-value store (12 seeded defaults). Categories (branding, tickets, ai, notifications, security). Sensitive values redacted for non-admins. |
| **♻️ Retry & mock fallback** | LLM calls retry 3× with exponential backoff, then fall back to a deterministic rule-based mock — pipeline never breaks. |

---

## Tech stack

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | Node.js 18+ | Native `fetch`, fast startup. |
| Web framework | Express 4 | Battle-tested, minimal. |
| Database | SQLite (`better-sqlite3`) + FTS5 | Zero-config, ACID, full-text search built-in. Schema maps cleanly to Postgres / Airtable / Notion / NocoDB. |
| LLM | **xAI Grok** (default) — any OpenAI-compatible Chat Completions API | Grok, OpenAI, Azure OpenAI, OpenRouter (Claude), Gemini, Groq, local LM Studio / Ollama. |
| Email | `nodemailer` (SMTP) | Standard, portable. |
| Security | `helmet`, `cors`, `express-rate-limit`, SHA-256 hashed API keys | Sensible defaults. |
| Frontend | Plain HTML + CSS + vanilla JS | No build step, no framework. |

---

## Quick start (5 minutes)

```bash
# 1. Install dependencies
npm install

# 2. Configure — only 5 variables needed
cp .env.example .env
# Edit .env and fill in:
#   GROK_API_KEY=xai-xxxxxxxxxxxxxxxxxxxxxxxxxxxx       (https://console.x.ai)
#   SMTP_HOST=smtp.gmail.com
#   SMTP_PASS=your-app-password
#   SMTP_FROM="Support Desk <support@example.com>"
#   PORT=3000

# 3. Start the server
npm start

# 4. Open the dashboard
#    http://localhost:3000
```

The first run automatically creates `data/support.db` and applies the schema.

### Required environment variables (only 5)

| Variable | Purpose | Example |
|----------|---------|---------|
| `PORT` | Server port | `3000` |
| `GROK_API_KEY` | xAI Grok API key (starts with `xai-`) | `xai-abc123...` |
| `SMTP_HOST` | SMTP server for acknowledgment emails | `smtp.gmail.com` |
| `SMTP_PASS` | SMTP password (use App Password for Gmail) | `your-app-password` |
| `SMTP_FROM` | Sender email shown to customers | `Support Desk <support@example.com>` |

> **Note**: `SMTP_USER` is auto-derived from `SMTP_FROM` if not set. For example, `SMTP_FROM="Support <support@x.com>"` → `SMTP_USER=support@x.com`.

> **No GROK_API_KEY?** The system runs in mock mode (rule-based AI) — all features work, just without real LLM calls. Perfect for demos and testing.

> **No SMTP?** Acknowledgment emails are logged to console instead of sent.

### Run with xAI Grok

```bash
# .env (minimal)
PORT=3000
GROK_API_KEY=xai-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
SMTP_HOST=smtp.gmail.com
SMTP_PASS=your-app-password
SMTP_FROM="Support Desk <support@example.com>"
```

Restart the server. The dashboard's AI status pill switches from `MOCK` to `xAI Grok — grok-2-latest`.

### Test inputs & expected outputs

See **[TEST_INPUTS.md](./TEST_INPUTS.md)** for 20 ready-to-use test cases with curl commands and expected JSON outputs.

### Run the end-to-end test

```bash
npm run test:e2e
```

Ingests all 12 sample emails through the full pipeline and reports:
- Classification accuracy (category + priority + language + spam)
- PII redaction success (5 patterns: email, credit card, SSN, IBAN, IP)
- Auto-assignment success (when agents exist)
- KB suggestion hit rate
- Customer 360 + reports endpoint sanity

Expected output: `✅ All tests passed.` with **12/12 (100%) accuracy**.

---

## Try the full flow

### Option A — one-click from the dashboard
1. Open <http://localhost:3000>.
2. Scroll to **One-Click Sample Test Ingestion**.
3. Click **Ingest →** on any sample.
4. The full pipeline runs and the new ticket appears in **Recent Tickets**.

### Option B — manual compose
1. <http://localhost:3000/compose.html> → fill in From / Subject / Body → **Run AI Pipeline**.

### Option C — `.eml` upload
1. <http://localhost:3000/compose.html> → pick a `.eml` file from `data/sample-emails/` → **Ingest .eml**.

### Option D — webhook (n8n / SendGrid / Mailgun)
```bash
curl -X POST 'http://localhost:3000/webhooks/email?token=change-me-in-production' \
  -H 'Content-Type: application/json' \
  -d '{
    "from": "John Doe <john@acme.com>",
    "subject": "Cannot login",
    "body": "I get a 500 error since this morning — urgent.",
    "receivedAt": "2026-07-05T10:00:00Z"
  }'
```

### Manual review (agent)
1. Click any ticket row.
2. Edit fields → **Save Changes** (audited).
3. Click **Auto-assign Best Agent** for workload-balanced assignment.
4. Click **Generate Resolution Plan** for AI diagnosis + steps.
5. Click **Draft Customer Reply** for a grounded customer response.
6. Click **Escalate** to manually escalate through SLA levels.
7. The **Audit Trail** panel shows every change with timestamps, old/new values, and actor.

### Agent management
1. <http://localhost:3000/agents.html> → create agents with team + skills.
2. Click **View** on any agent → **Generate New Key** to issue a `sk_live_...` API key.
3. Use the API key in `X-API-Key` header to call authenticated endpoints.
4. Enable auth by setting `AUTH_ENABLED=true` in `.env`.

### Knowledge Base
1. <http://localhost:3000/kb.html> → publish markdown articles with category + tags.
2. New tickets automatically get up to 3 KB article suggestions based on category + tag + keyword overlap.
3. Articles are surfaced in the AI Reply Draft and AI Resolution Plan prompts.

### Reports & Analytics
1. <http://localhost:3000/reports.html> → time-series chart, team workload, SLA compliance, agent leaderboard, spam stats.
2. `GET /api/metrics` → Prometheus exposition format for scraping.

---

## Project structure

```
ai-support-ticket-automation/
├── server.js                  # Entry point — boots Express + escalation sweeper
├── package.json
├── .env.example               # All configuration knobs (Grok, OpenAI, SMTP, etc.)
├── README.md                  # ← you are here
├── AI_PROMPTS.md              # Full prompt engineering documentation
├── DATABASE_SCHEMA.md         # Schema docs (16 tables)
├── workflow.json              # Exported workflow (n8n-equivalent DAG)
│
├── src/
│   ├── app.js                 # Express factory + escalation sweeper bootstrap
│   ├── config/index.js        # Multi-provider AI config (Grok/OpenAI/Claude/Gemini/Groq/local)
│   ├── database/
│   │   ├── schema.sql         # 16 tables + 2 FTS5 indexes + triggers
│   │   └── db.js              # better-sqlite3 wrapper
│   ├── services/
│   │   ├── aiService.js       # Multi-task LLM: analyze, spam, language, PII, KB, reply, resolution
│   │   ├── emailService.js    # .eml + webhook parser
│   │   ├── ticketService.js   # Orchestrator + manual review ops
│   │   ├── routingService.js  # Category → team
│   │   ├── ackService.js      # Acknowledgment email
│   │   ├── attachmentService.js
│   │   ├── auditService.js
│   │   ├── kbService.js       # Knowledge Base CRUD + FTS5 search
│   │   ├── agentService.js    # Agent directory + workload balancing + API keys
│   │   ├── customerService.js # Customer 360
│   │   ├── escalationService.js # SLA breach detection + auto-escalation
│   │   ├── notificationService.js # Slack/Teams/webhook/email digest
│   │   ├── reportService.js   # Time-series + agent leaderboard + SLA compliance
│   │   ├── bulkService.js     # Bulk update/assign/close/tag + CSV export + import
│   │   ├── authService.js     # API key middleware + role-based access
│   │   └── metricsService.js  # Prometheus metrics
│   ├── routes/
│   │   ├── api.js             # 60+ REST endpoints
│   │   └── webhooks.js        # Inbound email webhook
│   └── utils/
│       ├── logger.js          # Console + rotating file logger
│       ├── validator.js       # Pure validation/coercion helpers
│       └── helpers.js         # ID gen, SLA, retry, fingerprint
│
├── public/                    # Static frontend (no build step)
│   ├── index.html             # Dashboard (7 KPIs, 6 charts, SLA panel, samples, recent)
│   ├── tickets.html           # All tickets with filters + FTS search
│   ├── ticket.html            # Ticket detail + AI insights + manual review + escalations
│   ├── compose.html           # Ingest email (manual / .eml)
│   ├── agents.html            # Agent directory + workload + API keys
│   ├── kb.html                # Knowledge Base CRUD + FTS search
│   ├── reports.html           # Time-series + leaderboard + SLA + spam
│   └── assets/
│       ├── styles.css
│       ├── app.js             # Shared helpers + dashboard logic
│       ├── tickets.js
│       ├── ticket-detail.js
│       ├── compose.js
│       ├── agents.js
│       ├── kb.js
│       └── reports.js
│
├── data/
│   ├── sample-emails/         # 12 JSON samples + 2 .eml samples
│   │   ├── 01-critical-api-outage.json
│   │   ├── 02-billing-double-charge.json
│   │   ├── 03-bug-report-export.json
│   │   ├── 04-feature-request-csv.json
│   │   ├── 05-sales-inquiry-enterprise.json
│   │   ├── 06-account-access-2fa.json
│   │   ├── 07-ambiguous-short.json
│   │   ├── 08-spam-marketing.json              # spam auto-reject test
│   │   ├── 09-spanish-login.json                # multi-language (es)
│   │   ├── 10-pii-billing-dispute.json          # PII redaction test
│   │   ├── 11-furious-security-breach.json      # negative sentiment + Critical
│   │   ├── 12-french-feature-question.json      # multi-language (fr)
│   │   ├── sample-invoice-inquiry.eml
│   │   └── sample-with-attachment.eml
│   └── support.db             # Auto-created on first run
│
├── scripts/
│   ├── seed.js                # Optional: seed routing config / load samples
│   └── test-runner.js         # End-to-end test (12 samples, PII, reports, customer 360)
│
├── uploads/                   # Runtime attachment storage (gitignored)
└── logs/                      # Runtime logs (gitignored)
```

---

## REST API (60+ endpoints)

### Tickets
| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/tickets` | List with filters `?status&priority&category&team&agentId&isSpam&escalated&q&limit&offset` |
| `GET`  | `/api/tickets/search?q=...` | FTS5 full-text search |
| `GET`  | `/api/tickets/export.csv` | CSV export with filters |
| `GET`  | `/api/tickets/:id` | Ticket + audit + notes + attachments + tags + escalations |
| `PATCH`| `/api/tickets/:id` | Edit fields (audited) |
| `POST` | `/api/tickets/:id/notes` | Add internal note |
| `GET`  | `/api/tickets/:id/audit` | Audit trail |
| `GET`  | `/api/tickets/:id/attachments` | List attachments |
| `GET`  | `/api/tickets/:id/attachments/:attId` | Download attachment |
| `GET`  | `/api/tickets/:id/tags` | List structured tags |
| `POST` | `/api/tickets/:id/tags` | Add tag |
| `DELETE`| `/api/tickets/:id/tags/:tagId` | Remove tag |
| `POST` | `/api/tickets/:id/suggest-reply` | AI customer reply draft |
| `POST` | `/api/tickets/:id/suggest-resolution` | AI resolution plan |
| `POST` | `/api/tickets/:id/assign-best` | Auto-pick best agent |
| `POST` | `/api/tickets/:id/escalate` | Manual escalation |
| `POST` | `/api/tickets/:id/merge` | Merge into parent `{ parentId }` |

### Agents
| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/agents` | List agents |
| `POST` | `/api/agents` | Create agent |
| `GET`  | `/api/agents/:id` | Get agent |
| `PATCH`| `/api/agents/:id` | Update agent |
| `DELETE`| `/api/agents/:id` | Delete agent |
| `GET`  | `/api/agents/workload` | Workload + utilisation per agent |
| `GET`  | `/api/agents/leaderboard` | Performance metrics |
| `GET`  | `/api/agents/:id/api-keys` | List API keys |
| `POST` | `/api/agents/:id/api-keys` | Create API key (returns plaintext once) |
| `DELETE`| `/api/agents/:id/api-keys/:keyId` | Revoke API key |

### Knowledge Base
| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/kb` | List articles |
| `POST` | `/api/kb` | Create article |
| `GET`  | `/api/kb/search?q=...` | FTS5 search |
| `GET`  | `/api/kb/stats` | KB stats |
| `GET`  | `/api/kb/:id` | Get article |
| `PATCH`| `/api/kb/:id` | Update article |
| `DELETE`| `/api/kb/:id` | Delete article |
| `POST` | `/api/kb/:id/view` | Increment view count |
| `POST` | `/api/kb/:id/helpful` | Mark helpful |

### Customers
| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/customers` | List profiles |
| `GET`  | `/api/customers/:email` | 360 view (profile + tickets + sentiment + stats) |
| `POST` | `/api/customers/:email/vip` | Mark/unmark VIP |
| `PATCH`| `/api/customers/:email/notes` | Update notes |

### Routing
| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/routing` | Current category → team config |
| `PUT`  | `/api/routing/:category` | Update team for category |

### Notifications
| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/notifications/channels` | List channels |
| `POST` | `/api/notifications/channels` | Add channel (Slack/Teams/webhook/email) |
| `DELETE`| `/api/notifications/channels/:id` | Remove channel |
| `GET`  | `/api/notifications` | Audit log of sent notifications |

### Escalations
| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/escalations` | Currently escalated tickets |
| `POST` | `/api/escalations/sweep` | Manually run SLA sweep |

### Reports
| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/reports/full` | Master dashboard report |
| `GET`  | `/api/reports/timeseries?days=30` | Created vs resolved per day |
| `GET`  | `/api/reports/agents` | Agent leaderboard |
| `GET`  | `/api/reports/teams` | Team workload |
| `GET`  | `/api/reports/sla` | SLA compliance by priority |
| `GET`  | `/api/reports/spam` | Spam stats |
| `GET`  | `/api/reports/sentiment?days=30` | Sentiment trend |
| `GET`  | `/api/reports/response-times` | Avg first-response + resolution times |

### Bulk
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/bulk/update` | Mass update `{ ticketIds, patch }` |
| `POST` | `/api/bulk/assign` | Mass assign `{ ticketIds, agentId }` |
| `POST` | `/api/bulk/close` | Mass close `{ ticketIds }` |
| `POST` | `/api/bulk/tag` | Mass tag `{ ticketIds, tagName }` |
| `POST` | `/api/bulk/import` | Bulk import JSON array |
| `GET`  | `/api/bulk/export.csv` | CSV export (alias) |

### System
| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/health` | Health + AI/SMTP/auth/features status |
| `GET`  | `/api/metrics` | Prometheus exposition format |
| `GET`  | `/api/stats` | Dashboard KPIs |
| `GET`  | `/api/samples` | List sample emails |
| `POST` | `/api/samples/:filename/ingest` | One-click sample ingest |
| `POST` | `/api/ingest` | Public demo ingestion |
| `POST` | `/api/ingest/eml` | Public demo .eml upload |
| `GET`  | `/api/inbox-log` | Inbox processing log |
| `POST` | `/webhooks/email?token=...` | Production webhook (token-auth) |
| `POST` | `/webhooks/email/eml?token=...` | Production .eml upload (token-auth) |

### v3 API endpoints (`/api/v3/*`)

| Method | Path | Description |
|--------|------|-------------|
| **Macros** | | |
| `GET`  | `/api/v3/macros` | List macros (filter by category, team, search) |
| `GET`  | `/api/v3/macros/variables` | List available template variables |
| `POST` | `/api/v3/macros/validate` | Validate a template |
| `GET`  | `/api/v3/macros/:id` | Get macro |
| `POST` | `/api/v3/macros` | Create macro |
| `PATCH`| `/api/v3/macros/:id` | Update macro |
| `DELETE`| `/api/v3/macros/:id` | Delete macro |
| `POST` | `/api/v3/macros/:id/apply` | Apply macro to ticket (renders template) |
| **SLA Policies** | | |
| `GET`  | `/api/v3/sla-policies` | List policies |
| `POST` | `/api/v3/sla-policies` | Create policy |
| `GET`  | `/api/v3/sla-policies/:id` | Get policy |
| `PATCH`| `/api/v3/sla-policies/:id` | Update policy |
| `DELETE`| `/api/v3/sla-policies/:id` | Delete policy |
| `GET`  | `/api/v3/sla-policies/for-ticket/:ticketId` | Get applicable policy for a ticket |
| **Workflow Rules** | | |
| `GET`  | `/api/v3/workflows` | List rules |
| `GET`  | `/api/v3/workflows/events` | List trigger events, condition ops, action types |
| `POST` | `/api/v3/workflows` | Create rule |
| `GET`  | `/api/v3/workflows/:id` | Get rule |
| `PATCH`| `/api/v3/workflows/:id` | Update rule |
| `DELETE`| `/api/v3/workflows/:id` | Delete rule |
| `GET`  | `/api/v3/workflows/:id/executions` | Execution history for a rule |
| `POST` | `/api/v3/workflows/:id/test` | Test conditions against a ticket |
| **Custom Fields** | | |
| `GET`  | `/api/v3/custom-fields` | List field definitions |
| `POST` | `/api/v3/custom-fields` | Create field definition |
| `GET`  | `/api/v3/custom-fields/:id` | Get field definition |
| `PATCH`| `/api/v3/custom-fields/:id` | Update field definition |
| `DELETE`| `/api/v3/custom-fields/:id` | Delete field definition |
| `GET`  | `/api/v3/tickets/:ticketId/custom-fields` | Get all custom field values for a ticket |
| `PUT`  | `/api/v3/tickets/:ticketId/custom-fields/:fieldName` | Set a custom field value |
| **Scheduled Reports** | | |
| `GET`  | `/api/v3/scheduled-reports` | List reports |
| `POST` | `/api/v3/scheduled-reports` | Create report |
| `GET`  | `/api/v3/scheduled-reports/:id` | Get report |
| `PATCH`| `/api/v3/scheduled-reports/:id` | Update report |
| `DELETE`| `/api/v3/scheduled-reports/:id` | Delete report |
| `POST` | `/api/v3/scheduled-reports/:id/run` | Manually run a report |
| `POST` | `/api/v3/scheduled-reports/sweep` | Trigger the sweeper |
| **Outbound Webhooks** | | |
| `GET`  | `/api/v3/webhooks-out` | List subscriptions |
| `POST` | `/api/v3/webhooks-out` | Create subscription |
| `PATCH`| `/api/v3/webhooks-out/:id` | Update subscription |
| `DELETE`| `/api/v3/webhooks-out/:id` | Delete subscription |
| `GET`  | `/api/v3/webhooks-out/deliveries` | Delivery audit log |
| `POST` | `/api/v3/webhooks-out/deliveries/:id/retry` | Retry a failed delivery |
| **Translations** | | |
| `GET`  | `/api/v3/translations/languages` | List supported languages (28) |
| `GET`  | `/api/v3/translations/:ticketId` | List cached translations for a ticket |
| `POST` | `/api/v3/translations/:ticketId` | Translate a ticket |
| `DELETE`| `/api/v3/translations/:ticketId` | Invalidate cache |
| **Ticket Similarity** | | |
| `GET`  | `/api/v3/similarity/:ticketId` | Find similar tickets |
| `GET`  | `/api/v3/similarity/:ticketId/duplicates` | Find potential duplicates |
| **Snoozes** | | |
| `GET`  | `/api/v3/snoozes/:ticketId` | Get active snooze + history |
| `POST` | `/api/v3/snoozes/:ticketId` | Snooze a ticket |
| `DELETE`| `/api/v3/snoozes/:ticketId` | Wake a snoozed ticket |
| `POST` | `/api/v3/snoozes/sweep` | Trigger the snooze sweeper |
| **Threading** | | |
| `GET`  | `/api/v3/threads` | List threads |
| `GET`  | `/api/v3/threads/:id` | Get thread + all tickets |
| `GET`  | `/api/v3/tickets/:ticketId/thread` | Get thread for a ticket |
| `POST` | `/api/v3/tickets/:ticketId/thread` | Link ticket to a thread |
| `DELETE`| `/api/v3/tickets/:ticketId/thread` | Unlink ticket from thread |
| `POST` | `/api/v3/threads/merge` | Merge two threads |
| **System Settings** | | |
| `GET`  | `/api/v3/settings` | List settings (sensitive redacted) |
| `GET`  | `/api/v3/settings/categories` | List categories |
| `GET`  | `/api/v3/settings/:key` | Get one setting |
| `PUT`  | `/api/v3/settings/:key` | Update a setting |
| `DELETE`| `/api/v3/settings/:key` | Delete a setting (admin only) |
| **Audit Log Search** | | |
| `GET`  | `/api/v3/audit/search` | Search with filters |
| `GET`  | `/api/v3/audit/stats` | Audit stats (top actors, action counts, timeseries) |
| `GET`  | `/api/v3/audit/export.csv` | Export to CSV |
| `POST` | `/api/v3/audit/purge` | Purge old entries (admin only) |
| **Backup & Restore** | | |
| `POST` | `/api/v3/backup` | Create a backup (VACUUM INTO) |
| `GET`  | `/api/v3/backup` | List backups |
| `POST` | `/api/v3/backup/restore/:filename` | Restore from backup (admin only) |
| `DELETE`| `/api/v3/backup/:filename` | Delete a backup |
| `POST` | `/api/v3/backup/export-json` | JSON export to file |
| `POST` | `/api/v3/backup/import-json` | Import from JSON (admin only) |
| `POST` | `/api/v3/backup/vacuum` | VACUUM the database |
| `GET`  | `/api/v3/backup/stats` | DB stats (file size, table counts, indexes) |
| **Deep Health** | | |
| `GET`  | `/api/v3/health/deep` | 10-subsystem health check (503 if any fail) |
| `GET`  | `/api/v3/health/ready` | Readiness check |

---

## AI provider configuration

The system uses **xAI Grok** as the sole AI provider via the OpenAI-compatible
Chat Completions API.

### xAI Grok

- **Endpoint**: `https://api.x.ai/v1/chat/completions`
- **Auth**: `Authorization: Bearer xai-...`
- **JSON mode**: ✅ Native `response_format: { type: 'json_object' }` support
- **Models**: `grok-2-latest` (default), `grok-2-mini`, `grok-3`, `grok-4`, `grok-4-fast-reasoning`, `grok-code-fast-1`
- **Context window**: 128k+ tokens
- **Cost**: ~$2/M input, ~$10/M output (grok-2-latest)

### Setup

```bash
# .env (minimal)
GROK_API_KEY=xai-xxxxxxxxxxxxxxxxxxxxxxxxxxxx       # https://console.x.ai
```

That's it. The boot log validates the key starts with `xai-`. The dashboard's
AI status pill shows `xAI Grok — grok-2-latest` when the key is valid.

### Optional Grok tuning

```bash
# .env
AI_MODEL=grok-2-latest                # default; alternatives: grok-3, grok-4, grok-2-mini
AI_SECONDARY_MODEL=grok-2-mini        # cheaper model for spam/lang detection
AI_TEMPERATURE=0.2                    # lower = more deterministic (default)
AI_MAX_TOKENS=1500                    # max response tokens
AI_TIMEOUT_MS=30000                   # per-request timeout
```

### No GROK_API_KEY?

The system falls back to a built-in rule-based mock analyser. All features
work — classification, spam detection, PII redaction, etc. — just without real
LLM calls. Perfect for demos, CI, and local development.

Full prompt documentation: see **[AI_PROMPTS.md](./AI_PROMPTS.md)**.

---

## Environment variables

See **[.env.example](./.env.example)** for the complete list. Only 5 are required:

### Required (5)

| Variable | Purpose | Example |
|----------|---------|---------|
| `PORT` | Server port | `3000` |
| `GROK_API_KEY` | xAI Grok API key (starts with `xai-`) | `xai-abc123...` |
| `SMTP_HOST` | SMTP server for acknowledgment emails | `smtp.gmail.com` |
| `SMTP_PASS` | SMTP password (App Password for Gmail) | `your-app-password` |
| `SMTP_FROM` | Sender email shown to customers | `Support Desk <support@example.com>` |

> `SMTP_USER` is auto-derived from `SMTP_FROM` if not set.
> `SMTP_PORT` defaults to `587`. `SMTP_SECURE` defaults to `false`.

### Optional (with defaults)

| Variable | Default | Purpose |
|----------|---------|---------|
| `EMAIL_WEBHOOK_TOKEN` | `change-me-in-production` | Shared secret for `/webhooks/email` |
| `SLA_CRITICAL` | `2` | SLA hours for Critical priority |
| `SLA_HIGH` | `8` | SLA hours for High priority |
| `SLA_MEDIUM` | `24` | SLA hours for Medium priority |
| `SLA_LOW` | `72` | SLA hours for Low priority |
| `SPAM_ENABLED` | `true` | Toggle spam detection |
| `SPAM_THRESHOLD` | `70` | Score above which ticket is flagged as spam |
| `SPAM_AUTO_REJECT` | `90` | Score above which email is rejected entirely |
| `PII_ENABLED` | `true` | Toggle PII redaction |
| `ESCALATION_ENABLED` | `true` | Toggle SLA escalation engine |
| `AUTH_ENABLED` | `false` | Require `X-API-Key` on all `/api` routes |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `DB_PATH` | `./data/support.db` | SQLite file path |
| `SLACK_WEBHOOK_URL` | *(empty)* | Slack incoming webhook URL |
| `TEAMS_WEBHOOK_URL` | *(empty)* | Microsoft Teams incoming webhook URL |
| `AI_MODEL` | `grok-2-latest` | Override Grok model |
| `AI_SECONDARY_MODEL` | *(empty)* | Cheaper model for spam detection |
| `AI_TIMEOUT_MS` | `30000` | Per-request LLM timeout |

---

## Database schema

See **[DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md)** for the full DDL and field
descriptions. v2 schema has **16 tables** + 2 FTS5 indexes:

- `tickets` (40+ columns, includes `assigned_agent_id`, `language`, `is_spam`, `spam_score`, `pii_redacted_body`, `ai_resolution_suggestion`, `ai_kb_article_ids`, `escalated`, `escalation_level`, `sla_breached`, `customer_id`, `first_response_at`, `resolved_at`)
- `attachments` · `audit_trail` · `ticket_notes` · `routing_config` · `inbox_log`
- **NEW:** `agents` · `api_keys` · `kb_articles` · `tags` · `ticket_tags` · `customer_profiles` · `escalations` · `notifications` · `notification_channels` · `saved_filters` · `metrics_snapshot`
- **NEW:** `tickets_fts` (FTS5) · `kb_fts` (FTS5) — both with auto-sync triggers

---

## Sample test data

12 JSON samples + 2 `.eml` samples in **`data/sample-emails/`**:

| File | Category | Priority | Language | Spam | Tests |
|------|----------|----------|----------|------|-------|
| `01-critical-api-outage.json` | Technical Support | Critical | en | no | Urgent escalation |
| `02-billing-double-charge.json` | Refund Request | High | en | no | Negative sentiment |
| `03-bug-report-export.json` | Bug Report | Medium | en | no | Detailed repro |
| `04-feature-request-csv.json` | Feature Request | Low | en | no | Positive sentiment |
| `05-sales-inquiry-enterprise.json` | Sales Inquiry | Medium | en | no | Enterprise quote |
| `06-account-access-2fa.json` | Account Access | High | en | no | 2FA lockout |
| `07-ambiguous-short.json` | General Inquiry | Low | en | no | Edge case: tiny body |
| `08-spam-marketing.json` | — | — | en | **YES (auto-reject)** | Spam threshold |
| `09-spanish-login.json` | Account Access | Critical | **es** | no | Multi-language |
| `10-pii-billing-dispute.json` | Refund Request | Critical | en | no | PII redaction |
| `11-furious-security-breach.json` | Technical Support | Critical | en | no | Negative + Critical |
| `12-french-feature-question.json` | Sales Inquiry | Low | **fr** | no | Multi-language |
| `sample-invoice-inquiry.eml` | — | — | — | — | Real .eml format |
| `sample-with-attachment.eml` | Bug Report | Medium | — | — | Multipart MIME + base64 attachment |

Run `npm run test:e2e` to ingest them all and see the accuracy report.

---

## Workflow architecture

The pipeline is implemented in Node.js (rather than n8n) for full control
over error handling, retries, and audit. The full DAG is documented in
**`workflow.json`** (n8n-equivalent node graph).

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ Email source │───▶│ Spam check   │───▶│ AI analyzer  │───▶│ Validator    │
│ (webhook /   │    │ + PII redact │    │ (Grok LLM)   │    │ + language   │
│  .eml / API) │    └──────────────┘    └──────────────┘    └──────┬───────┘
└──────────────┘                                                      │
                                                                       ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ Notify       │◀───│ Ack customer │◀───│ Persist      │◀───│ Route → team │
│ (Slack/Teams)│    │ + KB suggest │    │ + agent +    │    │ → best agent │
└──────────────┘    └──────────────┘    │ customer     │    └──────────────┘
                                        └──────────────┘
        │                                       │
        ▼                                       ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ Audit record │    │ SLA sweep    │    │ Agent review │
│ (append-only)│    │ (5min cron)  │    │ (Web UI +    │
└──────────────┘    │ → escalate   │    │  AI insights)│
                    └──────────────┘    └──────────────┘
```

---

## Security considerations (v2)

- **Helmet** sets sane HTTP headers.
- **CORS** configurable via `CORS_ORIGIN`.
- **Rate limiting**: 240 req/min on `/api`, 120 req/min on `/webhooks`.
- **Webhook token** required for `/webhooks/email*`.
- **Agent API keys** are SHA-256 hashed at rest; plaintext shown only once on creation.
- **Role-based access**: admin / agent / viewer (enforced via `authService.requireRole`).
- **Path-traversal-safe** attachment storage.
- **SQL injection safe** — every query uses `better-sqlite3` named parameters.
- **PII redaction** — a separate `pii_redacted_body` column is safe to share externally (e.g. in KB articles or 3rd-party sync).
- **Audit trail** is append-only — no `UPDATE` or `DELETE` SQL ever targets `audit_trail`.
- **Logging** — request bodies are NOT logged; only metadata. Adjust `LOG_LEVEL` for deeper debugging.
- **Feature flags** — disable KB, auto-resolution, bulk ops, or metrics independently.

---

## Scalability notes

- **Database**: swap `better-sqlite3` for `pg` (Postgres) — schema is portable. Add connection pooling.
- **Queue**: front the webhook with Redis + BullMQ so bursts don't overwhelm the LLM rate limits.
- **LLM**: use `AI_SECONDARY_MODEL=grok-2-mini` for spam/lang detection (cheap), keep primary for analysis.
- **Horizontal scaling**: app is stateless except for SQLite; move DB out → run N replicas behind a load balancer.
- **Webhook auth**: replace shared token with HMAC signature verification (Mailgun / SendGrid native).
- **Storage**: swap `attachmentService` for S3 / GCS / Azure Blob.

---

## Testing

The project ships with **3 comprehensive test suites** (89 tests total):

### Unit tests (36 tests)

```bash
npm run test:unit
```

Tests pure functions in `utils/validator`, `utils/helpers`, and `aiService` mock
functions: JSON parsing, type coercion, enum matching, PII redaction, language
detection, spam scoring, KB matching.

### End-to-end test (12 samples)

```bash
npm run test:e2e
```

Expected output (with mock LLM):

```
✓ Technical Support / Critical / en
✓ Refund Request / High / en
✓ Bug Report / Medium / en
✓ Feature Request / Low / en
✓ Sales Inquiry / Medium / en
✓ Account Access / High / en
✓ General Inquiry / Low / en
✓ SPAM AUTO-REJECTED (score 100) ✓
✓ Account Access / Critical / es
✓ Refund Request / Critical / en
✓ Technical Support / Critical / en
✓ Sales Inquiry / Low / fr

Accuracy: 12/12 (100%)
✅ All tests passed.

PII Redaction Test
  ✓ email        redacted
  ✓ credit card  redacted
  ✓ SSN          redacted
  ✓ IBAN         redacted
  ✓ IP           redacted

Reports Endpoint Test
  ✓ /reports/full   30-day timeseries, 3 agents, 5 teams
  ✓ SLA compliance  100% (0 breached of 11)
  ✓ Spam stats      0 spam (0%) of 11 total

Customer 360 Test
  ✓ Customer profile found: cus_xxx, 1 ticket(s), 1 open
```

### Integration tests (41 tests)

```bash
# Start the server first
npm start &
sleep 3

# Run integration tests against the live HTTP API
npm run test:integration
```

Tests the full HTTP API: health, metrics, ticket CRUD, search, similarity,
agents + API keys, KB, macros (create + apply), workflows (create + test),
custom fields, snoozes, SLA policies, scheduled reports, outbound webhooks,
translations, audit search, settings, backup stats, reports, customer 360.

### Run all tests

```bash
npm run test:all    # unit + e2e (skips integration — needs server)
```

### Manual API tests (curl)

```bash
# Health
curl http://localhost:3000/api/health

# Create an agent + API key
curl -X POST http://localhost:3000/api/agents \
  -H 'Content-Type: application/json' \
  -d '{"name":"Alice","email":"alice@x.com","team":"Technical Support","role":"agent","skills":["Technical Support"]}'
# → { "id": "agt-xxx", ... }

curl -X POST http://localhost:3000/api/agents/agt-xxx/api-keys \
  -H 'Content-Type: application/json' -d '{"name":"postman"}'
# → { "plaintext": "sk_live_...", ... }  (save this!)

# Ingest
curl -X POST http://localhost:3000/api/ingest \
  -H 'Content-Type: application/json' \
  -d '{"from":"John <john@x.com>","subject":"Help","body":"Cannot login"}'

# Authenticated request with API key (when AUTH_ENABLED=true)
curl http://localhost:3000/api/tickets \
  -H 'X-API-Key: sk_live_...'

# Bulk close
curl -X POST http://localhost:3000/api/bulk/close \
  -H 'Content-Type: application/json' \
  -d '{"ticketIds":["TKT-...","TKT-..."]}'

# CSV export
curl -o tickets.csv http://localhost:3000/api/tickets/export.csv

# Prometheus metrics
curl http://localhost:3000/api/metrics
```

---

## Demo video script (5–10 min)

1. **(30s)** `npm install && npm start` — point at the boot summary (shows Grok provider, all features).
2. **(45s)** Dashboard tour — KPIs, charts, SLA panel, sample ingestion grid.
3. **(60s)** Click **Ingest →** on `01-critical-api-outage`. Open the ticket, show AI summary, language, confidence, KB suggestions, audit trail.
4. **(45s)** Click **Generate Resolution Plan** — show AI diagnosis + steps.
5. **(45s)** Click **Auto-assign Best Agent** — show workload-balanced assignment.
6. **(30s)** Click **Escalate** — show escalation level in audit trail.
7. **(60s)** Switch to **Agents** page — create an agent, generate an API key, show workload bar.
8. **(45s)** Switch to **Knowledge Base** page — publish an article, search it.
9. **(45s)** Ingest `08-spam-marketing` sample — show auto-rejection (no ticket created).
10. **(45s)** Ingest `10-pii-billing-dispute` — open the ticket, show the PII-redacted body panel.
11. **(45s)** Switch to **Reports** page — show time-series chart, SLA compliance, agent leaderboard.
12. **(30s)** Run `npm run test:e2e` in a terminal — show `✅ All tests passed.`
13. **(30s)** Tour the README + AI_PROMPTS.md.

---

## Assumptions

1. **Email ingestion**: single shared inbox; one ticket per inbound email (no threading). Duplicate detection links new emails to existing tickets but still creates a new ticket record.
2. **AI provider**: any OpenAI-compatible Chat Completions endpoint. Default is xAI Grok (`grok-2-latest`).
3. **SMTP**: optional. When `SMTP_HOST` is empty, acknowledgment emails are logged to console + `logs/app.log`.
4. **Database**: SQLite for zero-config local operation. Schema is portable to Postgres / MySQL / Airtable / Notion / NocoDB without changes to the service layer.
5. **Routing**: category → team mapping defaults to the assignment's example mapping and is editable via `PUT /api/routing/:category`.
6. **Attachments**: stored on local filesystem under `uploads/<ticketId>/`. Swap `attachmentService` for S3 / GCS in production.
7. **Auth**: dashboard is open (no login) for demo simplicity. Set `AUTH_ENABLED=true` and create agent API keys for production.
8. **SLA**: business hours are not considered — SLA windows are wall-clock. Adjust `computeSlaDue` if you need business-hour logic.
9. **Spam thresholds**: `SPAM_THRESHOLD=70` flags, `SPAM_AUTO_REJECT=90` rejects. Tune for your traffic.
10. **PII redaction**: pattern-based (email, phone, credit card, SSN, IBAN, IP). For deeper redaction (names, addresses), enable AI-side redaction in the system prompt.

---

## License

MIT — see `package.json`.
<<<<<<< HEAD
#
