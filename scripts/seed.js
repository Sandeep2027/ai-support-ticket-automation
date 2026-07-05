'use strict';

/**
 * Seed script — applies the schema and (optionally) loads a configurable
 * number of sample tickets into a fresh database. Useful for demos and for
 * resetting state between tests.
 *
 * Usage:
 *   node scripts/seed.js                # apply schema + seed routing config
 *   node scripts/seed.js --init-only    # only apply schema
 *   node scripts/seed.js --samples      # also ingest all sample emails
 *   node scripts/seed.js --reset        # drop & recreate all data, then seed
 */

const path = require('path');
const fs = require('fs');

const config = require('../src/config');
const db = require('../src/database/db');
const emailService = require('../src/services/emailService');
const ticketService = require('../src/services/ticketService');

const args = new Set(process.argv.slice(2));
const INIT_ONLY = args.has('--init-only');
const WITH_SAMPLES = args.has('--samples');
const RESET = args.has('--reset');

const SAMPLES_DIR = config.paths.samples;

function reset() {
  console.log('Resetting database...');
  const d = db.getDb();
  d.exec(`
    DROP TABLE IF EXISTS tickets;
    DROP TABLE IF EXISTS attachments;
    DROP TABLE IF EXISTS audit_trail;
    DROP TABLE IF EXISTS ticket_notes;
    DROP TABLE IF EXISTS routing_config;
    DROP TABLE IF EXISTS inbox_log;
  `);
  console.log('Tables dropped.');
}

async function loadSamples() {
  if (!fs.existsSync(SAMPLES_DIR)) {
    console.log('No samples directory at', SAMPLES_DIR);
    return;
  }
  const files = fs.readdirSync(SAMPLES_DIR).filter((f) => f.endsWith('.json')).sort();
  console.log(`Loading ${files.length} sample emails...`);
  for (const filename of files) {
    const payload = JSON.parse(fs.readFileSync(path.join(SAMPLES_DIR, filename), 'utf8'));
    const inbound = emailService.parseWebhookPayload({
      ...payload,
      from: payload.from || `${payload.sender_name || 'Sample'} <${payload.sender_email}>`,
      body: payload.body || payload.email_body,
      receivedAt: payload.received_at || new Date().toISOString(),
    });
    const result = await ticketService.createFromEmail(inbound, { sendAck: false });
    console.log(`  ✓ ${filename.padEnd(40)} → ${result.ticket.id}  [${result.ticket.category} / ${result.ticket.priority}]`);
  }
}

async function main() {
  console.log('==================================================');
  console.log('  Seed script');
  console.log('==================================================');
  console.log(`  DB path      : ${db.DB_PATH}`);
  console.log(`  Reset        : ${RESET}`);
  console.log(`  Init only    : ${INIT_ONLY}`);
  console.log(`  Load samples : ${WITH_SAMPLES}`);
  console.log('==================================================');

  if (RESET) reset();

  // Apply schema (idempotent)
  db.getDb();
  console.log('Schema applied.');

  if (INIT_ONLY) {
    db.close();
    return;
  }

  // routing_config is seeded by schema.sql (INSERT OR IGNORE)
  console.log('Routing config:', db.all('SELECT * FROM routing_config').map((r) => `${r.category}→${r.team}`).join(', '));

  if (WITH_SAMPLES) {
    await loadSamples();
  }

  console.log('Done.');
  db.close();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
