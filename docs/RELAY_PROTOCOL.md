# GhostTape relay protocol (Phase E, online mode)

Status: built and tested locally (`wrangler dev`) on 2026-10-05. **Not deployed.** Online mode is OFF by default
and is switched only by Praveen in `limits.jsonc`.

```
ESP32 (esp_random, Wi-Fi on)                     viewers (browsers)
   |  GT1S lines (signed)                            ^  JSON: snapshot, then one message per packet
   v                                                 |
 uplink ── wss /api/ingest ──> Worker ──> Durable Object "main" (TapeRelay) ── wss /api/tape ──┘
 (ESP32 Wi-Fi, or the browser       |      verify HMAC, check seq, step the shared engine,
  USB-bridge page)                  |      broadcast immediately; nothing is queued
                                    └── everything else: static assets from web/dist (free, no Worker call)
```

Code: `worker/src/index.ts` (Worker, routing, offline answers, rate limits), `worker/src/relay.ts` (Durable Object),
`worker/src/limits.ts` (pure cap logic), `worker/src/ingest.ts` (pure line + seq rules), `worker/src/hmac.ts`.
The price maths is imported from `web/src/model/` (one copy, shared with the web app).

## 1. Live-path rules (from docs/SPEC.md)

| Rule | How the relay keeps it |
|---|---|
| No entropy stock | Each accepted packet is verified, applied to the engine and broadcast inside the same event. No queue, no buffer, no pre-fetch. HMAC uses synchronous `node:crypto`, so no other message can interleave. |
| Each number used once | `seq` must strictly increase; old/duplicate seqs are rejected (`GT1,REJECT,seq_replay`). |
| Tape freezes when packets stop | 400 ms after the last packet viewers get `status.uplink = "stalled"` (`frozen: true`); on uplink close they get `"down"` at once. Measured locally: 413 ms and 7 ms. |
| Always labelled | Snapshot and `/api/state` carry `label: "Synthetic tape, not real market data. No advice."` |
| Storage holds no unused entropy | SQLite keeps only engine state, candles, counters, last seq. Raw packets are never stored. The MAC is never forwarded to viewers. |

## 2. Endpoints

| Route | Kind | Purpose |
|---|---|---|
| `GET /api/state` | JSON | online switch, uplink status, last packet time, engine state, today's usage vs caps, stats, recent candles (`?candles=0` omits them) |
| `GET /api/tape` | WebSocket | viewers (read-only) |
| `GET /api/ingest` | WebSocket | the single uplink |
| anything else | static | `web/dist` (assets are free and unlimited; only `/api/*` runs the Worker: `run_worker_first: ["/api/*"]`) |

When `online_enabled` is false the Worker answers all three routes itself and never wakes the Durable Object.

## 3. Uplink protocol (`/api/ingest`)

Text WebSocket messages, one line per message (CRLF tolerated; at most 8 lines per message, but bridges must
forward each serial line as soon as it arrives, never batch). Binary messages are rejected.

### 3.1 Uplink -> relay

| Line | Effect |
|---|---|
| `GT1S,<seq>,<a>,<b>,<c>,<hmac8>` | the only line that moves the tape (if MAC and seq are valid) |
| `GT1,HELLO` | device booted: arms one seq reset for this socket's next valid packet |
| `GT1,INFO,k=v,...` | radio status, forwarded to viewers (only from the authenticated uplink) |
| `GT1,ERR,<reason>,<detail>` | radio error, forwarded to viewers (only from the authenticated uplink) |
| `GT1,<seq>,<a>,<b>,<c>` | **rejected** (unsigned) |

### 3.2 Relay -> uplink

| Line | Meaning | What the device/bridge must do |
|---|---|---|
| `GT1,CMD,pause,limit` | a daily cap was hit; the socket is closed (4029) | stop sending, do not reconnect before 00:00 UTC |
| `GT1,CMD,pause,offline` | online mode is off; closed (4003) | stop; retry rarely (every reconnect is a billed request) |
| `GT1,CMD,pause,not_configured` | no `DEVICE_SECRET` on the server; closed (4001) | stop |
| `GT1,REJECT,<reason>,<seq or ->` | one line rejected: `unsigned`, `bad_mac`, `seq_replay`, `malformed`, `too_many_lines`, `binary`, `busy`, `rate_limited` | informational |

### 3.3 HMAC

```
hmac8 = first 8 hex chars (lowercase) of HMAC-SHA256(key = UTF-8 bytes of DEVICE_SECRET,
                                                     msg = "<seq>,<a>,<b>,<c>")
seq: decimal, no leading zeros (printf "%u"); a, b, c: 8-digit lowercase hex (printf "%08x")
```

Example with the dummy key `example-key-NOT-the-real-one`: message `42,0000beef,deadbeef,00000007`, full HMAC
`b6689b47ff06...`, so the line is `GT1S,42,0000beef,deadbeef,00000007,b6689b47`. The relay recomputes the MAC
over the canonical form and compares with `crypto.timingSafeEqual` (upper-case MACs are accepted).

### 3.4 Sequence and restart rules

- First packet a fresh relay ever sees: accepted at any seq.
- `seq > last`: accepted (a jump = packets lost upstream, viewers get an `event: "gap"`).
- `seq <= last`: rejected as a replay, **unless** this socket sent `GT1,HELLO` since its last accepted packet; then
  it is accepted and logged as a restart (`event: "restart"`). The HELLO flag clears on the next accepted packet.
- `last` survives uplink reconnects and Durable Object hibernation (persisted on stall/close).
- Uplink sockets: at most 2 (active + one candidate). A new socket becomes the uplink only with its first valid
  signed packet; then the older one is closed (4000 "replaced by a newer uplink"). INFO/ERR from a candidate are ignored.

### 3.5 Replay limitation (known, by design of the v1 packet format)

`GT1,HELLO` is unsigned and the device has no boot nonce, so the MAC does not bind a packet to one boot:

1. **Replay after a fake HELLO.** Anyone who has recorded signed lines can send `GT1,HELLO` and then replay old
   packets with a lower seq; the relay accepts them as a "restart". This reuses old numbers (breaks "each number
   used once" for that replay) though it cannot invent new prices. Mitigations already in place: the relay never
   forwards the MAC to viewers (the public feed cannot be replayed), and the uplink runs over TLS (wss), so the
   attacker would need the device's own traffic or the bridge machine. Note that such a replaying socket would
   also be promoted to uplink and close the real one (the real device then reconnects and takes over again with
   its next, higher seq).
2. **Short MAC.** 8 hex = 32 bits. Forging one packet needs ~2^31 online guesses on average; the daily message
   cap (21,600) makes that impossible in practice, but it is weaker than a full MAC.
3. **Rollback after an eviction.** If the Durable Object is evicted while streaming (deploy, runtime restart), the
   last up-to-30 s of state is lost, and those seqs could be replayed once.

Fix (needs Praveen's OK, it changes the packet format): sign HELLO with a per-boot random nonce
(`GT1S,HELLO,<nonce>,<mac>`) and include the nonce in every packet MAC; optionally a 16-hex MAC.

## 4. Viewer protocol (`/api/tape`)

Viewers are read-only: any message from a viewer closes it (1008). All messages are JSON.

```ts
// first message after connect
{ type: 'snapshot', label: string, server_time: number,
  engine: { price, regime: 'expansion'|'recession', rate, stepInRoll, packets },   // TapeEngine.state()
  last_seq: number | null,
  candles: { '1s': Candle[], '10s': Candle[], '30s': Candle[], '1m': Candle[], '5m': Candle[] },  // <= 300 each
  status: Status }

// one per accepted packet, in order
{ type: 'packet', packet: { seq, a, b, c }, time: number /* relay ms, use as the tick time */,
  tick: { price, prevPrice, regime, shift: null | { from, to, rate }, index } }

{ type: 'status', status: Status }            // uplink up/stalled/down, online off, limit reached
{ type: 'radio', radio: { level: 'info', fields: {...}, at } | { level: 'err', reason, detail, at } }
{ type: 'event', event: 'restart' | 'gap', seq, missing?, message }
{ type: 'limit', cap: 'messages' | 'stream_minutes' | 'do_gb_seconds', message: 'daily limit reached (...)' }

type Status = { online_enabled: boolean, uplink: 'up' | 'stalled' | 'down', frozen: boolean,
  message: 'live' | 'uplink silent: tape frozen' | 'uplink down: tape frozen' | 'daily limit reached'
           | 'online mode is off' | 'viewer limit reached',
  last_packet_at: number | null, last_seq: number | null, limit_reached: string | null,
  viewers: number, radio: Radio | null }
```

Applying it (keeps every viewer identical to the relay):

```ts
const engine = TapeEngine.from(snapshot.engine);
const series = new MultiSeries(300);
for (const tf of TIMEFRAMES) series.series[tf.id].bars.push(...snapshot.candles[tf.id]);
// on each packet message m:
const tick = engine.step(m.packet, m.time);   // tick.price === m.tick.price (verified by the e2e test)
series.add(tick);
```

The snapshot is sent from the single-threaded Durable Object before any later packet, so nothing is missed.
A viewer should also run its own watchdog (no packet for 400 ms -> show frozen) in case its own connection dies.

## 5. Limits (owner-only `limits.jsonc`, enforced on the server)

`limits.jsonc` is bundled as text at build time (wrangler `rules` Text entry; comments stripped exactly like
`web/src/config.ts`). Changing it requires a redeploy (which also restarts the Durable Object).
Anything missing or malformed means **online off** (pinned by unit tests).

| Key | Enforcement |
|---|---|
| `online_enabled` | false: `/api/ingest` gets `GT1,CMD,pause,offline` + close 4003 "online mode is off"; viewers get status "online mode is off" + close 4003; `/api/state` answers from the Worker. Zero Durable Object usage. |
| `max_ingest_messages_per_day` | every incoming WebSocket message counts (uplink lines incl. rejected ones, and stray viewer messages): each is billed. At the cap: stop. |
| `max_stream_minutes_per_day` | accumulated time with an authenticated uplink connected |
| `max_do_gb_seconds_per_day` | estimate: 0.125 GB x active seconds (gaps between events counted up to 10 s; longer gaps can hibernate and are not billed) |
| `max_concurrent_viewers` | extra viewers get status "viewer limit reached" + close 4029 |

At any daily cap: the uplink gets `GT1,CMD,pause,limit` and is closed (4029 "daily limit reached"), viewers get
`{type:'limit'}` plus a status "daily limit reached", and new uplinks are refused until 00:00 UTC (counters live in
DO SQLite, keyed by UTC day). Counters are written with the snapshot (at most every 30 s, plus on stall, close and
limit), so after an eviction up to 30 s of counts can be lost (a small undercount).

Per-IP rate limits (Workers rate-limit binding, GhostTape namespaces 2001/2002): `/api/state` + `/api/tape` 30 per
60 s per path, `/api/ingest` 6 per 60 s.

Close codes: 1008 viewer sent data · 4000 replaced by newer uplink · 4001 no DEVICE_SECRET · 4003 online off ·
4008 rate limited · 4009 uplink busy · 4029 daily limit / viewer limit.

## 6. Connecting an uplink

### 6.1 Browser USB bridge (Phase E first)
A page in the web app (Chrome/Edge, Web Serial) reads lines from the ESP32 and forwards them **verbatim**:
1. Firmware must emit `GT1S` lines (the key lives only on the ESP32 in git-ignored `secrets.h`; the bridge never
   sees it, so a compromised bridge cannot forge packets).
2. Open `wss://<host>/api/ingest`; send each complete serial line as one WebSocket message the moment it arrives
   (no buffering: the no-stock rule applies to the bridge too). Forward `GT1,HELLO`, `GT1,INFO`, `GT1,ERR`.
3. On `GT1,CMD,pause,*` or close 4003/4029: stop forwarding, show the reason, do not auto-reconnect in a loop.
   Optionally write the CMD line to the serial port for the firmware.
4. Show `GT1,REJECT,...` lines in the raw feed panel.

### 6.2 ESP32 over Wi-Fi (later)
`links2004/arduinoWebSockets` with SSL to `wss://ghosttape.teamkestrel.workers.dev/api/ingest` (production URL
once deployed). Send `GT1,HELLO` after boot, then one `GT1S` line per WebSocket text frame. On `GT1,CMD,pause,limit`
stay paused until the next UTC day; on `offline` retry at most every 10 minutes (each attempt is a billed Worker
request). Use protocol-level pings for keep-alive (free) rather than text messages (billed).

## 7. Free-plan budget (verified 2026-10-05 on developers.cloudflare.com)

| Limit (Free plan, account-wide, shared with ZedPath) | Value | Source |
|---|---|---|
| Workers requests | 100,000/day, reset 00:00 UTC (over: error 1027) | /workers/platform/limits/ |
| Static asset requests | free and unlimited (only Worker invocations count) | /workers/static-assets/billing-and-limitations/ |
| Durable Objects requests | 100,000/day | /durable-objects/platform/pricing/ |
| Incoming WebSocket messages | billed 20:1 as DO requests; outgoing messages and protocol pings free | /durable-objects/platform/pricing/ |
| DO duration | 13,000 GB-s/day, on the 128 MB allocation regardless of use; hibernation-eligible idle time not billed | /durable-objects/platform/pricing/ |
| DO SQLite | 5 M rows read/day, 100,000 rows written/day, 5 GB total; SQLite backend only on Free | /durable-objects/platform/pricing/, /durable-objects/platform/limits/ |
| WebSocket received message size | 32 MiB | /durable-objects/platform/limits/ |

Default caps (`limits.jsonc`: 60 min, 21,600 messages, 450 GB-s, 20 viewers):

| Resource | Use at the default caps | Share of the free daily allowance |
|---|---|---|
| DO requests from uplink messages | 21,600 / 20 = 1,080 | 1.1% of 100,000 |
| DO duration | 3,600 s x 0.125 GB = 450 GB-s | 3.5% of 13,000 |
| DO rows written | snapshot (~8 rows) every 30 s: ~120/h, so ~1,000-2,000 rows incl. index writes and stall/close saves | ~1-2% of 100,000 |
| Worker + DO requests from connections | 1 each per viewer connect or `/api/state` call; 20 viewers x a few reconnects = ~100 | ~0.1% |
| Outgoing broadcasts (20 viewers x 21,600 packets) | 432,000 messages | free |

Packet rate: at exactly 6.0 packets/s the 21,600-message cap equals 60 minutes; at 160 ms (6.25/s) the message cap
is hit first, after 57.6 minutes. For comparison, 24/7 streaming would be ~540,000 messages = 27,000 DO requests
(27%) and ~10,800 GB-s (83% of 13,000), which is why the caps exist: going over does not cost money, it makes
Cloudflare refuse requests for the rest of the UTC day, for ZedPath too.

## 8. Local testing

- `.dev.vars` (git-ignored) holds a random local `DEVICE_SECRET` and `ALLOW_TEST_OVERRIDE=1`.
- `LIMITS_OVERRIDE` (JSON) replaces `limits.jsonc` values only when `ALLOW_TEST_OVERRIDE === "1"`; the e2e passes it
  with `wrangler dev --var LIMITS_OVERRIDE:<json>`. If `ALLOW_TEST_OVERRIDE` is ever present on a non-local host,
  the Worker refuses every `/api` request with 503 (fail closed; tested by the e2e with a forged Host header).
  `.dev.vars` is never uploaded by a deploy. Never `wrangler secret put` either variable.
- `npm test` = limits ceiling check + relay unit tests. `npm run worker:check` = TypeScript.
  `npm run worker:e2e` = three local `wrangler dev` runs (online, online off, tiny caps).
- `npm run worker:dev` = local dev server (online stays off unless you pass an override).

## 9. Deploying (not done yet)

1. `npm test`, `npm run worker:check`, `npm run worker:e2e` green; `cd web && npm run build` so `web/dist` is the real app.
2. `npx wrangler whoami` shows the Stacklineops account (not `c5cbb437...`).
3. `npx wrangler secret put DEVICE_SECRET` (a new random value; the same value goes into the firmware `secrets.h`).
4. `npx wrangler deploy`, note the version id; rollback is `npx wrangler rollback <previous-version-id>`.
5. With `online_enabled: false` the live site serves the app and refuses ingest. Praveen flips the switch and redeploys.
