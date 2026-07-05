'use strict';

/**
 * Translation Service — AI-powered translation of ticket content.
 *
 * Caches translations in the ticket_translations table (one row per
 * ticket+target_language pair) to avoid re-paying for the same translation.
 *
 * When auto-translate is enabled (system_settings.ai.auto_translate=true),
 * non-English tickets are automatically translated to English on creation.
 * Agents can also request on-demand translation to any supported language.
 */

const db = require('../database/db');
const config = require('../config');
const { nowIso } = require('../utils/helpers');
const { asString } = require('../utils/validator');
const logger = require('../utils/logger').child('translation');
const aiService = require('./aiService');
const log = logger;

const SUPPORTED_LANGUAGES = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
  pt: 'Portuguese', nl: 'Dutch', ru: 'Russian', pl: 'Polish', ja: 'Japanese',
  zh: 'Chinese (Simplified)', ko: 'Korean', ar: 'Arabic', hi: 'Hindi',
  tr: 'Turkish', sv: 'Swedish', no: 'Norwegian', da: 'Danish', fi: 'Finnish',
  cs: 'Czech', el: 'Greek', he: 'Hebrew', th: 'Thai', vi: 'Vietnamese',
  id: 'Indonesian', ms: 'Malay', uk: 'Ukrainian', ro: 'Romanian', hu: 'Hungarian',
};

const TRANSLATION_PROMPT = `You are a professional translator. Translate the following text from {sourceLang} to {targetLang}. 

Rules:
- Preserve the original tone and formality.
- Do NOT translate proper nouns, product names, email addresses, URLs, or code snippets.
- Preserve line breaks and formatting.
- If the text is already in {targetLang}, return it unchanged.
- Return ONLY the translated text, no explanations, no preamble.

Text to translate:
{text}`;

/**
 * Translate a ticket's subject + body to a target language.
 * Uses cached translation if available.
 */
async function translateTicket(ticketId, targetLanguage = 'en') {
  if (!SUPPORTED_LANGUAGES[targetLanguage]) {
    throw new Error(`unsupported language: ${targetLanguage}`);
  }

  // Check cache
  const cached = db.get(
    `SELECT * FROM ticket_translations WHERE ticket_id = @ticketId AND target_language = @targetLang`,
    { ticketId, targetLang: targetLanguage }
  );
  if (cached) {
    log.debug('Translation cache hit', { ticketId, targetLanguage });
    return {
      ticketId, targetLanguage,
      translatedSubject: cached.translated_subject,
      translatedBody: cached.translated_body,
      cached: true, model: cached.model,
    };
  }

  // Get ticket
  const ticket = db.get(`SELECT * FROM tickets WHERE id = @id`, { id: ticketId });
  if (!ticket) throw new Error('ticket not found');

  const sourceLang = ticket.language || 'en';

  // If source == target, no translation needed
  if (sourceLang === targetLanguage) {
    const result = {
      ticketId, targetLanguage,
      translatedSubject: ticket.email_subject,
      translatedBody: ticket.email_body,
      cached: false, model: 'none (same language)',
    };
    cacheTranslation(ticketId, targetLanguage, result, 'none');
    return result;
  }

  // Use AI to translate
  if (config.ai.useMock) {
    const result = mockTranslate(ticket, sourceLang, targetLanguage);
    cacheTranslation(ticketId, targetLanguage, result, 'mock');
    return { ...result, cached: false, model: 'mock' };
  }

  try {
    const translatedSubject = await translateText(ticket.email_subject || '', sourceLang, targetLanguage);
    const translatedBody = await translateText(ticket.email_body || '', sourceLang, targetLanguage);
    const result = {
      ticketId, targetLanguage,
      translatedSubject, translatedBody,
      cached: false, model: config.ai.model,
    };
    cacheTranslation(ticketId, targetLanguage, result, config.ai.model);
    return result;
  } catch (err) {
    log.error('Translation failed', { error: err.message, ticketId, targetLanguage });
    // Fall back to mock
    const result = mockTranslate(ticket, sourceLang, targetLanguage);
    return { ...result, cached: false, model: 'mock (fallback)', error: err.message };
  }
}

async function translateText(text, sourceLang, targetLang) {
  if (!text || !text.trim()) return text || '';
  const prompt = TRANSLATION_PROMPT
    .replace(/\{sourceLang\}/g, SUPPORTED_LANGUAGES[sourceLang] || sourceLang)
    .replace(/\{targetLang\}/g, SUPPORTED_LANGUAGES[targetLang] || targetLang)
    .replace('{text}', String(text).slice(0, 8000));

  const fetch = globalThis.fetch;
  const url = `${config.ai.baseUrl}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.ai.apiKey}`,
    },
    body: JSON.stringify({
      model: config.ai.secondaryModel || config.ai.model,
      temperature: 0.3,
      max_tokens: config.ai.maxTokens,
      messages: [
        { role: 'system', content: 'You are a professional translator.' },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Translation API HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const json = await res.json();
  return (json?.choices?.[0]?.message?.content || '').trim();
}

function mockTranslate(ticket, sourceLang, targetLang) {
  // Very simple mock: prefix with a note, return original
  return {
    ticketId: ticket.id,
    targetLanguage: targetLang,
    translatedSubject: `[${targetLang}] ${ticket.email_subject || ''}`,
    translatedBody: `[Translated from ${sourceLang} to ${targetLang} — mock mode]\n\n${ticket.email_body || ''}`,
  };
}

function cacheTranslation(ticketId, targetLanguage, result, model) {
  db.run(
    `INSERT OR REPLACE INTO ticket_translations (ticket_id, target_language, translated_subject, translated_body, model, created_at)
     VALUES (@ticketId, @targetLang, @subj, @body, @model, @now)`,
    {
      ticketId, targetLang: targetLanguage,
      subj: result.translatedSubject || null,
      body: result.translatedBody || null,
      model, now: nowIso(),
    }
  );
}

/**
 * List all cached translations for a ticket.
 */
function listForTicket(ticketId) {
  return db.all(
    `SELECT * FROM ticket_translations WHERE ticket_id = @ticketId ORDER BY target_language`,
    { ticketId }
  );
}

/**
 * Delete a cached translation (force re-translation).
 */
function invalidate(ticketId, targetLanguage) {
  if (targetLanguage) {
    db.run(`DELETE FROM ticket_translations WHERE ticket_id = @ticketId AND target_language = @targetLang`,
      { ticketId, targetLang: targetLanguage });
  } else {
    db.run(`DELETE FROM ticket_translations WHERE ticket_id = @ticketId`, { ticketId });
  }
}

module.exports = {
  SUPPORTED_LANGUAGES,
  translateTicket, translateText,
  listForTicket, invalidate,
};
