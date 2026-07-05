'use strict';

/**
 * Integration tests — boot the app, exercise the full HTTP API.
 *
 * Run: npm run test:integration
 *
 * Requires the server to be running on PORT (default 3000).
 * Or run `npm run test:integration:start` to auto-start.
 */

const http = require('http');
const assert = require('assert');

const PORT = process.env.PORT || 3000;
const BASE = `http://localhost:${PORT}`;

let passed = 0, failed = 0;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(`${BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        let json; try { json = JSON.parse(buf); } catch { json = buf; }
        resolve({ status: res.statusCode, body: json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}: ${err.message}`); }
}

async function main() {
  console.log('');
  console.log('======================================================');
  console.log('  Integration Tests — HTTP API');
  console.log('======================================================');
  console.log(`  Base URL: ${BASE}`);
  console.log('');

  // ---- Health ----
  await test('GET /api/health → 200', async () => {
    const r = await request('GET', '/api/health');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.status, 'ok');
  });

  await test('GET /api/v3/health/deep → 200 or 503', async () => {
    const r = await request('GET', '/api/v3/health/deep');
    assert.ok([200, 503].includes(r.status));
    assert.ok(r.body.checks);
  });

  await test('GET /api/v3/health/ready → 200', async () => {
    const r = await request('GET', '/api/v3/health/ready');
    assert.ok([200, 503].includes(r.status));
  });

  // ---- Metrics ----
  await test('GET /api/metrics → text/plain', async () => {
    const r = await request('GET', '/api/metrics');
    assert.strictEqual(r.status, 200);
    assert.ok(typeof r.body === 'string');
    assert.ok(r.body.includes('supportdesk_'));
  });

  // ---- Tickets ----
  let ticketId;
  await test('POST /api/ingest creates ticket', async () => {
    const r = await request('POST', '/api/ingest', {
      from: 'Integration Test <itest@example.com>',
      subject: 'Integration test ticket',
      body: 'This is an integration test ticket. Please help me with my account.',
    });
    assert.strictEqual(r.status, 201);
    assert.ok(r.body.ticket_id);
    ticketId = r.body.ticket_id;
  });

  await test('GET /api/tickets returns list', async () => {
    const r = await request('GET', '/api/tickets?limit=10');
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body));
    assert.ok(r.body.length > 0);
  });

  await test('GET /api/tickets/:id returns ticket', async () => {
    const r = await request('GET', `/api/tickets/${ticketId}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ticket.id, ticketId);
    assert.ok(r.body.audit);
  });

  await test('PATCH /api/tickets/:id updates status', async () => {
    const r = await request('PATCH', `/api/tickets/${ticketId}`, { status: 'In Progress' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.status, 'In Progress');
  });

  await test('POST /api/tickets/:id/notes adds note', async () => {
    const r = await request('POST', `/api/tickets/${ticketId}/notes`, { note: 'Integration test note' });
    assert.strictEqual(r.status, 200);
  });

  await test('POST /api/tickets/:id/suggest-reply returns text', async () => {
    const r = await request('POST', `/api/tickets/${ticketId}/suggest-reply`);
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.text);
  });

  await test('POST /api/tickets/:id/suggest-resolution returns plan', async () => {
    const r = await request('POST', `/api/tickets/${ticketId}/suggest-resolution`);
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.diagnosis);
    assert.ok(Array.isArray(r.body.steps));
  });

  // ---- Search ----
  await test('GET /api/tickets/search?q=... returns results', async () => {
    const r = await request('GET', '/api/tickets/search?q=integration');
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body));
  });

  // ---- Similarity ----
  await test('GET /api/v3/similarity/:ticketId returns array', async () => {
    const r = await request('GET', `/api/v3/similarity/${ticketId}`);
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body));
  });

  // ---- Agents ----
  let agentId;
  await test('POST /api/agents creates agent', async () => {
    const r = await request('POST', '/api/agents', {
      name: 'Integration Agent', email: 'iagent@example.com',
      team: 'Technical Support', role: 'agent', skills: ['Technical Support'],
    });
    assert.strictEqual(r.status, 201);
    agentId = r.body.id;
  });

  await test('GET /api/agents returns list', async () => {
    const r = await request('GET', '/api/agents');
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body));
  });

  await test('GET /api/agents/workload returns workload', async () => {
    const r = await request('GET', '/api/agents/workload');
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body));
  });

  await test('POST /api/agents/:id/api-keys returns plaintext', async () => {
    const r = await request('POST', `/api/agents/${agentId}/api-keys`, { name: 'test' });
    assert.strictEqual(r.status, 201);
    assert.ok(r.body.plaintext);
    assert.ok(r.body.plaintext.startsWith('sk_live_'));
  });

  // ---- KB ----
  let kbId;
  await test('POST /api/kb creates article', async () => {
    const r = await request('POST', '/api/kb', {
      title: 'Integration Test KB Article',
      summary: 'Test article',
      content: 'This is a test KB article about integration testing.',
      category: 'Technical Support',
      tags: ['test', 'integration'],
    });
    assert.strictEqual(r.status, 201);
    kbId = r.body.id;
  });

  await test('GET /api/kb returns list', async () => {
    const r = await request('GET', '/api/kb');
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body));
  });

  await test('GET /api/kb/search?q=... returns results', async () => {
    const r = await request('GET', '/api/kb/search?q=integration');
    assert.strictEqual(r.status, 200);
  });

  // ---- Macros ----
  let macroId;
  await test('POST /api/v3/macros creates macro', async () => {
    const r = await request('POST', '/api/v3/macros', {
      name: 'Integration Test Macro',
      bodyTemplate: 'Hello {{first_name}}, your ticket {{ticket_id}} is being reviewed.',
      category: 'Technical Support',
    });
    assert.strictEqual(r.status, 201);
    macroId = r.body.id;
  });

  await test('POST /api/v3/macros/:id/apply renders template', async () => {
    const r = await request('POST', `/api/v3/macros/${macroId}/apply`, { ticketId });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.body);
  });

  // ---- Workflows ----
  let workflowId;
  await test('POST /api/v3/workflows creates rule', async () => {
    const r = await request('POST', '/api/v3/workflows', {
      name: 'Integration Test Workflow',
      triggerEvent: 'ticket_created',
      conditions: [{ field: 'priority', op: 'eq', value: 'Critical' }],
      actions: [{ type: 'add_tag', params: { tagName: 'auto-critical' } }],
    });
    assert.strictEqual(r.status, 201);
    workflowId = r.body.id;
  });

  await test('POST /api/v3/workflows/:id/test evaluates conditions', async () => {
    const r = await request('POST', `/api/v3/workflows/${workflowId}/test`, { ticketId });
    assert.strictEqual(r.status, 200);
    assert.ok(typeof r.body.matched === 'boolean');
  });

  // ---- Custom fields ----
  await test('POST /api/v3/custom-fields creates field', async () => {
    const r = await request('POST', '/api/v3/custom-fields', {
      name: 'test_field', label: 'Test Field', type: 'text',
    });
    assert.strictEqual(r.status, 201);
  });

  await test('PUT /api/v3/tickets/:ticketId/custom-fields/:fieldName sets value', async () => {
    const r = await request('PUT', `/api/v3/tickets/${ticketId}/custom-fields/test_field`, { value: 'hello' });
    assert.strictEqual(r.status, 200);
  });

  // ---- Snooze ----
  await test('POST /api/v3/snoozes/:ticketId snoozes', async () => {
    const r = await request('POST', `/api/v3/snoozes/${ticketId}`, {
      snoozedUntil: new Date(Date.now() + 3600 * 1000).toISOString(),
      reason: 'integration test',
    });
    assert.strictEqual(r.status, 201);
  });

  await test('DELETE /api/v3/snoozes/:ticketId wakes', async () => {
    const r = await request('DELETE', `/api/v3/snoozes/${ticketId}`);
    assert.strictEqual(r.status, 200);
  });

  // ---- SLA policies ----
  await test('POST /api/v3/sla-policies creates policy', async () => {
    const r = await request('POST', '/api/v3/sla-policies', {
      name: 'Integration Test SLA',
      priority: 'Critical',
      resolutionHours: 1,
    });
    assert.strictEqual(r.status, 201);
  });

  // ---- Scheduled reports ----
  await test('POST /api/v3/scheduled-reports creates report', async () => {
    const r = await request('POST', '/api/v3/scheduled-reports', {
      name: 'Integration Test Report',
      frequency: 'daily',
      hour: 9,
      recipientEmails: ['test@example.com'],
      format: 'html',
    });
    assert.strictEqual(r.status, 201);
  });

  // ---- Outbound webhooks ----
  await test('GET /api/v3/webhooks-out returns list', async () => {
    const r = await request('GET', '/api/v3/webhooks-out');
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body));
  });

  // ---- Translations ----
  await test('GET /api/v3/translations/languages returns map', async () => {
    const r = await request('GET', '/api/v3/translations/languages');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.languages);
    assert.ok(r.body.languages.en);
  });

  await test('POST /api/v3/translations/:ticketId translates (mock)', async () => {
    const r = await request('POST', `/api/v3/translations/${ticketId}`, { targetLanguage: 'es' });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.translatedBody);
  });

  // ---- Audit search ----
  await test('GET /api/v3/audit/search returns results', async () => {
    const r = await request('GET', '/api/v3/audit/search?limit=10');
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body));
  });

  await test('GET /api/v3/audit/stats returns counts', async () => {
    const r = await request('GET', '/api/v3/audit/stats');
    assert.strictEqual(r.status, 200);
    assert.ok(typeof r.body.total === 'number');
  });

  // ---- Settings ----
  await test('GET /api/v3/settings returns list', async () => {
    const r = await request('GET', '/api/v3/settings');
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body));
  });

  await test('GET /api/v3/settings/brand.name returns value', async () => {
    const r = await request('GET', '/api/v3/settings/brand.name');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.value);
  });

  // ---- Backup stats ----
  await test('GET /api/v3/backup/stats returns DB info', async () => {
    const r = await request('GET', '/api/v3/backup/stats');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.fileSizeBytes);
    assert.ok(r.body.tableCounts);
  });

  // ---- Reports ----
  await test('GET /api/reports/full returns full report', async () => {
    const r = await request('GET', '/api/reports/full');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.timeseries);
  });

  // ---- Customers ----
  await test('GET /api/customers/:email returns 360 view', async () => {
    const r = await request('GET', '/api/customers/itest@example.com');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.profile);
    assert.ok(r.body.tickets);
  });

  // ---- Cleanup ----
  await test('DELETE /api/tickets/:id... (close the test ticket)', async () => {
    const r = await request('PATCH', `/api/tickets/${ticketId}`, { status: 'Closed' });
    assert.strictEqual(r.status, 200);
  });

  // ---- Summary ----
  console.log('');
  console.log('------------------------------------------------------');
  console.log(`  Passed: ${passed}  Failed: ${failed}`);
  console.log('------------------------------------------------------');
  if (failed > 0) {
    console.log('  ⚠  Some integration tests failed.');
    process.exit(1);
  } else {
    console.log('  ✅ All integration tests passed.');
  }
  console.log('');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
