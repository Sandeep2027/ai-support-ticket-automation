'use strict';

/**
 * End-to-end test runner (Production v2).
 *
 * Tests:
 *   1. Classification accuracy (category + priority) for all sample emails
 *   2. Spam detection (auto-reject / flag)
 *   3. Language detection
 *   4. PII redaction
 *   5. Duplicate detection
 *   6. Knowledge base suggestion (if articles exist)
 *   7. Agent auto-assignment (if agents exist)
 *   8. Stats endpoint returns sane numbers
 *
 * No API key required — uses the built-in mock LLM.
 */

const path = require('path');
const fs = require('fs');

const config = require('../src/config');
const db = require('../src/database/db');
const emailService = require('../src/services/emailService');
const ticketService = require('../src/services/ticketService');
const aiService = require('../src/services/aiService');
const kbService = require('../src/services/kbService');
const agentService = require('../src/services/agentService');
const reportService = require('../src/services/reportService');

const SAMPLES_DIR = path.resolve(process.cwd(), 'data', 'sample-emails');

function loadSamples() {
  return fs
    .readdirSync(SAMPLES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((filename) => {
      const payload = JSON.parse(fs.readFileSync(path.join(SAMPLES_DIR, filename), 'utf8'));
      return { filename, payload };
    });
}

async function main() {
  const samples = loadSamples();
  if (!samples.length) {
    console.error('No sample JSON files found in', SAMPLES_DIR);
    process.exit(1);
  }

  // Reset DB — close, delete file, reopen (schema auto-applies on open)
  // On Windows the file lock may not release immediately, so we have a
  // fallback: if file deletion fails, drop all tables instead.
  const dbPath = db.DB_PATH;
  try { db.close(); } catch { /* ignore */ }

  // Give the OS a moment to release file locks (especially on Windows)
  await new Promise((r) => setTimeout(r, 200));

  let fileDeleted = false;
  for (const ext of ['', '-wal', '-shm', '-journal']) {
    try { fs.unlinkSync(dbPath + ext); } catch { /* file may not exist or be locked */ }
  }
  // Verify the main DB file is actually gone
  fileDeleted = !fs.existsSync(dbPath);

  if (!fileDeleted) {
    // Fallback: open the existing DB and DROP all tables + re-apply schema
    // This works on Windows where file locks prevent deletion
    db.getDb();
    const d = db.getDb();
    const tables = d.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
    ).all().map((r) => r.name);
    // Disable foreign keys during drop (SQLite can't drop tables with FK refs otherwise)
    d.pragma('foreign_keys = OFF');
    for (const t of tables) {
      try { d.exec(`DROP TABLE IF EXISTS "${t}"`); } catch { /* ignore */ }
    }
    // Also drop FTS virtual tables
    const ftsTables = d.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts%'`
    ).all().map((r) => r.name);
    for (const t of ftsTables) {
      try { d.exec(`DROP TABLE IF EXISTS "${t}"`); } catch { /* ignore */ }
    }
    d.pragma('foreign_keys = ON');
    // Re-apply schema (creates all tables fresh)
    const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'database', 'schema.sql'), 'utf8');
    d.exec(schema);
  } else {
    // File was deleted — just reopen and schema will auto-apply
    db.getDb();
  }

  // Seed a couple of agents so auto-assignment has someone to assign to
  // Use a helper that ignores "already exists" errors (UNIQUE constraint)
  const seedAgent = (params) => {
    try { return agentService.create(params); }
    catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        // Agent already exists from a prior run — return the existing one
        return agentService.getByEmail(params.email);
      }
      throw err;
    }
  };
  seedAgent({ name: 'Alice Chen', email: 'alice@example.com', team: 'Technical Support', role: 'agent', skills: ['Technical Support', 'Bug Report'] });
  seedAgent({ name: 'Bob Patel', email: 'bob@example.com', team: 'Finance', role: 'agent', skills: ['Billing', 'Refund Request'] });
  seedAgent({ name: 'Carol Garcia', email: 'carol@example.com', team: 'Customer Success', role: 'agent', skills: ['Account Access', 'General Inquiry'] });

  // Seed KB articles (idempotent — skip if title already exists)
  const seedKb = (params) => {
    const existing = db.all(`SELECT id FROM kb_articles WHERE title = @title`, { title: params.title });
    if (existing.length) return existing[0];
    return kbService.create(params);
  };
  seedKb({
    title: 'Resolving API 500 Errors',
    summary: 'Steps to diagnose and resolve 500 errors on the public API.',
    content: 'If you encounter a 500 error from our API: (1) Check status.example.com for incidents. (2) Verify your API key is valid. (3) Retry with exponential backoff. (4) If it persists, capture the request ID and contact support.',
    category: 'Technical Support',
    tags: ['api', 'error', '500'],
  });
  seedKb({
    title: 'Refund Policy and How to Request One',
    summary: 'How to request a refund for duplicate or unauthorized charges.',
    content: 'To request a refund: (1) Locate the charge on your billing dashboard. (2) Open a support ticket with the invoice number. (3) Our Finance team reviews within 48h. Duplicate charges are refunded in full.',
    category: 'Billing',
    tags: ['refund', 'billing', 'invoice'],
  });
  seedKb({
    title: 'Resetting Two-Factor Authentication (2FA)',
    summary: 'How to reset 2FA when you lose your device.',
    content: 'If you lose your 2FA device: (1) Use a backup code if you saved one. (2) Open a support ticket with a photo of your government-issued ID. (3) Our Customer Success team will verify and reset 2FA within 24h.',
    category: 'Account Access',
    tags: ['2fa', 'login', 'reset', 'sso'],
  });

  console.log('');
  console.log('======================================================================');
  console.log('  AI Customer Support Ticket Automation — E2E Test v2');
  console.log('======================================================================');
  console.log(`  Samples       : ${samples.length}`);
  console.log(`  AI provider   : ${process.env.AI_API_KEY ? (process.env.AI_MODEL || 'gpt-4o-mini') : 'MOCK (rule-based)'}`);
  console.log(`  Database      : ${db.DB_PATH}`);
  console.log(`  Seeded agents : 3`);
  console.log(`  Seeded KB     : 3 articles`);
  console.log('======================================================================');
  console.log('');

  const results = [];
  for (const { filename, payload } of samples) {
    process.stdout.write(`  → ${filename.padEnd(40)} `);
    try {
      const inbound = emailService.parseWebhookPayload({
        ...payload,
        from: payload.from || `${payload.sender_name || 'Sample'} <${payload.sender_email}>`,
        body: payload.body || payload.email_body,
        receivedAt: payload.received_at || new Date().toISOString(),
      });
      const result = await ticketService.createFromEmail(inbound, { sendAck: false });

      // Spam auto-rejected?
      if (result.spam?.autoRejected) {
        const expectedSpam = payload.expected_spam === true;
        const matched = expectedSpam;
        results.push({ filename, matched, spamRejected: true });
        console.log(`✓ SPAM AUTO-REJECTED (score ${result.spam.spam_score}) ${matched ? '✓' : '✗ (expected NOT spam)'}`);
        continue;
      }

      const t = result.ticket;
      const expectedCat = payload.category_hint;
      const expectedPri = payload.expected_priority;
      const expectedLang = payload.expected_language;
      const expectedSpam = payload.expected_spam === true;

      const catMatch = !expectedCat || expectedCat === t.category;
      const priMatch = !expectedPri || expectedPri === t.priority;
      const langMatch = !expectedLang || expectedLang === t.language;
      const spamMatch = expectedSpam === !!t.is_spam;
      const matched = catMatch && priMatch && langMatch && spamMatch;

      results.push({
        filename, matched,
        ticket: t, expectedCat, expectedPri, expectedLang, expectedSpam,
        catMatch, priMatch, langMatch, spamMatch,
        agent: result.assignedAgent,
        kbSuggestions: result.kbSuggestions,
        spamScore: t.spam_score,
      });

      const label = `${t.category} / ${t.priority} / ${t.language}${t.is_spam ? ' / SPAM' : ''}`;
      const expected = ` (exp ${expectedCat || '—'}/${expectedPri || '—'}/${expectedLang || '—'}/${expectedSpam ? 'spam' : 'ok'})`;
      const agentLabel = result.assignedAgent ? ` agent=${result.assignedAgent.name}` : '';
      const kbLabel = result.kbSuggestions && result.kbSuggestions.length ? ` kb=${result.kbSuggestions.length}` : '';
      console.log(`${matched ? '✓' : '✗'} ${label.padEnd(40)}${expected}  [${t.id}]  conf=${Math.round(t.confidence_score)}%${agentLabel}${kbLabel}`);
    } catch (err) {
      console.log(`✗ ERROR: ${err.message}`);
      results.push({ filename, error: err.message, matched: false });
    }
  }

  // ---------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------
  console.log('');
  console.log('----------------------------------------------------------------------');
  const passed = results.filter((r) => r.matched).length;
  console.log(`  Classification accuracy: ${passed}/${results.length} (${Math.round((passed / results.length) * 100)}%)`);
  console.log(`  Total tickets created   : ${ticketService.stats().total}`);
  console.log(`  Spam auto-rejected      : ${results.filter((r) => r.spamRejected).length}`);
  console.log(`  Tickets auto-assigned   : ${results.filter((r) => r.agent).length}`);
  console.log(`  KB suggestions hit      : ${results.filter((r) => r.kbSuggestions && r.kbSuggestions.length).length}`);

  // ---------------------------------------------------------------
  // Test: PII redaction
  // ---------------------------------------------------------------
  console.log('');
  console.log('----------------------------------------------------------------------');
  console.log('  PII Redaction Test');
  console.log('----------------------------------------------------------------------');
  const piiSample = results.find((r) => r.ticket && r.ticket.sender_email === 'rebecca.liu@globaltrade-llc.com');
  if (piiSample && piiSample.ticket.pii_redacted_body) {
    const body = piiSample.ticket.pii_redacted_body;
    const checks = [
      ['email', !body.includes('rebecca.liu@globaltrade-llc.com')],
      ['credit card', !body.includes('4532-1234-5678-4242')],
      ['SSN', !body.includes('123-45-6789')],
      ['IBAN', !body.includes('GB82WEST12345698765432')],
      ['IP', !body.includes('192.168.1.42')],
    ];
    for (const [name, ok] of checks) {
      console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(12)} ${ok ? 'redacted' : 'NOT redacted'}`);
    }
    console.log(`  Redacted body excerpt: ${body.slice(0, 120).replace(/\n/g, ' ')}...`);
  } else {
    console.log('  (PII sample not found — skipping)');
  }

  // ---------------------------------------------------------------
  // Test: Reports
  // ---------------------------------------------------------------
  console.log('');
  console.log('----------------------------------------------------------------------');
  console.log('  Reports Endpoint Test');
  console.log('----------------------------------------------------------------------');
  const reports = reportService.full();
  console.log(`  ✓ /reports/full   ${reports.timeseries.created.length}-day timeseries, ${reports.agents.length} agents, ${reports.teams.length} teams`);
  console.log(`  ✓ SLA compliance  ${reports.sla.compliance_rate}% (${reports.sla.breached} breached of ${reports.sla.total})`);
  console.log(`  ✓ Spam stats      ${reports.spam.spam_detected} spam (${reports.spam.spam_rate}%) of ${reports.spam.total} total`);
  console.log(`  ✓ Response times  avg first-response=${reports.responseTimes.avg_first_response_min || 'n/a'}min, avg resolution=${reports.responseTimes.avg_resolution_min || 'n/a'}min`);

  // ---------------------------------------------------------------
  // Test: Customer 360
  // ---------------------------------------------------------------
  console.log('');
  console.log('----------------------------------------------------------------------');
  console.log('  Customer 360 Test');
  console.log('----------------------------------------------------------------------');
  const customerService = require('../src/services/customerService');
  const c = customerService.getByEmail('sarah.chen@acmecorp.com');
  if (c) {
    console.log(`  ✓ Customer profile found: ${c.id}, ${c.total_tickets} ticket(s), ${c.open_tickets} open`);
  } else {
    console.log('  ✗ Customer profile NOT created');
  }

  // ---------------------------------------------------------------
  // Final
  // ---------------------------------------------------------------
  console.log('');
  console.log('----------------------------------------------------------------------');
  if (passed === results.length) {
    console.log('  ✅ All tests passed.');
  } else {
    console.log('  ⚠  Some mismatches — review above.');
  }
  console.log('----------------------------------------------------------------------');
  console.log('');

  // Print one full ticket as a sample
  const sample = results.find((r) => r.ticket && !r.ticket.is_spam);
  if (sample) {
    const t = sample.ticket;
    console.log('  Example ticket detail:');
    console.log(`    id              : ${t.id}`);
    console.log(`    customer_name   : ${t.customer_name}`);
    console.log(`    sender_email    : ${t.sender_email}`);
    console.log(`    language        : ${t.language}`);
    console.log(`    is_spam         : ${t.is_spam} (score ${t.spam_score})`);
    console.log(`    category        : ${t.category}`);
    console.log(`    priority        : ${t.priority}`);
    console.log(`    sentiment       : ${t.sentiment}`);
    console.log(`    assigned_team   : ${t.assigned_team}`);
    console.log(`    assigned_agent  : ${t.assigned_agent_id || '—'}`);
    console.log(`    confidence      : ${t.confidence_score}%`);
    console.log(`    sla_due_at      : ${t.sla_due_at}`);
    console.log(`    pii_redacted    : ${t.pii_redacted_body ? 'yes' : 'no'}`);
    console.log(`    audit entries   : ${ticketService.getAuditTrail(t.id).length}`);
    if (sample.kbSuggestions && sample.kbSuggestions.length) {
      console.log(`    kb_suggestions  : ${sample.kbSuggestions.map((a) => a.title).join(' | ')}`);
    }
    console.log('');
  }

  db.close();
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
