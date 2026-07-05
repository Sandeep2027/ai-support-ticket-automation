'use strict';

/**
 * Unit tests — pure functions in utils/validator, utils/helpers, services.
 *
 * Run: npm run test:unit
 */

const path = require('path');
process.chdir(__dirname + '/..');

const assert = require('assert');
const validator = require('../src/utils/validator');
const helpers = require('../src/utils/helpers');
const aiService = require('../src/services/aiService');

let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}: ${err.message}`); }
}

console.log('');
console.log('======================================================');
console.log('  Unit Tests — validator + helpers + aiService');
console.log('======================================================');
console.log('');

// ---- validator ----
console.log('validator.js:');

test('safeJsonParse valid', () => {
  const r = validator.safeJsonParse('{"a":1}');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.a, 1);
});

test('safeJsonParse invalid', () => {
  const r = validator.safeJsonParse('not json');
  assert.strictEqual(r.ok, false);
  assert.ok(r.error);
});

test('safeJsonParse strips markdown fences', () => {
  const r = validator.safeJsonParse('```json\n{"a":1}\n```');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.a, 1);
});

test('asString trims', () => {
  assert.strictEqual(validator.asString('  hello  '), 'hello');
});

test('asString truncates', () => {
  assert.strictEqual(validator.asString('hello world', 5).length, 5);
});

test('asArray dedupes', () => {
  assert.deepStrictEqual(validator.asArray(['a', 'b', 'a', 'c']), ['a', 'b', 'c']);
});

test('asArray filters empty', () => {
  assert.deepStrictEqual(validator.asArray(['a', '', 'b']), ['a', 'b']);
});

test('asNumber clamps', () => {
  assert.strictEqual(validator.asNumber(150, 0, 0, 100), 100);
  assert.strictEqual(validator.asNumber(-5, 0, 0, 100), 0);
});

test('asNumber handles NaN', () => {
  assert.strictEqual(validator.asNumber('abc', 50, 0, 100), 50);
});

test('asCategory matches exact', () => {
  assert.strictEqual(validator.asCategory('Technical Support'), 'Technical Support');
});

test('asCategory fuzzy match', () => {
  assert.strictEqual(validator.asCategory('technical-support'), 'Technical Support');
});

test('asCategory fallback', () => {
  assert.strictEqual(validator.asCategory('something weird'), 'General Inquiry');
});

test('asPriority keyword', () => {
  assert.strictEqual(validator.asPriority('urgent'), 'Critical');
  assert.strictEqual(validator.asPriority('p2'), 'High');
  assert.strictEqual(validator.asPriority('low'), 'Low');
  assert.strictEqual(validator.asPriority(''), 'Medium');
});

test('asSentiment keyword', () => {
  assert.strictEqual(validator.asSentiment('positive'), 'Positive');
  assert.strictEqual(validator.asSentiment('NEGATIVE'), 'Negative');
  assert.strictEqual(validator.asSentiment(''), 'Neutral');
});

test('asStatus validates', () => {
  assert.strictEqual(validator.asStatus('Open'), 'Open');
  assert.strictEqual(validator.asStatus('invalid'), 'Open');
});

test('isValidEmail', () => {
  assert.strictEqual(validator.isValidEmail('a@b.com'), true);
  assert.strictEqual(validator.isValidEmail('not-an-email'), false);
  assert.strictEqual(validator.isValidEmail(''), false);
});

test('normalizeEmail lowercases', () => {
  assert.strictEqual(validator.normalizeEmail('John@Example.COM'), 'john@example.com');
});

// ---- helpers ----
console.log('');
console.log('helpers.js:');

test('generateTicketId format', () => {
  const id = helpers.generateTicketId();
  assert.match(id, /^TKT-\d{8}-[A-Z0-9]{4}$/);
});

test('nowIso returns ISO 8601', () => {
  const t = helpers.nowIso();
  assert.match(t, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test('computeSlaDue returns ISO', () => {
  const due = helpers.computeSlaDue('Critical', new Date('2026-07-05T10:00:00Z'));
  // Critical = 2h
  assert.strictEqual(due, '2026-07-05T12:00:00.000Z');
});

test('truncate adds ellipsis', () => {
  assert.strictEqual(helpers.truncate('hello world', 8), 'hello w…');
  assert.strictEqual(helpers.truncate('hi', 10), 'hi');
});

test('stripHtml removes tags', () => {
  assert.strictEqual(helpers.stripHtml('<p>hello</p>'), 'hello');
  assert.strictEqual(helpers.stripHtml('<script>alert(1)</script>hi'), 'hi');
});

test('fingerprint is deterministic', () => {
  assert.strictEqual(helpers.fingerprint('hello'), helpers.fingerprint('hello'));
  assert.notStrictEqual(helpers.fingerprint('hello'), helpers.fingerprint('world'));
});

test('fingerprint ignores case + non-alnum', () => {
  assert.strictEqual(helpers.fingerprint('Hello, World!'), helpers.fingerprint('helloworld'));
});

// ---- aiService (mock functions) ----
console.log('');
console.log('aiService.js (mock functions):');

test('mockAnalyze returns valid shape', () => {
  const r = aiService.mockAnalyze({ subject: 'Cannot login', body: 'I cannot login, urgent', senderEmail: 'a@b.com' });
  assert.ok(r.category);
  assert.ok(r.priority);
  assert.ok(r.sentiment);
  assert.ok(r.confidence_score >= 0 && r.confidence_score <= 100);
  assert.ok(r.spam_score >= 0 && r.spam_score <= 100);
  assert.ok(r.language);
});

test('mockAnalyze detects Critical', () => {
  const r = aiService.mockAnalyze({ subject: 'URGENT', body: 'production down, emergency', senderEmail: 'a@b.com' });
  assert.strictEqual(r.priority, 'Critical');
});

test('mockAnalyze detects Refund', () => {
  const r = aiService.mockAnalyze({ subject: 'Refund please', body: 'I want a refund for the duplicate charge', senderEmail: 'a@b.com' });
  assert.strictEqual(r.category, 'Refund Request');
});

test('mockSpam high for spam keywords', () => {
  const r = aiService.mockSpam('CONGRATULATIONS', 'click here for free iPhone http://spam.example');
  assert.ok(r.spam_score > 50);
});

test('mockSpam low for genuine support', () => {
  const r = aiService.mockSpam('Cannot login', 'I cannot access my account, please help');
  assert.ok(r.spam_score < 30);
});

test('detectLanguageSimple en', () => {
  assert.strictEqual(aiService.detectLanguageSimple('I cannot login to my account'), 'en');
});

test('detectLanguageSimple es', () => {
  assert.strictEqual(aiService.detectLanguageSimple('no puedo acceder a mi cuenta, por favor ayuda'), 'es');
});

test('detectLanguageSimple fr', () => {
  assert.strictEqual(aiService.detectLanguageSimple('Bonjour, merci par avance pour votre aide'), 'fr');
});

test('redactPii redacts emails', () => {
  const r = aiService.redactPii('Contact me at john@example.com please');
  assert.ok(!r.includes('john@example.com'));
  assert.ok(r.includes('[REDACTED_EMAIL]'));
});

test('redactPii redacts credit cards', () => {
  const r = aiService.redactPii('My card is 4532-1234-5678-4242');
  assert.ok(!r.includes('4532-1234-5678-4242'));
  assert.ok(r.includes('[REDACTED_CC]'));
});

test('redactPii redacts SSNs', () => {
  const r = aiService.redactPii('SSN: 123-45-6789');
  assert.ok(r.includes('[REDACTED_SSN]'));
});

test('suggestKbArticles scores by overlap', () => {
  const ticket = { email_subject: 'API 500 error', email_body: 'getting 500 errors', issue_summary: 'API down', suggested_tags: ['api', 'error'] };
  const articles = [
    { id: '1', title: 'Resolving API 500 Errors', content: '500 error api', summary: '', category: 'Technical Support', tags: '["api","error"]' },
    { id: '2', title: 'Refund Policy', content: 'how to get a refund', summary: '', category: 'Billing', tags: '["refund"]' },
  ];
  const r = aiService.suggestKbArticles(ticket, articles, 3);
  assert.ok(r.length >= 1);
  assert.strictEqual(r[0].id, '1'); // API article should rank first
});

// ---- Summary ----
console.log('');
console.log('------------------------------------------------------');
console.log(`  Passed: ${passed}  Failed: ${failed}`);
console.log('------------------------------------------------------');
if (failed > 0) {
  console.log('  ⚠  Some tests failed.');
  process.exit(1);
} else {
  console.log('  ✅ All unit tests passed.');
}
console.log('');
