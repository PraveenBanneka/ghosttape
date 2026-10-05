#!/usr/bin/env node
// Part of `npm test`. Fails if limits.jsonc changed without Praveen re-locking it, or if it breaks
// the safety bounds. Never rewrites anything.
const fs = require('fs');
const path = require('path');
const { hashLimits, readLimits } = require('./limits-lib.cjs');

const root = path.join(__dirname, '..');
const lockPath = path.join(root, 'limits.lock');
const locked = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8').split(/\s+/)[0] : '';
const actual = hashLimits(root);
if (locked !== actual) {
  console.error('LIMITS CHECK FAILED: limits.jsonc does not match limits.lock.\n' +
    'If Praveen changed it on purpose, he runs `node tools/lock-limits.cjs`. Otherwise revert the change.');
  process.exit(1);
}
const l = readLimits(root);
console.log(`limits check: ok (online_enabled=${l.online_enabled}, ${l.max_stream_minutes_per_day} min/day, spread=${l.trading.spread})`);
