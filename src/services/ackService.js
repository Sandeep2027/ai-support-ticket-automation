'use strict';

/**
 * Acknowledgment service — sends a "we received your ticket" email to the
 * customer. Uses nodemailer when SMTP is configured; otherwise logs the
 * would-be email so the workflow can still be demoed end-to-end.
 */

const nodemailer = require('nodemailer');
const config = require('../config');
const logger = require('../utils/logger').child('ack');
const { isValidEmail } = require('../utils/validator');

const log = logger;

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!config.smtp.enabled) return null;
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
  return transporter;
}

function buildEmail(ticket) {
  const slaHours = config.sla[ticket.priority] ?? config.sla.Medium;
  const eta =
    ticket.priority === 'Critical' ? 'within 2 hours' :
    ticket.priority === 'High' ? 'within 8 hours' :
    ticket.priority === 'Medium' ? 'within 24 hours' :
    'within 72 hours';

  const text = `Hello ${ticket.customer_name || 'there'},

Thank you for contacting our support team. We have received your request and created a ticket for you.

  Ticket ID : ${ticket.id}
  Subject   : ${ticket.email_subject || '(no subject)'}
  Category  : ${ticket.category}
  Priority  : ${ticket.priority}
  Status    : ${ticket.status}

Summary of your issue:
${ticket.issue_summary || '(no summary available)'}

Our ${ticket.assigned_team || 'support'} team will review it and respond ${eta}. If you have any additional information, just reply to this email and it will be appended to your ticket.

Best regards,
Support Team`;

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#1f2937">
  <h2 style="color:#4f46e5">We've received your request</h2>
  <p>Hello ${ticket.customer_name || 'there'},</p>
  <p>Thank you for contacting our support team. We have received your request and created a ticket for you.</p>
  <table style="width:100%;border-collapse:collapse;margin:16px 0">
    <tr><td style="padding:6px 0;color:#6b7280">Ticket ID</td><td style="padding:6px 0;font-weight:600">${ticket.id}</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280">Subject</td><td style="padding:6px 0">${ticket.email_subject || '(no subject)'}</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280">Category</td><td style="padding:6px 0">${ticket.category}</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280">Priority</td><td style="padding:6px 0">${ticket.priority}</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280">Status</td><td style="padding:6px 0">${ticket.status}</td></tr>
  </table>
  <p style="background:#f3f4f6;padding:12px;border-radius:6px"><strong>Issue summary:</strong><br>${ticket.issue_summary || '(no summary available)'}</p>
  <p>Our <strong>${ticket.assigned_team || 'support'}</strong> team will review it and respond <strong>${eta}</strong>.</p>
  <p style="color:#6b7280;font-size:13px">If you have any additional information, just reply to this email and it will be appended to your ticket.</p>
  <p>Best regards,<br>Support Team</p>
</div>`;

  return { text, html, subject: `[${ticket.id}] We've received your support request` };
}

/**
 * Send the acknowledgment email for a ticket.
 * @returns {Promise<{sent:boolean, to:string, error?:string, messageId?:string}>}
 */
async function send(ticket) {
  if (!isValidEmail(ticket.sender_email)) {
    return { sent: false, to: ticket.sender_email, error: 'invalid recipient email' };
  }
  const { text, html, subject } = buildEmail(ticket);
  const t = getTransporter();
  if (!t) {
    log.info('SMTP disabled — logging acknowledgment instead of sending', { to: ticket.sender_email, ticketId: ticket.id });
    log.info('--- ACK EMAIL ---\n' + text + '\n--- END ---');
    return { sent: false, to: ticket.sender_email, logged: true };
  }
  try {
    const info = await t.sendMail({
      from: config.smtp.from,
      to: ticket.sender_email,
      subject,
      text,
      html,
    });
    log.info('Acknowledgment sent', { to: ticket.sender_email, ticketId: ticket.id, messageId: info.messageId });
    return { sent: true, to: ticket.sender_email, messageId: info.messageId };
  } catch (err) {
    log.error('Failed to send acknowledgment', { error: err.message, ticketId: ticket.id });
    return { sent: false, to: ticket.sender_email, error: err.message };
  }
}

module.exports = { send, buildEmail };
