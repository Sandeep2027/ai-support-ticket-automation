# AI Prompts — Customer Support Ticket Automation v2

This document covers the full prompt engineering used by the system, including
provider-specific guidance for **xAI Grok** (default), OpenAI, Claude, Gemini,
and Groq.

---

## 1. Primary prompt — Ticket Analysis

**File**: `src/services/aiService.js` (exported as `SYSTEM_PROMPT_ANALYZE`)

**Purpose**: Analyse a single customer support email and return a strict JSON
object containing classification, priority, sentiment, suggested routing,
tags, confidence, spam score, language, and any extraction warnings.

**Technique**: Single-turn system + user message. `response_format: { type: 'json_object' }`
forces valid JSON output. Enum values are validated and coerced server-side
so the model cannot put the system in an invalid state.

### System prompt (verbatim)

```text
You are "SupportTriageAI", an expert customer support analyst for a SaaS company.

You receive a single customer support email. You must analyse it and return a STRICT JSON object describing the ticket. Do NOT output anything outside the JSON object.

Required fields (use "" or [] when unknown, never omit a field):
{
  "customer_name":   string,
  "company":         string,
  "issue_summary":   string,             // one-sentence summary, <=140 chars
  "detailed_description": string,        // 2-4 sentence neutral description
  "category":        one of [Technical Support, Billing, Sales Inquiry, Feature Request, Bug Report, Account Access, Refund Request, General Inquiry],
  "priority":        one of [Critical, High, Medium, Low],
  "sentiment":       one of [Positive, Neutral, Negative],
  "product_service": string,
  "suggested_department": one of [Technical Support, Finance, Sales, Customer Success, Product Team],
  "suggested_tags":  string[],            // 1-6 short lowercase tags
  "confidence_score": number,             // 0-100
  "extraction_warnings": string[],
  "spam_score":      number,              // 0-100, probability this is spam/junk
  "language":        string               // ISO 639-1 code (en, es, fr, de, it, pt, ja, zh, ko, ar, hi, ru, ...)
}

Decision rules:
- Priority = "Critical" if production is down, data loss, security breach, complete lockout, or SLA breach language ("urgent", "ASAP", "immediately", "can't work").
- Priority = "High" if a major feature is broken, billing prevents service, or 2FA lockout.
- Priority = "Medium" for normal issues with moderate impact.
- Priority = "Low" for general questions, feature requests, or non-urgent matters.
- Sentiment: Negative if frustration/anger words, Positive if thanks/praise, Neutral otherwise.
- suggested_department must be consistent with category:
  Technical Support -> Technical Support
  Billing / Refund Request -> Finance
  Sales Inquiry -> Sales
  Account Access / General Inquiry -> Customer Success
  Feature Request / Bug Report -> Product Team
- spam_score: 90+ for marketing spam, link farming, nonsensical content. 0-20 for genuine support requests. 30-70 for borderline.
- confidence_score < 60 when the email is ambiguous, malformed, or missing key info — list concerns in extraction_warnings.
- Be conservative: when in doubt, prefer "General Inquiry" / "Medium" / "Neutral".

Return ONLY the JSON object.
```

### User prompt template (verbatim)

```text
Sender name : {senderName}
Sender email: {senderEmail}
Subject     : {subject}

--- EMAIL BODY ---
{body}
--- END EMAIL BODY ---

Return the JSON object now.
```

### Why this prompt works

| Design choice | Rationale |
|---------------|-----------|
| Strict JSON, no prose | Predictable downstream parsing; no fragile regex extraction. |
| Explicit enum lists in the schema | Constrains the model to a closed set, reducing hallucinated categories. |
| Decision rules with examples | Gives the model a consistent rubric for priority, so two similar tickets get the same priority. |
| `suggested_department` consistency rule | Prevents contradictions (e.g. category=Billing but department=Sales). |
| `confidence_score` + `extraction_warnings` pair | Surfaces low-confidence cases for human review and feeds the bonus "confidence-based routing" feature. |
| `spam_score` in same call | Saves a round-trip; the dedicated `detectSpam` task is used only when spam check runs before AI analysis (rare). |
| `language` field | Powers the multi-language dashboard widget and triggers translation if needed. |
| "When in doubt, prefer General Inquiry / Medium / Neutral" | Conservative defaults prevent over-escalation. |
| Body capped at 8 KB | Protects token budget; long emails are unlikely to add classification signal past the first screen of content. |

---

## 2. Spam Detection prompt (standalone)

Used when spam detection runs separately (e.g. before the full analysis to short-circuit obvious spam).

```text
[system]
You are a spam classifier. Given an email, return STRICT JSON:
{"spam_score": number 0-100, "reasons": string[]}.
Higher = more likely spam. Consider: marketing pitches, link farming,
nonsensical text, off-topic, promotional. Genuine customer support = 0-20.

[user]
Subject: {subject}
Body:
{body (first 2000 chars)}

Return the JSON.
```

Uses `temperature=0` for determinism and `AI_SECONDARY_MODEL` (e.g. `grok-2-mini`)
for cost efficiency. Mock fallback: pattern-based scoring on keywords like
"viagra", "casino", "lottery", "congratulations you won", link density, etc.

---

## 3. AI Reply Suggestion prompt

Generates a customer-facing reply grounded in suggested KB articles.

```text
[system]
You are a helpful, concise support agent. Write a professional reply to the
customer. Address them by name if known. Acknowledge the issue, give next
steps, and sign as "Support Team". Do NOT invent product features. <=180 words.
If a knowledge base article is provided, reference its steps.

[user]
Ticket ID: {id}
Category: {category}
Priority: {priority}
Subject: {email_subject}

Customer message:
{email_body (first 2000 chars)}

{optional KB context}

Relevant KB articles:
### {article1.title}
{article1.content (first 800 chars)}

### {article2.title}
{article2.content (first 800 chars)}
```

`temperature=0.4` — slightly more creative than analysis (which uses 0.2) but
still grounded. Mock fallback: template based on priority + sentiment + team.

---

## 4. AI Resolution Plan prompt (NEW in v2)

Generates an agent-facing resolution plan with diagnosis, ordered steps, effort estimate, engineering flag, and confidence.

```text
[system]
You are a senior support engineer. Given a ticket and optional KB articles,
produce a concise resolution plan for the agent. Output STRICT JSON:
{
  "diagnosis": string,          // 1-2 sentence root-cause hypothesis
  "steps": string[],            // ordered actionable steps for the agent
  "estimated_effort": one of [trivial, low, medium, high],
  "needs_engineering": boolean, // true if dev escalation needed
  "confidence": number          // 0-100
}

[user]
Ticket ID: {id}
Category: {category}
Priority: {priority}
Status: {status}
Subject: {email_subject}

Customer message:
{email_body (first 2000 chars)}

AI summary: {issue_summary}

{optional KB context}

Return the JSON.
```

The result is cached on the ticket (`ai_resolution_suggestion` column) so
repeated views don't re-call the LLM.

---

## 5. JSON repair prompt (used on parse failure)

If the LLM returns non-JSON, we send one repair turn:

```text
[system]  {SYSTEM_PROMPT_ANALYZE}
[user]    {buildUserPrompt(email)}
[assistant] {previous bad output}
[user]    Your previous response was not valid JSON. Return ONLY a single
          JSON object that strictly follows the schema. No prose, no
          markdown fences.
```

With `response_format: { type: 'json_object' }` enforced, this almost always
succeeds on the second attempt. If it still fails, we fall back to the
rule-based mock analyser so the pipeline never breaks.

---

## 6. Mock mode (rule-based analyser)

When `AI_API_KEY` is unset (or `AI_FORCE_MOCK=true`), the system uses a
deterministic rule-based analyser in `aiService.mockAnalyze()`. This lets the
full pipeline be demoed and tested end-to-end without LLM costs.

The mock:
- Scans subject + body for category-specific keywords (weighted: refund weight 3, technical/account/bug weight 2, others weight 1).
- Detects priority words ("urgent", "asap", "production down", "urgente" → Critical).
- Detects sentiment words ("angry", "furious", "thank", "love" → Negative/Positive).
- Detects language via word-boundary signature matching (es, fr, de, it, pt + non-Latin scripts).
- Detects spam signals (link density, marketing phrases, "congratulations you won", etc.).
- Computes a confidence score based on signal strength + body length.
- Adds extraction warnings for very short or ambiguous emails.

It is **not** a replacement for an LLM in production — it is a development
ergonomic and a graceful-degradation fallback.

---

## 7. Request payload (sent to the LLM API)

```json
{
  "model": "grok-2-latest",
  "temperature": 0.2,
  "max_tokens": 1500,
  "response_format": { "type": "json_object" },
  "messages": [
    { "role": "system", "content": "<SYSTEM_PROMPT_ANALYZE>" },
    { "role": "user",   "content": "<user prompt>" }
  ]
}
```

Endpoint: `POST {AI_BASE_URL}/chat/completions`
Headers: `Authorization: Bearer {AI_API_KEY}`
Timeout: `AI_TIMEOUT_MS` (default 30s) — enforced via `AbortController`.
Retries: 3 with exponential backoff (600ms → 1.2s → 2.4s + jitter).

---

## 8. Validation pipeline (after LLM response)

The `validateAnalysis()` function in `aiService.js` enforces the schema regardless of
what the LLM returned:

| Field | Coercion |
|-------|----------|
| `customer_name`, `company`, `issue_summary`, `detailed_description`, `product_service`, `suggested_department` | `asString()` with max length, trim |
| `suggested_tags` | `asArray()` — dedup, lowercase-normalised, max 6 items |
| `extraction_warnings` | `asArray()` — max 10 items |
| `confidence_score`, `spam_score` | `asNumber(50, 0, 100)` |
| `category` | `asCategory()` — fuzzy match against allowed enum, fallback `General Inquiry` |
| `priority` | `asPriority()` — keyword match, fallback `Medium` |
| `sentiment` | `asSentiment()` — keyword match, fallback `Neutral` |
| `language` | `asString(8).toLowerCase()` — defaults to `en` if missing |

This means even a partially-hallucinated response is converted into a valid,
persistable ticket — no 500 errors, no broken dashboards.

---

## 9. Provider-specific notes

### xAI Grok (default, recommended)

- **Endpoint**: `https://api.x.ai/v1/chat/completions`
- **Auth**: `Authorization: Bearer xai-...`
- **JSON mode**: ✅ Native `response_format: { type: 'json_object' }` support on `grok-2-*` and later
- **Models**:
  - `grok-2-latest` — best balance for ticket analysis (~$2/M input, $10/M output as of 2026)
  - `grok-2-mini` — recommended secondary model for spam detection
  - `grok-3` — longer context (128k+), real-time knowledge
  - `grok-4` — most capable, higher cost
  - `grok-4-fast-reasoning` — fast chain-of-thought
  - `grok-code-fast-1` — code-focused, not relevant for support
- **Tip**: Grok tends to be more conservative on spam scoring than OpenAI; consider lowering `SPAM_THRESHOLD` to 65 if using Grok.
- **Tip**: Grok handles non-English text natively — no need for a translation pre-pass.

### OpenAI

- **Endpoint**: `https://api.openai.com/v1/chat/completions`
- **Auth**: `Authorization: Bearer sk-...`
- **JSON mode**: ✅ Best-in-class `response_format: { type: 'json_object' }` and JSON Schema mode
- **Recommended models**: `gpt-4o-mini` (cheap, fast), `gpt-4o` (high quality), `gpt-4.1-mini` (latest small)
- **Tip**: Use `gpt-4o-mini` for analysis and `gpt-4o-mini` for spam — both are cheap and reliable.

### Anthropic Claude (via OpenRouter)

- **Endpoint**: `https://openrouter.ai/api/v1/chat/completions`
- **Auth**: `Authorization: Bearer sk-or-...`
- **Note**: Anthropic's native API is **not** OpenAI-compatible. Use OpenRouter as a shim.
- **Recommended models**: `anthropic/claude-3.5-sonnet` (best), `anthropic/claude-3.5-haiku` (fast)
- **Tip**: Claude is excellent at long-context reasoning; great for tickets with lengthy email threads.

### Google Gemini

- **Endpoint**: `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`
- **Auth**: `Authorization: Bearer AIza...`
- **Recommended models**: `gemini-1.5-flash` (cheap, fast), `gemini-1.5-pro` (high quality)
- **Tip**: Gemini has a 1M-token context window — useful if you want to include full email threads.

### Groq (ultra-fast inference)

- **Endpoint**: `https://api.groq.com/openai/v1/chat/completions`
- **Auth**: `Authorization: Bearer gsk_...`
- **Recommended models**: `llama-3.1-70b-versatile`, `llama-3.1-8b-instant`, `mixtral-8x7b-32768`
- **Tip**: Groq is the fastest option (~500 tokens/sec). Use `llama-3.1-8b-instant` for spam detection, `llama-3.1-70b-versatile` for analysis. Free tier available.

### Local (LM Studio / Ollama)

- **Endpoint**: `http://localhost:1234/v1/chat/completions` (LM Studio) or `http://localhost:11434/v1/chat/completions` (Ollama with OpenAI shim)
- **Auth**: any non-empty string
- **Tip**: Great for air-gapped environments. Llama 3.1 8B runs on a single GPU and handles ticket analysis well.

---

## 10. Cost & latency considerations

### Per-ticket cost (with Grok-2-latest, typical ticket ~600 input + 300 output tokens)

| Task | Model | Cost (USD) |
|------|-------|------------|
| Analysis | grok-2-latest | ~$0.004 |
| Spam detection | grok-2-mini | ~$0.0005 |
| Reply suggestion (per agent click) | grok-2-latest | ~$0.002 |
| Resolution plan (per agent click) | grok-2-latest | ~$0.003 |
| **Per-ticket total** | | **~$0.005** |

For 1,000 tickets/day → ~$5/day in LLM costs.

### Latency

- Grok-2-latest analysis: ~1.5–3s
- Grok-2-mini spam: ~0.5–1s
- gpt-4o-mini analysis: ~1–2s
- Llama-3.1-70b on Groq: ~0.5–1s

### Cost optimisation tips

1. Set `AI_SECONDARY_MODEL=grok-2-mini` — spam detection runs on the cheaper model.
2. Body truncation at 8 KB caps token cost on long emails.
3. AI Resolution Plan and Reply Suggestion are **on-demand** (agent clicks a button) — not run automatically.
4. Use the mock fallback in CI/staging — zero LLM cost.
5. KB suggestions use a pure keyword-matching algorithm (no LLM call) — free RAG.

---

## 11. Prompt evolution log

| Version | Change |
|---------|--------|
| v1.0 | Initial system prompt with category / priority / sentiment / confidence |
| v1.1 | Added `extraction_warnings` for low-confidence surfacing |
| v2.0 | Added `spam_score` and `language` to the same JSON output (saves a round-trip) |
| v2.1 | Added `SYSTEM_PROMPT_REPLY` (customer-facing draft) |
| v2.2 | Added `SYSTEM_PROMPT_RESOLUTION` (agent-facing resolution plan) |
| v2.3 | Added `SYSTEM_PROMPT_SPAM` (standalone spam classifier for short-circuit) |
