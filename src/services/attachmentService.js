'use strict';

/**
 * Attachment persistence. Files are written to /uploads/<ticketId>/<uuid-<filename>>
 * and indexed in the `attachments` table. We never trust the client-provided
 * filename for the on-disk path (path-traversal safe).
 */

const fs = require('fs');
const path = require('path');
const db = require('../database/db');
const config = require('../config');
const logger = require('../utils/logger').child('attachments');
const { generateId } = require('../utils/helpers');

const log = logger;

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

/**
 * Persist a list of attachments for a ticket.
 * @param {string} ticketId
 * @param {Array<{filename:string, mimeType?:string, sizeBytes?:number, content: Buffer|string}>} attachments
 * @returns {Array<{id:string, filename:string, storagePath:string, mimeType:string, sizeBytes:number}>}
 */
function persistForTicket(ticketId, attachments) {
  if (!attachments || attachments.length === 0) return [];
  const ticketDir = path.join(config.paths.uploads, ticketId);
  ensureDir(ticketDir);

  const saved = [];
  for (const a of attachments) {
    const safeName = String(a.filename || 'attachment').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
    const id = generateId('att');
    const onDisk = `${id}-${safeName}`;
    const fullPath = path.join(ticketDir, onDisk);
    const buf = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content || '', 'utf8');
    fs.writeFileSync(fullPath, buf);
    const storagePath = path.join(ticketId, onDisk); // relative to /uploads
    db.run(
      `INSERT INTO attachments (id, ticket_id, filename, mime_type, size_bytes, storage_path, created_at)
       VALUES (@id, @ticketId, @filename, @mime, @size, @storagePath, @createdAt)`,
      {
        id,
        ticketId,
        filename: a.filename || onDisk,
        mime: a.mimeType || 'application/octet-stream',
        size: buf.length,
        storagePath,
        createdAt: new Date().toISOString(),
      }
    );
    saved.push({ id, filename: a.filename || onDisk, storagePath, mimeType: a.mimeType || 'application/octet-stream', sizeBytes: buf.length });
    log.info('Stored attachment', { ticketId, filename: a.filename, size: buf.length });
  }
  return saved;
}

function listForTicket(ticketId) {
  return db.all(`SELECT * FROM attachments WHERE ticket_id = @ticketId ORDER BY created_at ASC`, { ticketId });
}

function get(id) {
  return db.get(`SELECT * FROM attachments WHERE id = @id`, { id });
}

function absolutePath(storagePath) {
  return path.join(config.paths.uploads, storagePath);
}

module.exports = { persistForTicket, listForTicket, get, absolutePath };
