'use strict';

/**
 * AI Service (Production v2) — multi-provider, multi-task.
 *
 * Supported providers (any OpenAI-compatible Chat Completions endpoint):
 *   • xAI Grok      (https://api.x.ai/v1)          — default
 *   • OpenAI        (https://api.openai.com/v1)
 *   • Anthropic     (via OpenRouter)
 *   • Google Gemini (OpenAI shim)
 *   • Groq          (ultra-fast Llama 3)
 *   • Local         (LM Studio / Ollama OpenAI shim)
 *
 * Tasks:
 *   • analyzeEmail           — full ticket analysis (JSON)
 *   • detectSpam             — spam score 0-100
 *   • detectLanguage         — ISO 639-1 language code
 *   • redactPii              — replace PII in body with [REDACTED_*]
 *   • suggestKbArticles      — match ticket to KB articles (RAG-lite)
 *   • suggestReply           — draft customer reply
 *   • suggestResolution      — resolution steps for the agent
 *   • summarizeBatch         — summarize a list of tickets
 *   • detectDuplicateCluster — find duplicates across tickets
 *
 * Robustness:
 *   • response_format: { type: 'json_object' } for guaranteed JSON
 *   • Per-request timeout via AbortController
 *   • Exponential backoff retries
 *   • Mock fallback when no API key
 *   • Every field validated through utils/validator
 */

// Node 18+ provides a global `fetch`. We alias it here for clarity.
const fetch = globalThis.fetch;
const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger').child('ai');
const { safeJsonParse, asString, asArray, asNumber, asCategory, asPriority, asSentiment } = require('../utils/validator');
const { withRetry, sleep } = require('../utils/helpers');

const log = logger;

// ===============================================================
// PROMPTS — see AI_PROMPTS.md for full documentation
// ===============================================================

const SYSTEM_PROMPT_ANALYZE = `You are "SupportTriageAI", an expert customer support analyst for a SaaS company.

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

Return ONLY the JSON object.`;

const SYSTEM_PROMPT_REPLY = `You are a helpful, concise support agent. Write a professional reply to the customer. Address them by name if known. Acknowledge the issue, give next steps, and sign as "Support Team". Do NOT invent product features. <=180 words. If a knowledge base article is provided, reference its steps.`;

const SYSTEM_PROMPT_RESOLUTION = `You are a senior support engineer. Given a ticket and optional KB articles, produce a concise resolution plan for the agent. Output STRICT JSON:
{
  "diagnosis": string,          // 1-2 sentence root-cause hypothesis
  "steps": string[],            // ordered actionable steps for the agent
  "estimated_effort": one of [trivial, low, medium, high],
  "needs_engineering": boolean, // true if dev escalation needed
  "confidence": number          // 0-100
}`;

const SYSTEM_PROMPT_SPAM = `You are a spam classifier. Given an email, return STRICT JSON: {"spam_score": number 0-100, "reasons": string[]}. Higher = more likely spam. Consider: marketing pitches, link farming, nonsensical text, off-topic, promotional. Genuine customer support = 0-20.`;

// ===============================================================
// Provider info
// ===============================================================

function providerInfo() {
  return {
    provider: config.ai.provider,
    label: config.ai.providerLabel,
    model: config.ai.model,
    baseUrl: config.ai.baseUrl,
    useMock: config.ai.useMock,
    keyValid: config.ai.keyValid,
    secondaryModel: config.ai.secondaryModel || config.ai.model,
  };
}

// ===============================================================
// Core LLM call (OpenAI Chat Completions wire format)
// ===============================================================

async function callLLM({ systemPrompt, userPrompt, json = true, model = null, temperature = null, maxTokens = null, timeoutMs = null }) {
  if (config.ai.useMock) {
    throw new Error('LLM called in mock mode — caller should fall back to mock logic');
  }

  const url = `${config.ai.baseUrl}/chat/completions`;
  const payload = {
    model: model || config.ai.model,
    temperature: temperature != null ? temperature : config.ai.temperature,
    max_tokens: maxTokens || config.ai.maxTokens,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  };
  if (json) payload.response_format = { type: 'json_object' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || config.ai.timeoutMs);

  log.debug('LLM call', { model: payload.model, url, json });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.ai.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`LLM HTTP ${res.status}: ${txt.slice(0, 300)}`);
    }

    const json2 = await res.json();
    const content = json2?.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM returned empty content');

    // Token usage logging (helps cost monitoring)
    if (json2?.usage) {
      log.debug('LLM usage', { model: payload.model, prompt: json2.usage.prompt_tokens, completion: json2.usage.completion_tokens, total: json2.usage.total_tokens });
    }

    return content;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Call LLM with retries + parse JSON. Returns { data, raw }.
 */
async function callLLMJson({ systemPrompt, userPrompt, model = null, temperature = null, maxTokens = null }) {
  const raw = await withRetry(
    () => callLLM({ systemPrompt, userPrompt, json: true, model, temperature, maxTokens }),
    { retries: 3, baseDelay: 600, factor: 2 }
  );
  const parsed = safeJsonParse(raw);
  if (!parsed.ok) {
    log.warn('LLM returned non-JSON; attempting repair', { error: parsed.error });
    const repairRaw = await withRetry(
      () => callLLM({
        systemPrompt,
        userPrompt: userPrompt + '\n\nYour previous response was not valid JSON. Return ONLY a single JSON object. No prose, no markdown fences.',
        json: true, model, temperature: 0, maxTokens,
      }),
      { retries: 2, baseDelay: 400 }
    );
    const repairParsed = safeJsonParse(repairRaw);
    if (!repairParsed.ok) throw new Error('LLM repair failed: ' + repairParsed.error);
    return { data: repairParsed.data, raw: repairRaw };
  }
  return { data: parsed.data, raw };
}

// ===============================================================
// Task: analyzeEmail
// ===============================================================

function buildAnalyzeUserPrompt({ senderName, senderEmail, subject, body }) {
  return [
    `Sender name : ${senderName || '(unknown)'}`,
    `Sender email: ${senderEmail || '(unknown)'}`,
    `Subject     : ${subject || '(no subject)'}`,
    '',
    '--- EMAIL BODY ---',
    String(body || '').slice(0, 8000),
    '--- END EMAIL BODY ---',
    '',
    'Return the JSON object now.',
  ].join('\n');
}

/**
 * Full ticket analysis. Returns { ok, data, raw, usedMock }.
 */
async function analyzeEmail(email) {
  if (config.ai.useMock) {
    log.info('AI mock mode active — using rule-based analyser');
    const data = mockAnalyze(email);
    return { ok: true, data, raw: JSON.stringify(data, null, 2), usedMock: true };
  }
  try {
    const { data, raw } = await callLLMJson({
      systemPrompt: SYSTEM_PROMPT_ANALYZE,
      userPrompt: buildAnalyzeUserPrompt(email),
      temperature: config.ai.temperature,
      maxTokens: config.ai.maxTokens,
    });
    return { ok: true, data: validateAnalysis(data), raw, usedMock: false };
  } catch (err) {
    log.error('analyzeEmail LLM failed — falling back to mock', { error: err.message });
    const data = mockAnalyze(email);
    return { ok: true, data, raw: JSON.stringify({ fallback: 'mock', error: err.message, data }, null, 2), usedMock: true, error: err.message };
  }
}

function validateAnalysis(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('LLM response is not an object');
  const data = {
    customer_name: asString(raw.customer_name, 200),
    company: asString(raw.company, 200),
    issue_summary: asString(raw.issue_summary, 280),
    detailed_description: asString(raw.detailed_description, 2000),
    category: asCategory(raw.category),
    priority: asPriority(raw.priority),
    sentiment: asSentiment(raw.sentiment),
    product_service: asString(raw.product_service, 120) || 'General',
    suggested_department: asString(raw.suggested_department, 80) || 'Customer Success',
    suggested_tags: asArray(raw.suggested_tags, 6),
    confidence_score: asNumber(raw.confidence_score, 50, 0, 100),
    extraction_warnings: asArray(raw.extraction_warnings, 10),
    spam_score: asNumber(raw.spam_score, 0, 0, 100),
    language: asString(raw.language, 8).toLowerCase() || 'en',
  };
  return data;
}

// ===============================================================
// Task: detectSpam (standalone, lightweight)
// ===============================================================

async function detectSpam({ subject, body }) {
  if (config.ai.useMock) return mockSpam(subject, body);
  try {
    const userPrompt = `Subject: ${subject || ''}\nBody:\n${String(body || '').slice(0, 2000)}\n\nReturn the JSON.`;
    const { data } = await callLLMJson({
      systemPrompt: SYSTEM_PROMPT_SPAM,
      userPrompt,
      model: config.ai.secondaryModel || null,
      temperature: 0,
      maxTokens: 200,
    });
    return {
      spam_score: asNumber(data.spam_score, 0, 0, 100),
      reasons: asArray(data.reasons, 5),
    };
  } catch (err) {
    log.warn('detectSpam failed; using mock', { error: err.message });
    return mockSpam(subject, body);
  }
}

function mockSpam(subject, body) {
  const text = `${subject || ''}\n${body || ''}`.toLowerCase();
  let score = 0;
  const reasons = [];
  const spamSignals = [
    { kw: ['viagra', 'cialis', 'casino', 'lottery', 'winner', 'congratulations', 'you won', 'you have won', 'you have been selected'], w: 40 },
    { kw: ['click here', 'free offer', 'limited time', 'act now', 'buy now'], w: 15 },
    { kw: ['http://', 'https://'], w: 5 },
    { kw: ['$$$', '$$$$', '100% free', 'no obligation'], w: 25 },
    { kw: ['dear friend', 'dear sir/madam', 'i am contacting you'], w: 20 },
    { kw: ['bitcoin', 'crypto', 'investment opportunity', 'double your'], w: 30 },
    { kw: ['seo services', 'marketing services', 'outsource', 'backlink'], w: 35 },
  ];
  for (const s of spamSignals) {
    for (const k of s.kw) {
      if (text.includes(k)) { score += s.w; reasons.push(`contains "${k}"`); }
    }
  }
  // Lots of links
  const linkCount = (text.match(/https?:\/\//g) || []).length;
  if (linkCount >= 3) { score += 20; reasons.push(`${linkCount}+ links`); }
  // Very short + generic
  if (text.length < 50 && !text.includes('help')) { score += 15; reasons.push('very short, no support context'); }
  return { spam_score: Math.min(100, score), reasons: reasons.slice(0, 5) };
}

// ===============================================================
// Task: redactPii
// ===============================================================

const PII_PATTERNS = [
  { type: 'EMAIL', re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[REDACTED_EMAIL]' },
  { type: 'PHONE', re: /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, replacement: '[REDACTED_PHONE]' },
  { type: 'CREDIT_CARD', re: /\b(?:\d[ -]*?){13,16}\b/g, replacement: '[REDACTED_CC]' },
  { type: 'SSN', re: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[REDACTED_SSN]' },
  { type: 'IBAN', re: /\b[A-Z]{2}\d{2}[A-Z0-9]{4,30}\b/g, replacement: '[REDACTED_IBAN]' },
  { type: 'IPV4', re: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, replacement: '[REDACTED_IP]' },
];

function redactPii(text) {
  if (!text || !config.pii.enabled || !config.pii.redactInBody) return text || '';
  let out = String(text);
  const redacted = [];
  for (const p of PII_PATTERNS) {
    out = out.replace(p.re, () => { redacted.push(p.type); return p.replacement; });
  }
  return out;
}

// ===============================================================
// Task: suggestReply (draft customer response)
// ===============================================================

async function suggestReply(ticket, kbArticles = []) {
  if (config.ai.useMock) return { text: mockReply(ticket), usedMock: true };
  try {
    const kbContext = kbArticles.length
      ? '\n\nRelevant KB articles:\n' + kbArticles.map((a) => `### ${a.title}\n${a.content.slice(0, 800)}`).join('\n\n')
      : '';
    const userPrompt =
      `Ticket ID: ${ticket.id}\n` +
      `Category: ${ticket.category}\nPriority: ${ticket.priority}\n` +
      `Subject: ${ticket.email_subject}\n\n` +
      `Customer message:\n${(ticket.email_body || '').slice(0, 2000)}${kbContext}`;
    const text = await callLLM({
      systemPrompt: SYSTEM_PROMPT_REPLY,
      userPrompt,
      json: false,
      temperature: 0.4,
      maxTokens: 400,
    });
    return { text: text.trim(), usedMock: false };
  } catch (err) {
    log.warn('suggestReply failed; using mock', { error: err.message });
    return { text: mockReply(ticket), usedMock: true };
  }
}

function mockReply(ticket) {
  const name = (ticket.customer_name || 'there').split(' ')[0];
  const opener =
    ticket.priority === 'Critical'
      ? 'I understand this is urgent — I am escalating this immediately to our engineering team.'
      : ticket.sentiment === 'Negative'
      ? 'Thank you for reaching out, and I am sorry for the trouble you are experiencing.'
      : 'Thank you for reaching out to us.';
  return `${opener}\n\nWe have received your request regarding "${ticket.issue_summary}" and created ticket ${ticket.id}. Our ${ticket.assigned_team || 'support'} team will review it and get back to you within the SLA window.\n\nIf you have any additional details, just reply to this email and they will be added to the ticket.\n\nBest regards,\nSupport Team`;
}

// ===============================================================
// Task: suggestResolution (agent-facing resolution plan)
// ===============================================================

async function suggestResolution(ticket, kbArticles = []) {
  if (config.ai.useMock) return mockResolution(ticket, kbArticles);
  try {
    const kbContext = kbArticles.length
      ? '\n\nRelevant KB articles:\n' + kbArticles.map((a) => `### ${a.title}\n${a.content.slice(0, 600)}`).join('\n\n')
      : '';
    const userPrompt =
      `Ticket ID: ${ticket.id}\n` +
      `Category: ${ticket.category}\nPriority: ${ticket.priority}\nStatus: ${ticket.status}\n` +
      `Subject: ${ticket.email_subject}\n\n` +
      `Customer message:\n${(ticket.email_body || '').slice(0, 2000)}\n\n` +
      `AI summary: ${ticket.issue_summary || ''}${kbContext}\n\nReturn the JSON.`;
    const { data, raw } = await callLLMJson({
      systemPrompt: SYSTEM_PROMPT_RESOLUTION,
      userPrompt,
      temperature: 0.2,
      maxTokens: 800,
    });
    return {
      diagnosis: asString(data.diagnosis, 600),
      steps: asArray(data.steps, 10),
      estimated_effort: ['trivial', 'low', 'medium', 'high'].includes(String(data.estimated_effort).toLowerCase()) ? String(data.estimated_effort).toLowerCase() : 'medium',
      needs_engineering: !!data.needs_engineering,
      confidence: asNumber(data.confidence, 50, 0, 100),
      raw,
      usedMock: false,
    };
  } catch (err) {
    log.warn('suggestResolution failed; using mock', { error: err.message });
    return mockResolution(ticket, kbArticles);
  }
}

function mockResolution(ticket, kbArticles = []) {
  const steps = [];
  if (ticket.category === 'Technical Support') {
    steps.push('Reproduce the issue on a test account', 'Check recent deployments / status page', 'Collect browser/network logs from the customer');
  } else if (ticket.category === 'Billing') {
    steps.push('Pull up the customer billing history', 'Verify the disputed charge in Stripe/portal', 'Issue refund if duplicate confirmed');
  } else if (ticket.category === 'Account Access') {
    steps.push('Verify customer identity (government ID or known email)', 'Reset 2FA via admin console', 'Send re-onboarding instructions');
  } else if (ticket.category === 'Bug Report') {
    steps.push('Reproduce with the provided steps', 'File a JIRA ticket with reproduction details', 'Notify the customer of the workaround if any');
  } else {
    steps.push('Review the customer message', 'Reply with relevant information', 'Close if resolved');
  }
  if (kbArticles.length) steps.push(`Reference KB article: ${kbArticles[0].title}`);
  return {
    diagnosis: `Likely a ${ticket.category.toLowerCase()} issue requiring ${ticket.priority === 'Critical' ? 'immediate' : 'standard'} investigation.`,
    steps,
    estimated_effort: ticket.priority === 'Critical' ? 'high' : ticket.priority === 'High' ? 'medium' : 'low',
    needs_engineering: ['Technical Support', 'Bug Report'].includes(ticket.category),
    confidence: 70,
    usedMock: true,
  };
}

// ===============================================================
// Task: suggestKbArticles (RAG-lite: keyword + tag matching)
// ===============================================================

/**
 * Suggest KB articles for a ticket. Uses keyword overlap + category match.
 * @param {object} ticket
 * @param {Array<object>} allArticles  - all published KB articles
 * @param {number} limit
 */
function suggestKbArticles(ticket, allArticles, limit = 3) {
  if (!allArticles || !allArticles.length) return [];
  const text = `${ticket.email_subject || ''} ${ticket.email_body || ''} ${ticket.issue_summary || ''}`.toLowerCase();
  const ticketTags = (ticket.suggested_tags || []).map((t) => t.toLowerCase());

  const scored = allArticles.map((a) => {
    let score = 0;
    const articleText = `${a.title} ${a.summary || ''} ${a.content}`.toLowerCase();
    const articleTags = (() => { try { return JSON.parse(a.tags || '[]'); } catch { return []; } })().map((t) => t.toLowerCase());

    // Category match
    if (a.category && a.category === ticket.category) score += 30;
    // Tag overlap
    for (const t of ticketTags) {
      if (articleTags.includes(t)) score += 15;
    }
    // Keyword overlap (title words worth more)
    const titleWords = (a.title || '').toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    for (const w of titleWords) {
      if (text.includes(w)) score += 8;
    }
    // Body keyword overlap
    const bodyWords = articleText.split(/\W+/).filter((w) => w.length > 5);
    const uniqueBody = Array.from(new Set(bodyWords)).slice(0, 200);
    for (const w of uniqueBody) {
      if (text.includes(w)) score += 1;
    }
    return { article: a, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => ({ ...s.article, match_score: s.score }));
}

// ===============================================================
// Task: summarizeBatch
// ===============================================================

async function summarizeBatch(tickets) {
  if (!tickets || !tickets.length) return { summary: 'No tickets to summarize.', themes: [], usedMock: true };
  if (config.ai.useMock) {
    const themes = {};
    for (const t of tickets) themes[t.category] = (themes[t.category] || 0) + 1;
    return {
      summary: `${tickets.length} tickets across ${Object.keys(themes).length} categories. Top: ${Object.entries(themes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} (${v})`).join(', ')}.`,
      themes: Object.entries(themes).map(([k, v]) => ({ category: k, count: v })),
      usedMock: true,
    };
  }
  try {
    const userPrompt = tickets.map((t, i) =>
      `Ticket ${i + 1}: [${t.category}/${t.priority}] ${t.email_subject}\n${(t.issue_summary || t.email_body || '').slice(0, 200)}`
    ).join('\n---\n');
    const { data } = await callLLMJson({
      systemPrompt: 'You are a support manager. Summarise the following tickets into themes and an executive summary. Return JSON: {"summary": string, "themes": [{"category": string, "count": number, "note": string}]}.',
      userPrompt: userPrompt + '\n\nReturn the JSON.',
      temperature: 0.3,
      maxTokens: 600,
    });
    return {
      summary: asString(data.summary, 600),
      themes: Array.isArray(data.themes) ? data.themes.slice(0, 10) : [],
      usedMock: false,
    };
  } catch (err) {
    log.warn('summarizeBatch failed', { error: err.message });
    const themes = {};
    for (const t of tickets) themes[t.category] = (themes[t.category] || 0) + 1;
    return {
      summary: `${tickets.length} tickets. Summary generation failed.`,
      themes: Object.entries(themes).map(([k, v]) => ({ category: k, count: v })),
      usedMock: true,
    };
  }
}

// ===============================================================
// Mock analyzer (deterministic rule-based fallback)
// ===============================================================

function mockAnalyze({ senderName, senderEmail, subject, body }) {
  const text = `${subject || ''}\n${body || ''}`.toLowerCase();

  const signals = [
    { cat: 'Refund Request',    dept: 'Finance',           weight: 3, kw: ['refund', 'money back', 'reimburse', 'double charge', 'charged twice', 'duplicate charge', 'want a refund', 'want an immediate refund'] },
    { cat: 'Technical Support', dept: 'Technical Support', weight: 2, kw: ['error', 'crash', 'not working', 'bug', 'fail', '500', 'exception', 'timeout', 'cannot login', 'integration', 'api', 'webhook', 'security breach', 'data leak', 'leaked', 'vulnerability', 'outage', 'production down'] },
    { cat: 'Billing',           dept: 'Finance',           weight: 1, kw: ['invoice', 'charge', 'charged', 'payment', 'billing', 'subscription', 'receipt', 'plan', 'upgrade', 'unauthorized charge'] },
    { cat: 'Account Access',    dept: 'Customer Success',  weight: 2, kw: ['password', 'locked out', 'cannot access', 'two-factor', '2fa', 'mfa', 'reset', 'login issue', 'sso', 'no puedo acceder', 'contraseña'] },
    { cat: 'Sales Inquiry',     dept: 'Sales',             weight: 1, kw: ['quote', 'pricing', 'demo', 'sales', 'contract', 'enterprise', 'poc', 'pilot', 'essai gratuit'] },
    { cat: 'Feature Request',   dept: 'Product Team',      weight: 1, kw: ['feature', 'would be great', 'suggest', 'roadmap', 'wish', 'idea', 'enhancement'] },
    { cat: 'Bug Report',        dept: 'Product Team',      weight: 2, kw: ['bug report', 'reproduc', 'steps to reproduce', 'unexpected behavior', 'broken'] },
  ];

  let category = 'General Inquiry';
  let dept = 'Customer Success';
  let bestScore = 0;
  for (const s of signals) {
    const score = s.kw.reduce((n, k) => n + (text.includes(k) ? (s.weight || 1) : 0), 0);
    if (score > bestScore) { bestScore = score; category = s.cat; dept = s.dept; }
  }

  let priority = 'Medium';
  if (/\b(urgent|asap|immediately|critical|production down|outage|cannot work|emergency|data loss|security breach|urgente|urgencia)\b/.test(text)) {
    priority = 'Critical';
  } else if (/\b(important|high priority|blocking|deadline|today|serious|cannot access|cannot login|lost my phone|no puedo|necesito ayuda urgente)\b/.test(text)) {
    priority = 'High';
  } else if (/\b(question|how do i|info|documentation|whenever|whenever you can|low priority)\b/.test(text)) {
    priority = 'Low';
  } else if (category === 'Feature Request' || category === 'General Inquiry') {
    priority = 'Low';
  }

  let sentiment = 'Neutral';
  if (/\b(thank|great|awesome|love|appreciate|excellent|fantastic|merci|gracias|danke)\b/.test(text)) sentiment = 'Positive';
  if (/\b(angry|frustrat|disappoint|furious|unacceptable|terrible|hate|worst|annoyed|fed up|ridiculous|furia|triste)\b/.test(text)) sentiment = 'Negative';

  const tagSet = new Set();
  for (const kw of ['login','api','billing','refund','invoice','sso','2fa','bug','integration','performance','upgrade','pricing','webhook','dashboard','export','mobile']) {
    if (text.includes(kw)) tagSet.add(kw);
  }
  if (tagSet.size === 0) tagSet.add(category.toLowerCase().split(' ')[0]);

  let product = 'General';
  const pm = text.match(/(pro plan|enterprise|starter|free plan|team plan|api v\d|mobile app|web dashboard)/);
  if (pm) product = pm[1];

  let confidence = 60 + bestScore * 8;
  if (priority === 'Critical') confidence += 5;
  if (!subject || subject.length < 5) confidence -= 15;
  if (!body || body.length < 30) confidence -= 20;
  confidence = Math.max(20, Math.min(95, confidence));

  const warnings = [];
  if (!body || body.length < 30) warnings.push('Email body is very short — limited context for analysis.');
  if (!senderEmail) warnings.push('Sender email missing.');
  if (category === 'General Inquiry' && bestScore === 0) warnings.push('No strong category signal detected.');

  const issueSummary = (subject || body || 'Customer support request').slice(0, 140);
  const detailed = (body || subject || '').replace(/\s+/g, ' ').trim().slice(0, 600) || 'Customer contacted support; details limited.';

  // Language detection (very simple)
  const lang = detectLanguageSimple(text);

  // Spam score
  const spamResult = mockSpam(subject, body);

  return {
    customer_name: senderName || '',
    company: '',
    issue_summary: issueSummary,
    detailed_description: detailed,
    category,
    priority,
    sentiment,
    product_service: product,
    suggested_department: dept,
    suggested_tags: Array.from(tagSet).slice(0, 6),
    confidence_score: confidence,
    extraction_warnings: warnings,
    spam_score: spamResult.spam_score,
    language: lang,
  };
}

function detectLanguageSimple(text) {
  const t = (text || '').toLowerCase();
  if (!t) return 'en';
  if (/[\u4e00-\u9fff]/.test(t)) return 'zh';
  if (/[\u3040-\u30ff]/.test(t)) return 'ja';
  if (/[\uac00-\ud7af]/.test(t)) return 'ko';
  if (/[\u0600-\u06ff]/.test(t)) return 'ar';
  if (/[\u0400-\u04ff]/.test(t)) return 'ru';
  if (/[\u0900-\u097f]/.test(t)) return 'hi';

  // Word-boundary matching to avoid substring false positives
  const hasWord = (word) => {
    // For multi-word phrases, just check substring
    if (word.includes(' ')) return t.includes(word);
    // For single words, require word boundaries (handles accented chars too)
    const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return re.test(t);
  };

  // Distinctive multi-word phrases score higher (more reliable signals)
  const signatures = {
    fr: ['merci par avance', 'cordialement', 'bonjour', "je vous contacte", "fonctionnalités", "votre offre", "essai gratuit", "merci d'avance", 'au secours'],
    es: ['por favor', 'gracias', 'hola', 'no puedo', 'no funciona', 'ayuda urgente', 'equipo de soporte', 'ayúdenme', 'contraseña', 'mi cuenta', 'necesito ayuda', 'cordialmente'],
    de: ['bitte', 'hilfe', 'danke', 'kaputt', 'funktioniert nicht', 'ich habe', 'kann nicht', 'mit freundlichen grüßen'],
    it: ['per favore', 'grazie', 'aiuto', 'non funziona', 'buongiorno', 'cordiali saluti', 'problema'],
    pt: ['por favor', 'obrigado', 'ajuda', 'não funciona', 'bom dia', 'atenciosamente', 'problema'],
  };

  const scores = {};
  for (const [lang, words] of Object.entries(signatures)) {
    scores[lang] = words.reduce((n, w) => n + (hasWord(w) ? 1 : 0), 0);
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (ranked[0] && ranked[0][1] >= 2) return ranked[0][0];
  if (ranked[0] && ranked[0][1] === 1 && (!ranked[1] || ranked[1][1] === 0)) {
    // Single distinctive phrase is enough
    return ranked[0][0];
  }
  return 'en';
}

// ===============================================================
// Exports
// ===============================================================

module.exports = {
  // Tasks
  analyzeEmail,
  detectSpam,
  redactPii,
  suggestReply,
  suggestResolution,
  suggestKbArticles,
  summarizeBatch,
  detectLanguageSimple,
  // Provider info
  providerInfo,
  // Prompts (exported for AI_PROMPTS.md)
  SYSTEM_PROMPT_ANALYZE,
  SYSTEM_PROMPT_REPLY,
  SYSTEM_PROMPT_RESOLUTION,
  SYSTEM_PROMPT_SPAM,
  buildAnalyzeUserPrompt,
  // Mock (exported for testing)
  mockAnalyze,
  mockReply,
  mockResolution,
  mockSpam,
};
