#!/usr/bin/env node
// End-to-end test of the relay on a LOCAL `wrangler dev` (never remote). Run from the repo root:
//   npm run worker:e2e
// Needs the git-ignored .dev.vars with DEVICE_SECRET and ALLOW_TEST_OVERRIDE=1. Limits for each phase are passed
// with `--var LIMITS_OVERRIDE:<json>`; limits.jsonc is never edited. The override only works when
// ALLOW_TEST_OVERRIDE=1 (local .dev.vars) AND the request host is localhost (the Worker fails closed otherwise).
//
// Phases (each on a fresh wrangler dev with its own temporary local storage):
//   A  online: 1 uplink @160 ms + 2 viewers -> identical packets and prices (shared engine); rejections
//      (unsigned, bad MAC, replay); HELLO + seq reset accepted; stall -> "frozen" < 0.5 s; close -> "down" < 0.5 s
//   B  online disabled: ingest refused with GT1,CMD,pause,offline + close 4003; viewers told "online mode is off"
//   C  tiny caps: message cap -> uplink gets GT1,CMD,pause,limit + close 4029; viewers "daily limit reached";
//      re-connect refused; viewer cap enforced

import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const INTERVAL = 160;

// ---------------------------------------------------------------- shared engine (bundled from web/src/model)
const bundled = await build({
  stdin: {
    contents: "export { TapeEngine } from './web/src/model/engine.ts'; export { MultiSeries } from './web/src/model/aggregator.ts';",
    resolveDir: ROOT, loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent',
});
const { TapeEngine, MultiSeries } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));

// ---------------------------------------------------------------- secret (never printed)
const devVarsPath = join(ROOT, '.dev.vars');
if (!existsSync(devVarsPath)) { console.error('missing .dev.vars (DEVICE_SECRET, ALLOW_TEST_OVERRIDE=1)'); process.exit(2); }
const devVars = Object.fromEntries(readFileSync(devVarsPath, 'utf8').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const SECRET = devVars.DEVICE_SECRET;
if (!SECRET || devVars.ALLOW_TEST_OVERRIDE !== '1') { console.error('.dev.vars needs DEVICE_SECRET and ALLOW_TEST_OVERRIDE=1'); process.exit(2); }
const redact = s => s.split(SECRET).join('***');

// Independent signer, written from the spec (not imported from the Worker).
const hex8 = n => (n >>> 0).toString(16).padStart(8, '0');
const sign = (p, secret = SECRET) => {
  const msg = `${p.seq},${hex8(p.a)},${hex8(p.b)},${hex8(p.c)}`;
  return `GT1S,${msg},${createHmac('sha256', secret).update(msg).digest('hex').slice(0, 8)}`;
};
const word = () => randomBytes(4).readUInt32BE(0);
const packet = seq => ({ seq, a: word(), b: word(), c: word() });

// ---------------------------------------------------------------- tiny test harness
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, what) {
  const end = performance.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (performance.now() > end) throw new Error(`timeout waiting for ${what}`);
    await sleep(5);
  }
}

// ---------------------------------------------------------------- wrangler dev (local only)
const tempDirs = [];
async function startWrangler(port, override) {
  const dir = mkdtempSync(join(tmpdir(), 'ghosttape-e2e-'));
  const args = [WRANGLER, 'dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', dir,
    '--show-interactive-dev-session=false', '--var', `LIMITS_OVERRIDE:${JSON.stringify(override)}`];
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const stop = () => {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
    tempDirs.push(dir); // removed at the end: workerd releases its SQLite files only after it has exited
  };
  try {
    await until(() => /Ready on/.test(log) || child.exitCode !== null, 60_000, 'wrangler dev to start');
    if (child.exitCode !== null) throw new Error('wrangler dev exited');
  } catch (e) {
    console.error(redact(log.split('\n').slice(-30).join('\n')));
    stop();
    throw e;
  }
  return { base: `127.0.0.1:${port}`, stop, log: () => redact(log) };
}

const getJson = async (base, path) => (await fetch(`http://${base}${path}`)).json();

function socket(url) {
  const ws = new WebSocket(url);
  const s = { ws, msgs: [], closed: null };
  ws.addEventListener('message', ev => s.msgs.push({ at: performance.now(), data: String(ev.data) }));
  ws.addEventListener('close', ev => { s.closed = { code: ev.code, reason: ev.reason, at: performance.now() }; });
  s.open = new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error(`socket error ${url}`)), { once: true });
  });
  return s;
}

/** A viewer that rebuilds the tape locally from the snapshot + packets with the shared engine. */
function viewer(base) {
  const s = socket(`ws://${base}/api/tape`);
  const v = { s, engine: null, series: null, packets: [], statuses: [], events: [], limits: [], mismatches: 0, snapshot: null };
  s.ws.addEventListener('message', ev => {
    const m = JSON.parse(String(ev.data));
    const at = performance.now();
    if (m.type === 'snapshot') {
      v.snapshot = m;
      v.engine = TapeEngine.from(m.engine);
      v.series = new MultiSeries(300);
      for (const [tf, bars] of Object.entries(m.candles)) v.series.series[tf].bars.push(...bars);
    } else if (m.type === 'packet') {
      const tick = v.engine.step(m.packet, m.time);
      v.series.add(tick);
      if (tick.price !== m.tick.price || tick.index !== m.tick.index) v.mismatches++;
      v.packets.push({ at, seq: m.packet.seq, price: tick.price, packet: m.packet, time: m.time });
    } else if (m.type === 'status') v.statuses.push({ at, ...m.status });
    else if (m.type === 'event') v.events.push({ at, ...m });
    else if (m.type === 'limit') v.limits.push({ at, ...m });
  });
  return v;
}

function hostHeaderProbe(port, host) {
  return new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/state', headers: { Host: host } }, r => {
      let body = '';
      r.on('data', d => { body += d; });
      r.on('end', () => res({ status: r.statusCode, body }));
    });
    req.on('error', rej);
    req.end();
  });
}

// ================================================================ phase A
async function phaseA() {
  console.log('\n--- phase A: online, 1 uplink @160 ms, 2 viewers ---');
  const w = await startWrangler(8791, { online_enabled: true });
  try {
    const st = await getJson(w.base, '/api/state');
    check('GET /api/state answers with online_enabled=true and the synthetic label', st.online_enabled === true && /Synthetic tape/.test(st.label));

    const v1 = viewer(w.base), v2 = viewer(w.base);
    await Promise.all([v1.s.open, v2.s.open]);
    await until(() => v1.snapshot && v2.snapshot, 3000, 'snapshots');
    check('both viewers got a snapshot (engine state + 5 timeframes)', ['1s', '10s', '30s', '1m', '5m'].every(tf => Array.isArray(v1.snapshot.candles[tf])));

    const up = socket(`ws://${w.base}/api/ingest`);
    await up.open;
    up.ws.send('GT1,HELLO');
    const N = 25;
    const sent = [];
    for (let i = 0; i < N; i++) {
      const p = packet(i);
      sent.push(p);
      up.ws.send(sign(p));
      await sleep(INTERVAL);
    }
    await until(() => v1.packets.length >= N && v2.packets.length >= N, 2000, 'viewers to receive all packets');
    const seqs1 = v1.packets.map(p => p.seq).join(','), seqs2 = v2.packets.map(p => p.seq).join(',');
    check(`both viewers received the same ${N} packets in order`, seqs1 === seqs2 && seqs1 === sent.map(p => p.seq).join(','));
    check('packet words arrive unchanged (each number relayed once, as sent)', v1.packets.every((p, i) => p.packet.a === sent[i].a && p.packet.b === sent[i].b && p.packet.c === sent[i].c));
    check('viewers compute identical prices with the shared engine', v1.packets.every((p, i) => p.price === v2.packets[i].price), `last price ${v1.packets.at(-1).price.toFixed(6)}`);
    check("each viewer's engine matches the relay's authoritative tick", v1.mismatches === 0 && v2.mismatches === 0);
    const ref = TapeEngine.from(v1.snapshot.engine);
    check('an independent engine fed the sent packets gives the same prices', sent.every((p, i) => ref.step(p, 0).price === v1.packets[i].price));
    check('viewers built identical candles on all timeframes', JSON.stringify(v1.series.series) === JSON.stringify(v2.series.series));

    // Stall: the uplink stays connected but goes silent.
    const lastAt = Math.max(v1.packets.at(-1).at, v2.packets.at(-1).at);
    const stall1 = await until(() => v1.statuses.find(s => s.uplink === 'stalled' && s.at > lastAt - 1), 1500, 'stalled status v1');
    const stall2 = await until(() => v2.statuses.find(s => s.uplink === 'stalled' && s.at > lastAt - 1), 1500, 'stalled status v2');
    const d1 = stall1.at - v1.packets.at(-1).at, d2 = stall2.at - v2.packets.at(-1).at;
    check('uplink silent -> both viewers see "frozen" within 0.5 s', d1 < 500 && d2 < 500 && stall1.frozen && stall2.frozen, `${d1.toFixed(0)} ms / ${d2.toFixed(0)} ms after the last packet`);

    // Rejections: unsigned, bad MAC, replayed seq, wrong key.
    const before = v1.packets.length;
    const nextP = packet(N);
    up.ws.send(`GT1,${N},${hex8(nextP.a)},${hex8(nextP.b)},${hex8(nextP.c)}`);
    await until(() => up.msgs.some(m => m.data === `GT1,REJECT,unsigned,${N}`), 1000, 'unsigned reject');
    check('unsigned GT1 packet rejected (GT1,REJECT,unsigned)', true);
    const good = sign(nextP);
    const badMac = good.slice(0, -1) + (good.at(-1) === '0' ? '1' : '0');
    up.ws.send(badMac);
    await until(() => up.msgs.some(m => m.data === `GT1,REJECT,bad_mac,${N}`), 1000, 'bad MAC reject');
    check('bad-MAC GT1S packet rejected (GT1,REJECT,bad_mac)', true);
    up.ws.send(sign(packet(N), 'some-other-key'));
    await until(() => up.msgs.filter(m => m.data === `GT1,REJECT,bad_mac,${N}`).length >= 2, 1000, 'wrong key reject');
    check('packet signed with the wrong key rejected', true);
    up.ws.send(sign(sent[10]));
    await until(() => up.msgs.some(m => m.data === 'GT1,REJECT,seq_replay,10'), 1000, 'replay reject');
    check('replayed validly-signed packet (old seq) rejected (GT1,REJECT,seq_replay)', true);
    await sleep(300);
    check('no rejected packet reached the viewers', v1.packets.length === before && v2.packets.length === before);

    // Restart: HELLO then seq 0 is accepted and logged as a restart.
    up.ws.send('GT1,HELLO');
    const r0 = packet(0);
    up.ws.send(sign(r0));
    await until(() => v1.packets.length === before + 1 && v2.packets.length === before + 1, 1000, 'restart packet');
    check('after GT1,HELLO a seq reset is accepted and viewers get a restart event', v1.events.some(e => e.event === 'restart') && v2.events.some(e => e.event === 'restart') && v1.packets.at(-1).seq === 0);
    check('prices still identical after the restart', v1.packets.at(-1).price === v2.packets.at(-1).price && v1.mismatches === 0 && v2.mismatches === 0);
    await until(() => v1.statuses.some(s => s.uplink === 'up' && s.at > stall1.at), 1000, 'up status after resume');
    check('tape resumes from the frozen price (status back to "up")', true);

    // Radio INFO forwarded from the authenticated uplink.
    up.ws.send('GT1,INFO,radio=on,ps=none,aps=3,up=12');
    await sleep(200);

    // Uplink disconnect.
    const closeAt = performance.now();
    up.ws.close();
    const down1 = await until(() => v1.statuses.find(s => s.uplink === 'down' && s.at > closeAt), 1500, 'down status v1');
    const down2 = await until(() => v2.statuses.find(s => s.uplink === 'down' && s.at > closeAt), 1500, 'down status v2');
    check('uplink closed -> both viewers see "uplink down / frozen" within 0.5 s', down1.at - closeAt < 500 && down2.at - closeAt < 500 && down1.frozen, `${(down1.at - closeAt).toFixed(0)} ms / ${(down2.at - closeAt).toFixed(0)} ms`);

    const st2 = await getJson(w.base, '/api/state?candles=0');
    check('/api/state counts: 26 accepted, 4 rejected, 1 restart, 33 messages, radio INFO kept',
      st2.stats.accepted === N + 1 && st2.stats.rejected === 4 && st2.stats.restarts === 1 && st2.usage.messages.used === 33 && st2.status.radio?.fields?.radio === 'on',
      `accepted=${st2.stats.accepted} rejected=${st2.stats.rejected} restarts=${st2.stats.restarts} messages=${st2.usage.messages.used}`);
    check('/api/state reports the engine at the same price the viewers hold', st2.engine.price === v1.packets.at(-1).price);

    // A viewer that talks is closed (viewers are read-only).
    const v3 = socket(`ws://${w.base}/api/tape`);
    await v3.open;
    v3.ws.send('hello?');
    await until(() => v3.closed, 1500, 'read-only close');
    check('a viewer that sends a message is closed (1008, read-only)', v3.closed.code === 1008, `${v3.closed.code} ${v3.closed.reason}`);

    // The local-test override must not work for a non-local host.
    const probe = await hostHeaderProbe(8791, 'ghosttape.example.workers.dev');
    check('with ALLOW_TEST_OVERRIDE set, a non-local Host gets 503 from the guard (fail closed)', probe.status === 503 && probe.body.includes('ALLOW_TEST_OVERRIDE'), `HTTP ${probe.status}`);

    v1.s.ws.close(); v2.s.ws.close();
    await sleep(200);
  } finally {
    w.stop();
  }
}

// ================================================================ phase B
async function phaseB() {
  console.log('\n--- phase B: online mode disabled ---');
  const w = await startWrangler(8792, { online_enabled: false });
  try {
    const st = await getJson(w.base, '/api/state');
    check('/api/state says online_enabled=false, "online mode is off"', st.online_enabled === false && st.status.message === 'online mode is off');
    const up = socket(`ws://${w.base}/api/ingest`);
    await up.open;
    up.ws.send(sign(packet(0)));
    await until(() => up.closed, 2000, 'ingest close');
    check('ingest refused: GT1,CMD,pause,offline then close 4003 "online mode is off"',
      up.msgs.some(m => m.data === 'GT1,CMD,pause,offline') && up.closed.code === 4003 && up.closed.reason === 'online mode is off', `${up.closed.code} ${up.closed.reason}`);
    const v = socket(`ws://${w.base}/api/tape`);
    await v.open;
    await until(() => v.closed, 2000, 'viewer close');
    const m = v.msgs.map(x => JSON.parse(x.data)).find(x => x.type === 'status');
    check('viewer gets status "online mode is off"', m?.status?.message === 'online mode is off' && m.status.online_enabled === false);
  } finally {
    w.stop();
  }
}

// ================================================================ phase C
async function phaseC() {
  console.log('\n--- phase C: daily caps (test caps: 12 messages, 2 viewers) ---');
  const CAP = 12;
  const w = await startWrangler(8793, { online_enabled: true, max_ingest_messages_per_day: CAP, max_concurrent_viewers: 2 });
  try {
    const v1 = viewer(w.base), v2 = viewer(w.base);
    await Promise.all([v1.s.open, v2.s.open]);
    await until(() => v1.snapshot && v2.snapshot, 3000, 'snapshots');
    const v3 = socket(`ws://${w.base}/api/tape`);
    await v3.open;
    await until(() => v3.closed, 2000, 'third viewer refused');
    check('viewer cap: the 3rd viewer is refused (4029 "viewer limit reached")', v3.closed.code === 4029 && v3.closed.reason === 'viewer limit reached');

    const up = socket(`ws://${w.base}/api/ingest`);
    await up.open;
    for (let i = 0; i < CAP + 5 && !up.closed; i++) {
      try { up.ws.send(sign(packet(i))); } catch { break; }
      await sleep(INTERVAL);
    }
    await until(() => up.closed, 2000, 'uplink closed at cap');
    check('at the message cap the uplink gets GT1,CMD,pause,limit and close 4029',
      up.msgs.some(m => m.data === 'GT1,CMD,pause,limit') && up.closed.code === 4029, `${up.closed.code} ${up.closed.reason}`);
    await until(() => v1.limits.length && v2.limits.length, 1000, 'limit broadcast');
    check('viewers are told "daily limit reached"', /daily limit reached/.test(v1.limits[0].message) && v2.statuses.some(s => s.message === 'daily limit reached'));
    check(`exactly ${CAP} packets reached the tape (no packet after the cap)`, v1.packets.length === CAP && v2.packets.length === CAP, `${v1.packets.length}`);
    const up2 = socket(`ws://${w.base}/api/ingest`);
    await up2.open;
    await until(() => up2.closed, 2000, 'reconnect refused');
    check('a new uplink is refused for the rest of the UTC day', up2.msgs.some(m => m.data === 'GT1,CMD,pause,limit') && up2.closed.code === 4029);
    const st = await getJson(w.base, '/api/state?candles=0');
    check('/api/state shows limit_reached="messages"', st.usage.limit_reached === 'messages', JSON.stringify(st.usage.messages));
    v1.s.ws.close(); v2.s.ws.close();
    await sleep(200);
  } finally {
    w.stop();
  }
}

try {
  await phaseA();
  await phaseB();
  await phaseC();
} catch (e) {
  failures++;
  console.log(`FAIL  ${e.message}`);
}
await sleep(1500);
for (const dir of tempDirs) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { console.log(`note: could not remove ${dir}`); }
}
console.log(failures ? `\nE2E: ${failures} failure(s)` : '\nE2E: all checks passed');
process.exit(failures ? 1 : 0);
