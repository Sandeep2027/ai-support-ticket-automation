'use strict';

/**
 * Knowledge Base service (RAG source for agents & AI).
 *
 * Stores markdown articles with category + tags, exposes full-text search
 * (SQLite FTS5), and provides "suggest articles for this ticket" used by
 * the AI service.
 */

const db = require('../database/db');
const { generateId, nowIso } = require('../utils/helpers');
const { asString, asArray } = require('../utils/validator');
const aiService = require('./aiService');
const logger = require('../utils/logger').child('kb');
const log = logger;

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function list({ category, tag, q, limit = 50, offset = 0, includeUnpublished = false } = {}) {
  const where = [];
  const params = { limit, offset };
  if (!includeUnpublished) { where.push('is_published = 1'); }
  if (category) { where.push('category = @category'); params.category = category; }
  let sql = `SELECT * FROM kb_articles ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
             ORDER BY updated_at DESC LIMIT @limit OFFSET @offset`;
  let rows = db.all(sql, params);

  // Tag filter (post-filter, since tags is JSON)
  if (tag) {
    rows = rows.filter((r) => {
      try { return JSON.parse(r.tags || '[]').includes(tag); } catch { return false; }
    });
  }
  // FTS query
  if (q) {
    const ftsIds = ftsSearch(q, 200).map((r) => r.id);
    if (!ftsIds.length) return [];
    // Use named params to avoid mixing positional + named
    const idPlaceholders = ftsIds.map((_, i) => `@id${i}`).join(',');
    const idParams = {};
    ftsIds.forEach((id, i) => { idParams[`id${i}`] = id; });
    const orderClause = ftsIds.map((_, i) => `WHEN id = @id${i} THEN ${i}`).join(' ');
    rows = db.all(
      `SELECT * FROM kb_articles WHERE id IN (${idPlaceholders}) ORDER BY CASE ${orderClause} ELSE 999 END`,
      idParams
    );
  }
  return rows.map(rowToArticle);
}

function ftsSearch(query, limit = 20) {
  // FTS5 match syntax: words separated by spaces are AND-ed by default
  const safe = String(query || '').replace(/["']/g, '').trim().split(/\s+/).filter(Boolean).map((w) => `"${w}"`).join(' ');
  if (!safe) return [];
  try {
    return db.all(
      `SELECT id, bm25(kb_fts) AS rank FROM kb_fts WHERE kb_fts MATCH @q ORDER BY rank LIMIT @limit`,
      { q: safe, limit }
    );
  } catch (err) {
    log.warn('FTS search failed', { error: err.message, q: safe });
    return [];
  }
}

function get(id) {
  const row = db.get(`SELECT * FROM kb_articles WHERE id = @id`, { id });
  return row ? rowToArticle(row) : null;
}

function getBySlug(slug) {
  const row = db.get(`SELECT * FROM kb_articles WHERE slug = @slug`, { slug });
  return row ? rowToArticle(row) : null;
}

function create({ title, content, summary, category, tags, authorId, isPublished = true }) {
  const id = generateId('kb');
  const slug = slugify(title) + '-' + id.slice(-6);
  const now = nowIso();
  const row = {
    id, title: asString(title, 200), slug, content: asString(content, 50000),
    summary: asString(summary, 280), category: asString(category, 80),
    tags: JSON.stringify(asArray(tags, 10)),
    is_published: isPublished ? 1 : 0,
    author_id: authorId || null,
    created_at: now, updated_at: now,
  };
  db.run(
    `INSERT INTO kb_articles (id, title, slug, content, summary, category, tags, is_published, author_id, created_at, updated_at)
     VALUES (@id, @title, @slug, @content, @summary, @category, @tags, @is_published, @author_id, @created_at, @updated_at)`,
    row
  );
  log.info('KB article created', { id, slug, category });
  return get(id);
}

function update(id, patch) {
  const existing = get(id);
  if (!existing) return null;
  const allowed = ['title', 'content', 'summary', 'category', 'tags', 'is_published'];
  const setClauses = [];
  const params = { id, updatedAt: nowIso() };
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    let v = patch[k];
    if (k === 'tags') v = JSON.stringify(asArray(v, 10));
    else if (k === 'is_published') v = v ? 1 : 0;
    else v = asString(v, k === 'content' ? 50000 : 280);
    setClauses.push(`${k} = @${k}`);
    params[k] = v;
  }
  if (setClauses.length === 0) return existing;
  setClauses.push('updated_at = @updatedAt');
  db.run(`UPDATE kb_articles SET ${setClauses.join(', ')} WHERE id = @id`, params);
  return get(id);
}

function remove(id) {
  const r = db.run(`DELETE FROM kb_articles WHERE id = @id`, { id });
  return r.changes > 0;
}

function incrementView(id) {
  db.run(`UPDATE kb_articles SET view_count = view_count + 1 WHERE id = @id`, { id });
}

function markHelpful(id) {
  db.run(`UPDATE kb_articles SET helpful_count = helpful_count + 1 WHERE id = @id`, { id });
}

function stats() {
  const total = db.get(`SELECT COUNT(*) AS n FROM kb_articles WHERE is_published = 1`).n;
  const byCategory = db.all(`SELECT category, COUNT(*) AS n FROM kb_articles WHERE is_published = 1 GROUP BY category`);
  const topViewed = db.all(`SELECT id, title, view_count, helpful_count FROM kb_articles WHERE is_published = 1 ORDER BY view_count DESC LIMIT 5`);
  return {
    total,
    byCategory: Object.fromEntries(byCategory.map((r) => [r.category || 'Uncategorized', r.n])),
    topViewed,
  };
}

/**
 * Suggest KB articles for a ticket using AI service's matcher.
 */
function suggestForTicket(ticket, limit = 3) {
  const allArticles = list({ limit: 200 });
  return aiService.suggestKbArticles(ticket, allArticles, limit);
}

function rowToArticle(row) {
  if (!row) return null;
  let tags = [];
  try { tags = JSON.parse(row.tags || '[]'); } catch { /* ignore */ }
  return {
    ...row,
    tags,
    is_published: !!row.is_published,
  };
}

module.exports = {
  list, get, getBySlug, create, update, remove,
  incrementView, markHelpful, stats, suggestForTicket,
  ftsSearch, slugify,
};
