#!/usr/bin/env node
// OWNER SHORTCUT (Praveen runs it; Claude never edits limits.jsonc itself).
//   npm run online:on   -> "online_enabled": true  in limits.jsonc, rebuild, redeploy
//   npm run online:off  -> "online_enabled": false in limits.jsonc, rebuild, redeploy
// Only that one value changes; every other limit and comment stays as it is.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const want = process.argv[2];
if (want !== 'on' && want !== 'off') { console.error('usage: node tools/online-switch.cjs on|off'); process.exit(1); }

const root = path.join(__dirname, '..');
const file = path.join(root, 'limits.jsonc');
const before = fs.readFileSync(file, 'utf8');
const after = before.replace(/("online_enabled"\s*:\s*)(true|false)/, `$1${want === 'on'}`);
if (!/"online_enabled"\s*:\s*(true|false)/.test(before)) { console.error('online_enabled not found in limits.jsonc'); process.exit(1); }
fs.writeFileSync(file, after);
console.log(`limits.jsonc: online_enabled = ${want === 'on'}`);

const run = (cmd, cwd = root) => { console.log(`> ${cmd}`); execSync(cmd, { cwd, stdio: 'inherit' }); };
run('node tools/check-limits.cjs');
run('npx vite build', path.join(root, 'web'));
run('npx wrangler deploy');
console.log(want === 'on'
  ? '\nOnline mode is ON. Now run:  npm run bridge   (keep it running while you want people to see the ESP32)'
  : '\nOnline mode is OFF. The relay refuses all uploads; the site still works with browser randomness.');
