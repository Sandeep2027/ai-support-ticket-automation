'use strict';

/**
 * Email ingestion & parsing.
 *
 * Supports three input shapes, all normalised into a single InboundEmail:
 *   1. JSON payload from a webhook (e.g. n8n, SendGrid Inbound Parse, Mailgun)
 *   2. Raw .eml file (RFC 822) — parsed with a tiny header/body splitter
 *      (no external mailparser dependency to keep install lean)
 *   3. Manual JSON { from, name, subject, body, attachments[] }
 *
 * Attachments are persisted to disk by attachmentService; this module only
 * extracts them into a normalised list.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger').child('email');
const { isValidEmail, normalizeEmail, asString } = require('../utils/validator');
const { generateId } = require('../utils/helpers');

const log = logger;

/**
 * @typedef {Object} InboundEmail
 * @property {string} messageId
 * @property {string} senderName
 * @property {string} senderEmail
 * @property {string} subject
 * @property {string} body                 plain-text body
 * @property {string} receivedAt           ISO 8601
 * @property {Array<{filename:string, mimeType:string, sizeBytes:number, content: Buffer|string, dataUrl?:string}>} attachments
 * @property {string} source               'webhook' | 'eml' | 'manual' | 'json-file'
 * @property {object} raw                  original payload (for audit)
 */

/**
 * Parse an inbound .eml file from disk into a normalised InboundEmail.
 */
function parseEmlFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return parseEmlString(raw, path.basename(filePath));
}

/**
 * Parse a raw RFC 822 .eml string. Handles headers, multipart/mixed and
 * multipart/alternative boundaries, base64 attachments, and quoted-printable
 * text. This is a pragmatic implementation — good enough for the sample
 * fixtures and most real-world inbound emails. For exotic encodings you can
 * swap in `mailparser` without changing the public contract.
 */
function parseEmlString(raw, sourceName = 'inbound.eml') {
  const headerEnd = raw.indexOf('\r\n\r\n');
  const sep = headerEnd >= 0 ? '\r\n\r\n' : '\n\n';
  const idx = headerEnd >= 0 ? headerEnd : raw.indexOf('\n\n');
  const headerBlock = raw.slice(0, idx);
  const bodyBlock = raw.slice(idx + sep.length);

  const headers = parseHeaders(headerBlock);

  const from = headers['from'] || '';
  const { name, email } = parseFromHeader(from);
  const subject = decodeMimeHeader(headers['subject'] || '(no subject)');
  const date = headers['date'] ? new Date(headers['date']).toISOString() : new Date().toISOString();
  const messageId = headers['message-id'] || generateId('msg');

  const contentType = headers['content-type'] || 'text/plain';
  const attachments = [];

  let body = '';
  if (/multipart\//i.test(contentType)) {
    const boundary = (contentType.match(/boundary\s*=\s*"?([^";\s]+)"?/i) || [])[1];
    if (boundary) {
      const parts = splitMultipart(bodyBlock, boundary);
      for (const part of parts) {
        const partHeaders = parseHeaders(part.headerBlock);
        const cd = partHeaders['content-disposition'] || '';
        const ct = partHeaders['content-type'] || 'text/plain';
        const encoding = (partHeaders['content-transfer-encoding'] || '').toLowerCase();
        if (/attachment/i.test(cd) || /filename\s*=/i.test(cd)) {
          const filename = decodeMimeHeader((cd.match(/filename\s*=\s*"?([^";\s]+)"?/i) || [])[1] || 'attachment');
          attachments.push({
            filename,
            mimeType: ct.split(';')[0].trim(),
            sizeBytes: Buffer.byteLength(part.body),
            content: decodeBody(part.body, encoding),
          });
        } else if (/text\/plain/i.test(ct)) {
          body = decodeBody(part.body, encoding).trim();
        } else if (/text\/html/i.test(ct) && !body) {
          body = decodeBody(part.body, encoding).trim();
        }
      }
    }
  } else {
    const encoding = (headers['content-transfer-encoding'] || '').toLowerCase();
    body = decodeBody(bodyBlock, encoding).trim();
  }

  return {
    messageId,
    senderName: name,
    senderEmail: email,
    subject,
    body,
    receivedAt: date,
    attachments,
    source: 'eml',
    raw: { sourceName, from, subject, date },
  };
}

function parseHeaders(block) {
  const out = {};
  // Unfold continuation lines (line starting with whitespace)
  const lines = block.replace(/\r\n/g, '\n').split('\n');
  let current = null;
  for (const line of lines) {
    if (/^\s/.test(line) && current) {
      out[current] += ' ' + line.trim();
    } else {
      const m = line.match(/^([A-Za-z0-9-]+)\s*:\s*(.*)$/);
      if (m) {
        current = m[1].toLowerCase();
        out[current] = m[2].trim();
      }
    }
  }
  return out;
}

function splitMultipart(body, boundary) {
  const delim = '--' + boundary;
  const parts = body.split(delim).slice(1, -1); // drop prologue & epilogue
  return parts.map((p) => {
    const p2 = p.replace(/^\r?\n/, '');
    const idx = p2.indexOf('\r\n\r\n');
    const sep = idx >= 0 ? '\r\n\r\n' : '\n\n';
    const splitIdx = idx >= 0 ? idx : p2.indexOf('\n\n');
    return {
      headerBlock: p2.slice(0, splitIdx),
      body: p2.slice(splitIdx + sep.length).replace(/\r?\n--$/, ''),
    };
  });
}

function decodeBody(body, encoding) {
  if (encoding === 'base64') {
    try { return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8'); } catch { return body; }
  }
  if (encoding === 'quoted-printable') {
    return body
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return body;
}

function decodeMimeHeader(s) {
  if (!s) return '';
  return s.replace(/=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi, (_, _charset, enc, text) => {
    if (enc.toUpperCase() === 'B') {
      try { return Buffer.from(text, 'base64').toString('utf8'); } catch { return text; }
    }
    return text.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  });
}

function parseFromHeader(from) {
  // "John Doe <john@example.com>"  or  "john@example.com"
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  return { name: '', email: from.trim().toLowerCase() };
}

/**
 * Build an InboundEmail from a webhook payload. Accepts several common shapes:
 *   • SendGrid Inbound Parse: { from, subject, text, html, attachments: {...} }
 *   • Mailgun: { sender, subject, body-plain, attachments }
 *   • Our own: { from, name, subject, body, receivedAt, attachments[] }
 */
function parseWebhookPayload(payload) {
  const fromRaw = payload.from || payload.sender || payload.fromEmail || '';
  const { name, email } = parseFromHeader(fromRaw);
  const subject = asString(payload.subject || payload.Subject || '(no subject)');
  const body = asString(payload.body || payload.text || payload['body-plain'] || payload.html || '');
  const receivedAt = payload.receivedAt || payload.Date || new Date().toISOString();
  const messageId = payload.messageId || payload['Message-Id'] || generateId('msg');

  const attachments = [];
  // Our shape
  if (Array.isArray(payload.attachments)) {
    for (const a of payload.attachments) {
      const content = a.contentBase64
        ? Buffer.from(a.contentBase64, 'base64')
        : Buffer.from(a.content || '', 'utf8');
      attachments.push({
        filename: a.filename || a.name || generateId('file'),
        mimeType: a.mimeType || a.type || 'application/octet-stream',
        sizeBytes: content.length,
        content,
      });
    }
  }

  return {
    messageId,
    senderName: payload.name || name,
    senderEmail: email || (payload.fromEmail || ''),
    subject,
    body,
    receivedAt,
    attachments,
    source: 'webhook',
    raw: payload,
  };
}

/**
 * Validate an InboundEmail — returns { ok, errors[] }.
 */
function validateInbound(e) {
  const errors = [];
  if (!e) { errors.push('payload is empty'); return { ok: false, errors }; }
  if (!isValidEmail(e.senderEmail)) errors.push(`invalid sender email: "${e.senderEmail}"`);
  if (!e.subject && !e.body) errors.push('email has neither subject nor body');
  if (e.body && e.body.length > 200_000) errors.push('email body too large');
  // Attachment size limit
  const limit = config.email.maxAttachmentMb * 1024 * 1024;
  for (const a of e.attachments || []) {
    if (a.sizeBytes > limit) errors.push(`attachment ${a.filename} exceeds ${config.email.maxAttachmentMb}MB`);
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  parseEmlFile,
  parseEmlString,
  parseWebhookPayload,
  parseFromHeader,
  validateInbound,
};
