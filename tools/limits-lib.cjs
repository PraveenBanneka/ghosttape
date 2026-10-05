// Shared by check-limits.cjs and lock-limits.cjs. Parses limits.jsonc and checks safety bounds.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function rawLimits(root) {
  return fs.readFileSync(path.join(root, 'limits.jsonc'), 'utf8').replace(/\r\n/g, '\n');
}

function hashLimits(root) {
  return crypto.createHash('sha256').update(rawLimits(root)).digest('hex');
}

// Strips // comments that start a line or follow a value. The file holds no strings containing "//".
function parseJsonc(text) {
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, '').replace(/,?\s*\/\/[^\n"]*$/gm, m => (m.trim().startsWith(',') ? ',' : '')));
}

// Hard ceilings: even the owner file cannot set a cap above ~50% of a Free-plan daily allowance.
const CEILINGS = {
  max_stream_minutes_per_day: 720,
  max_ingest_messages_per_day: 260000,
  max_do_gb_seconds_per_day: 6500,
  max_concurrent_viewers: 200,
  firecrawl_calls_per_task: 50,
};

function readLimits(root) {
  const l = parseJsonc(rawLimits(root));
  const problems = [];
  if (typeof l.online_enabled !== 'boolean') problems.push('online_enabled must be true or false');
  for (const [k, max] of Object.entries(CEILINGS)) {
    if (!Number.isFinite(l[k]) || l[k] < 0 || l[k] > max) problems.push(`${k} must be a number from 0 to ${max}`);
  }
  const t = l.trading || {};
  if (!(t.spread >= 0)) problems.push('trading.spread must be >= 0');
  if (!(t.leverage >= 1 && t.leverage <= 500)) problems.push('trading.leverage must be 1..500');
  if (!(t.stop_out_level_pct > 0 && t.stop_out_level_pct < t.margin_call_level_pct)) problems.push('stop_out_level_pct must be > 0 and below margin_call_level_pct');
  if (problems.length) throw new Error('limits.jsonc is invalid:\n  - ' + problems.join('\n  - '));
  return l;
}

module.exports = { hashLimits, readLimits, parseJsonc };
