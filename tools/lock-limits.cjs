#!/usr/bin/env node
// OWNER-ONLY. Praveen runs this by hand after editing limits.jsonc. Claude is blocked from running it.
// Writes limits.lock = SHA-256 of limits.jsonc, so `npm test` can detect any change made without him.
const fs = require('fs');
const path = require('path');
const { hashLimits, readLimits } = require('./limits-lib.cjs');

const root = path.join(__dirname, '..');
readLimits(root); // refuses to lock a file that does not parse or breaks the safety bounds
const hex = hashLimits(root);
fs.writeFileSync(path.join(root, 'limits.lock'), `${hex}  limits.jsonc\n`);
console.log(`limits.lock updated: ${hex}`);
