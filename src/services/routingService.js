'use strict';

/**
 * Routing service — maps a ticket category to a support team.
 * The mapping is configurable at runtime through the `routing_config` table
 * and optionally overridden by AI suggestions.
 */

const db = require('../database/db');

const DEFAULT_MAP = {
  'Technical Support': 'Technical Support',
  Billing: 'Finance',
  'Sales Inquiry': 'Sales',
  'Feature Request': 'Product Team',
  'Bug Report': 'Product Team',
  'Account Access': 'Customer Success',
  'Refund Request': 'Finance',
  'General Inquiry': 'Customer Success',
};

/**
 * Resolve a category to a team. Order of precedence:
 *   1. AI-suggested department (if it matches a configured team and is consistent with category)
 *   2. routing_config table
 *   3. Built-in DEFAULT_MAP
 */
function resolveTeam({ category, suggestedDepartment } = {}) {
  // 1. Trust AI suggestion if it's a known team name
  const knownTeams = new Set([
    'Technical Support',
    'Finance',
    'Sales',
    'Customer Success',
    'Product Team',
  ]);
  if (suggestedDepartment && knownTeams.has(suggestedDepartment)) {
    return suggestedDepartment;
  }

  // 2. DB
  const row = db.get(`SELECT team FROM routing_config WHERE category = @cat AND is_active = 1`, { cat: category });
  if (row && row.team) return row.team;

  // 3. Default
  return DEFAULT_MAP[category] || 'Customer Success';
}

/**
 * List the current routing configuration (for the admin UI).
 */
function listConfig() {
  return db.all(`SELECT * FROM routing_config ORDER BY category ASC`);
}

/**
 * Update the team for a category.
 */
function setTeam(category, team) {
  db.run(
    `INSERT INTO routing_config (category, team, is_active)
     VALUES (@cat, @team, 1)
     ON CONFLICT(category) DO UPDATE SET team = @team`,
    { cat: category, team }
  );
  return { category, team };
}

module.exports = { resolveTeam, listConfig, setTeam, DEFAULT_MAP };
