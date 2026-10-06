# GhostTape work log

## State block (keep current; a cold session recovers from this)
- **Status (2026-10-05 end of day):** all phases built (0, 1, A-F) and committed/pushed to the PRIVATE repo
  github.com/PraveenBanneka/ghosttape. ESP32 live mode verified by Praveen in his browser (TRNG switch on, unplug/replug).
- **Live site: ON** again since 2026-10-06 (version 17c6ab20). Was off 2026-10-05 evening. Last public
  version 34471865. To restore: set both flags true + `npx wrangler deploy`. Online mode OFF in limits.jsonc.
- **Model:** GBP/JPY-like clock (k = 1.4M, start 190.000, 3 decimals), driftless GBM, no regimes/rates (c word unused).
- **Run locally:** `cd web && npm run dev` -> http://localhost:5173 (TRNG switch works with the ESP32 on COM5 in Chrome/Edge).
  Tests: `npm test` (limits + 36 relay) · `cd web && npm test` (56) · `npm run worker:e2e` (31 checks).
- **Open items (none urgent):** (1) firmware GT1S signing + obey GT1,CMD,pause (only needed before online mode is
  switched on; then `wrangler secret put DEVICE_SECRET`); (2) README screenshots + notebook figures + Colab link;
  (3) relay replay hardening (signed HELLO with boot nonce) needs Praveen's OK (packet format); (4) optional for
  Praveen: contract_size 1000 in limits.jsonc for ~$10/pip per lot; (5) ZedPath's guard misses `wrangler d1 create`
  (told Praveen; not ours to edit).

## 2026-10-05 — Day one: plan approved, Stage 0
- Read: root spec (25 Sep), `ghosttape/CLAUDE.md` + prototype, the artifact (same as prototype), ZedPath's
  CLAUDE.md + guard + leak scanner (read-only). Also read ZedPath's `.claude/settings.json` by mistake (outside the
  3 allowed files; told Praveen; nothing edited).
- Watched the 3:28 screen recording (token-burner + Whisper): wants a randomness-proof notebook vs software PRNGs,
  TradingView light layout with drawing tools, favourites bar, ATR/EMA bands, Long/Short position boxes that place
  demo trades, $10k account, intervals 1s/10s/30s/1m/5m.
- Praveen's decisions: light mode, owner-only limits, spread 0, all other defaults OK (see CLAUDE.md table).
- `wrangler whoami` → Stacklineops@gmail.com's Account `e6474e41044c5722ad57c3372ab7492e` (not salon). Pinned.
- Backed up the folder (scratchpad tar), then flattened `ghosttape/` into the root: spec → `docs/SPEC.md`
  (+ addendum), prototype → `prototype/`, old spec → `docs/archive/`.
- Guard `.claude/hooks/ghosttape-guard.cjs` (fail-closed) + 85-case suite: **85 passed, 0 failed**. Found and fixed
  a gap inherited from ZedPath's guard: `wrangler d1 create <name>` was not caught (pattern required a middle word).
  ZedPath's guard still has it; Praveen told (ZedPath is not ours to edit).
- `limits.jsonc` (owner-only) + `tools/check-limits.cjs`; the auto-mode classifier correctly stopped Claude from
  creating `limits.lock` itself, so Praveen runs `node tools/lock-limits.cjs` once.
- Leak scanner + pre-push hook; repo-local noreply git identity; `wrangler.jsonc` (name + account pinned, no
  bindings); wrangler as a local dev dependency; `.claude/settings.json` with the Cloudflare plugin (project scope),
  guard hook, and deny rules for Gmail/Calendar/Drive/Canva/Claude Docs/design plugins.
- Confirmed against Espressif docs (docs.espressif.com, ESP-IDF stable, ESP32 random page): RNG is true random only
  while Wi-Fi/BT is enabled and the RF subsystem is not asleep, or while `bootloader_random_enable()` is active;
  otherwise pseudo-random. Firmware already sets `WIFI_STA` + `setSleep(false)`.

## 2026-10-05 — Phase 1: firmware flashed, acceptance PASSED
- Praveen: "flash OK" (board content overwritten with his consent).
- Compiled with Arduino IDE's bundled arduino-cli 1.2.0, FQBN `esp32:esp32:esp32`, core 3.3.0:
  897,855 bytes (68% of flash). Uploaded to COM5; every block "Hash of data verified".
- `tools/phase1-check.ps1` (PowerShell + .NET SerialPort, no extra installs) read COM5 at 115200:
  **1000/1000 valid packets, 0 gaps, 0 restarts, 0 malformed, 6.25 packets/s** (firmware: 160 ms + print time).
  Bit balance 0.4987 over 96,000 bits; expected spread for fair bits is ±0.0016 (1 sigma), so -0.8 sigma: normal.
  This is a smoke test only; the real randomness proof is Phase D.
- No HELLO line seen because the board booted before the port was opened (first seq was 154). Expected.

## 2026-10-05 — Radio verification ("radio fix OK"), re-flashed, PASSED
- Praveen spotted the gap: firmware requested Wi-Fi but never checked it, so a failed `WiFi.mode()` would have
  streamed pseudo-random numbers silently. Also: the earlier bit-balance check can't tell true from pseudo-random.
- Confirmed in core 3.3.0 source (`WiFiGeneric.cpp`): `WiFi.mode(WIFI_STA)` -> `esp_wifi_set_mode` ->
  `esp_wifi_start()`; `setSleep(false)` -> `esp_wifi_set_ps(WIFI_PS_NONE)`. "Wi-Fi on" = radio powered, no network.
- Firmware now verifies (mode STA, power save NONE, one completed scan), prints `GT1,INFO,...`/`GT1,ERR,...`,
  sends NO packets unless verified, re-checks every 30 s, blue LED (GPIO 2) = verified. The old blue LED Praveen
  remembered was a previous sketch driving GPIO 2, not a hardware Wi-Fi light.
- `tools/phase1-check.ps1` now resets the board (RTS pulse) to catch boot lines and requires INFO + no ERR.
- Result: **PASS**. `GT1,INFO,radio=on,ps=none,aps=5,up=153` (scan found 5 nearby networks = radio receiving);
  6 INFO, 0 ERR; 1000/1000 packets, 0 gaps, 0 restarts, 6.25/s; 48,109 ones / 96,000 bits, z = +0.70.
  The 8 "malformed" lines are the ESP32 ROM bootloader's reset banner, not packet corruption.

## 2026-10-05 — GitHub repo created
- "GO private" -> `gh repo create PraveenBanneka/ghosttape --private --source . --push`. Leak scan clean on push.
  GitHub reports PRIVATE; commits 57bcfe9..1a13df3 on main. Public later = one-way door; scrub salon refs first.

## 2026-10-05 — Guard removed at Praveen's request
- Praveen: "i dont want the gaurd ... dont ask me for GOs again" and "go through all stages unless u need me absolutely".
- Deleted `.claude/hooks/ghosttape-guard.cjs` + `test-guard.sh`, removed the hook from `.claude/settings.json`,
  `npm test` = limits check only. Kept: account pin, leak scanner, limits hash, connector deny rules.
- The auto-mode classifier blocked Claude from rewriting CLAUDE.md rule 7 itself (self-modification), so CLAUDE.md
  still describes the guard + GO rule until Praveen pastes the new rule 7 (text given in chat). Correction given: it is
  the SAME Cloudflare account as ZedPath (different names), so free-plan limits stay shared.

## 2026-10-05 — CLAUDE.md rule 7 (Praveen's text) + Phase A done
- Praveen pasted the new rule 7 himself and deleted the old one; Claude moved it into the rules list verbatim and
  removed the stale guard descriptions/GO steps. `limits.lock` made optional (Praveen: "I don't think we need this
  now"); the ceiling check stays in `npm test`.
- Phase A: `web/` (Vite 8, TypeScript 7, Vitest 4, KLineChart 10.0.3). Pure modules in `web/src/model/`:
  `random` (u1/u2/uc, Box-Muller, seeded test source), `regime`, `engine` (one packet = one GBM step, roll every
  8th packet), `aggregator` (1s/10s/30s/1m/5m wall-clock buckets, deterministic synthetic volume, no bars when
  entropy stops), `account` (MT5 hedging, spread from limits, SL/TP per tick with gap fills + slippage, MT5 stop
  validation with messages, free-margin check, margin call <100%, stop-out largest loser first <50%, journal),
  `packet` (GT1/GT1S/HELLO/INFO/ERR parser + seq gap/restart tracker); `src/config.ts` loads limits.jsonc.
- **32/32 tests pass**, `tsc --noEmit` clean. Covers all SPEC acceptance maths (3 sanity examples, regime clamps
  0.15/0.01, gap slippage, stop-out order, determinism, 8-tick roll, OHLC aggregation).
- Design note: synthetic volume no longer uses an extra random draw (the old spec's 0.8+0.4u term) so every ESP32
  number is used exactly once by the price model; volume is deterministic from the price path.

## 2026-10-05 — Phase B part 1 + GBP/JPY market clock
- Terminal committed (09865b0): KLineChart 10, 1s-5m wall-clock candles, TradingView-style tool rail (own icons in TV
  style; TV's artwork is proprietary so not copied) + favourites bar + magnet/lock/hide, Long/Short Position boxes
  styled like TV (zones, open-P&L band, Target/Stop/centre tags) that place real demo orders and modify SL/TP on drag,
  draggable SL/TP lines, one-click ticket with MT5 validation messages, Trade/History/Journal, proof drawer, Web Serial
  ESP32 source (watchdog 400 ms, radio INFO/ERR), session save/restore, phone layout. Verified in headless Chrome
  (agent-browser): box -> live position, wrong-side SL rejected with message, order lines, no page-level h-scroll.
- THIRD_PARTY_NOTICES.md: KLineChart NOTICE includes TradingView Lightweight Charts, so both are credited (footer too).
- Found: prototype parameters at 6.25 steps/s ran far too fast (100 -> 35 in 30 min; volatility drag ~x0.24/hour, 0.00
  within a day). Asked Praveen; he chose "most like real fx charts (think GJ)". Simulated k = 234 / 47 / 450,000, then
  chose k = 1,400,000: ~0.023%/1m, ~0.2%/h, ~1%/day, flat long-run. Start 190.000, 3 decimals. Synthetic volume scaled
  by sqrt(k). Tests pin the prototype identity (k=1), the GJ defaults and a 12-hour volatility band: 35/35 pass.
- Suggested to Praveen (his file): contract_size 1000 for ~$10/pip per lot. Account tests now use SPEC constants.

## 2026-10-05 — Phase E: Cloudflare relay (parallel agent), verified, not deployed
- Built by a parallel agent, reviewed + re-run by the main session after the GJ engine change:
  `npm test` 36/36 relay unit tests (+ limits check), `npm run worker:check` clean, `npm run worker:e2e` **31/31 PASS**
  (identical packets/prices/candles on two viewers, frozen within 404 ms of uplink silence and 9 ms of close,
  unsigned/bad-MAC/wrong-key/replay rejected, HELLO restart, online-off refusal, viewer cap, message cap).
- Worker `worker/src/index.ts` + Durable Object `TapeRelay` (Hibernation API, SQLite, shared engine import),
  pure `limits.ts` (missing/malformed -> online off), `ingest.ts`, synchronous HMAC; owner limits bundled from
  limits.jsonc; `ALLOW_TEST_OVERRIDE` only in git-ignored .dev.vars and fail-closed (503) on any non-local host.
- wrangler.jsonc: main, assets (run_worker_first /api/*), Text rule for .jsonc, TAPE -> TapeRelay, new_sqlite_classes,
  rate limits on 2001/2002 (Free-plan availability of that binding unconfirmed; drop the block if deploy rejects it).
- Known limitation (needs Praveen's OK to fix, packet format): unsigned HELLO + no boot nonce allows a replay
  "restart" by someone holding recorded signed lines; 32-bit MAC. Documented in docs/RELAY_PROTOCOL.md 3.5.
- Main session added web/src/entropy/relay.ts (viewer + USB bridge client).

## 2026-10-05 — Phase F: "Why patterns appear in pure noise" page (parallel agent) + online client
- `web/learn.html` + `web/src/learn/` (analysis.ts pure maths via the shared engine/Account, own canvas drawing):
  1 coin-flip candles, 2 spot-the-pattern (reveal + 300-chart pattern-finder rates), 3 trendlines always fit
  (~91-94% of charts have a 3-touch line), 4 strategy lie detector (EMA 20/50 or breakout on 1,000 fresh sessions vs a
  coin-flip trader; verdict computed, not hard-coded), 5 why hardware noise. Phone: no page h-scroll.
  18 tests; web suite 53/53; tsc clean; vite builds both pages.
- **Key finding by the agent:** under the old prototype clock (k = 1) trend rules BEAT the coin (EMA ~61%, breakout
  ~64-67% of sessions, t = 5-12) because of regime drift + every session starting in expansion. Under the GJ clock
  (k = 1.4M) the edge is gone (EMA 50% vs coin 47% of sessions, |t| < 3). A pinned test fails on purpose if the clock
  is ever lowered enough to make the tape beatable again. So the GJ choice also keeps the project's claim honest.
- Online client in the terminal: "Watch online" (RelayViewer: snapshot + per-packet shared-engine replay, own
  400 ms watchdog, drift check against the relay tick) and "Share ESP32 online" (RelayBridge forwards raw serial
  lines verbatim; SerialSource.onLine tap). Serial packets never step the local engine while in online mode.

## 2026-10-05 — Phase D: randomness proof (parallel agent), board restored to live firmware
- Firmware: CAPTURE_MODE behind #ifndef; new RADIO_OFF_CONTROL (capture builds only; `#error` if used live, tested).
  tools/capture.py: no reset on open, waits for data, discards first 1 s, 64 KB reads, prints KB/s.
- Captures (data/, git-ignored): esp32_radio_on.bin 10 MB, esp32_radio_off.bin 10 MB (control), esp32_radio_on_2.bin 1 MB;
  113.7 s each at 90.1 KB/s (921,600 baud line rate); no boot text inside.
- notebooks/randomness_proof.ipynb (executed, 746 KB; local + Colab upload path) and docs/randomness/RESULTS.md + figures.
  ESP32 ON 10/10, ESP32 OFF 10/10, MT19937 10/10, PCG64 10/10, os.urandom 10/10, RANDU 9/10 (only the 3D-triples
  test catches it: 15 planes). Two ESP32 captures share nothing (0.388% byte matches vs 0.391% chance). Honest
  conclusion: tests show "no detectable pattern"; the true-random claim rests on Espressif's condition + radio
  verification. ent/dieharder only in the notebook's Colab section (not run locally, untested in Colab).
- After re-flashing live firmware: phase1-check PASS (GT1,INFO,radio=on,ps=none,aps=2; 1000/1000, 0 gaps).
- Online mode browser-tested locally (wrangler dev on 8799 with the local override; 8787 was taken by Praveen's
  separate "Fair Map" project dev server, left untouched): two viewers LIVE from a simulated signed uplink, both froze
  at the identical price 189.970 within 400 ms of the uplink stopping. Rate slider locked in online mode (shared).

## 2026-10-05 — Central-bank-rate slider removed; ESP32 data independently verified; FIRST DEPLOY
- Praveen: "central-bank-rate slider?? we dont want those" / "No rates or macro economic simulation wanted for now".
  Slider removed (rate fixed at the 5% default, so behaviour unchanged). Regime (expansion/recession) removal next.
- Praveen asked whether the agent really used the ESP32. Main session re-captured 2 MB itself (capture build on COM5,
  90.1 KB/s): chi2 p=0.404, 7.999911 bits/byte, bit z=+0.36, serial corr -0.0007; 0.387% same-position matches with the
  agent's file (chance 0.391%). Live firmware re-flashed afterwards.
- **Deployed** (rule 7, no GO needed): whoami = Stacklineops e6474e41 (not salon). `wrangler deploy` -> Version
  014bee16-cbf7-41df-95ab-4f18c65031bf, https://ghosttape.teamkestrel.workers.dev . Rate-limit bindings accepted on Free.
  Verified live: home 200, /learn 200 (/learn.html 307 -> /learn), /api/state online_enabled=false "online mode is off",
  demo tape running in headless Chrome. No DEVICE_SECRET set yet (only needed when online mode is switched on).
  Reversal: `npx wrangler rollback <previous-version-id>` (first version: redeploy a fixed build).

## 2026-10-05 — No regimes/rates; TRNG switch; redeploys
- Regimes removed by default (Praveen: "No rates or macro economic simulation wanted for now"): driftless GBM,
  sigma 0.014164 (old mix's long-run vol) before the k = 1.4M clock; c word unused; prototype model kept behind
  `regimeSwitching: true`. Regime badge, proof rows and the learn page's "hidden moods" text/shading removed.
  Tests 55/55 (new: default has no shifts/drift, c does not affect the path). Deployed 6ea1c553.
- TRNG switch (Praveen: "a simple switch there to turn trng on"): replaces Connect ESP32 / Demo entropy.
  OFF = browser randomness (demo); ON = ESP32 over Web Serial (port picker; cancel flips it back off); browsers
  without Web Serial use the online relay. Deployed **630b926e-8056-4dba-82ae-6251311c5a88**; live HTML has the switch.

## 2026-10-05 — Praveen's live ESP32 test + fixes from his recording (21:28)
- His recording shows TRNG on · ESP32, LIVE · ESP32 hardware entropy, 6.4/s, unplug/replug resumes: Phase C works on
  the real board in his browser.
- Fixes he asked for: (1) indicator legends get TradingView-style eye (hide/show) and x (remove) buttons
  (KLineChart tooltip features + onIndicatorTooltipFeatureClick; removal persists in prefs); (2) a searchable
  TradingView-style Indicators dialog (search, groups All/Added/Trend/Volatility/Momentum/Volume, Add/Remove) with
  all 29 indicators (KLineChart built-ins + our ATR and EMA bands); (3) "it should keep the real time gap": on resume,
  missed buckets get flat gap candles at the frozen price with zero volume (up to 900 per timeframe; longer outages jump).
- Tests: web 56/56 (new gap tests), relay 36/36, worker tsc clean. Browser-checked: legend x removes ATR + saves pref.

## 2026-10-05 — Public URL switched OFF (Praveen: "off")
- Explained first that usage was ~0 (static assets free; online mode off). Praveen chose off.
- wrangler.jsonc: "workers_dev": false, "preview_urls": false; deployed 2ade5af8-b7c7-4d09-8160-d770ae8bf7f6
  ("No targets deployed"). Verified: https://ghosttape.teamkestrel.workers.dev/ and /api/state -> 404 (Cloudflare
  error 1042). Nothing deleted: the Worker, its Durable Object and the last good build stay in the account.
- To bring it back with the same link: set both flags to true, `npx wrangler deploy` (last public version: 34471865).

## 2026-10-06 — Public URL back ON (Praveen: "activate it first")
- workers_dev/preview_urls true; deployed 17c6ab20-9772-4151-bfe1-e941bfbb61d9. Verified home 200 with the TRNG switch,
  /learn 200, /api/state online_enabled=false. Online mode still OFF (limits.jsonc), so usage stays ~0.

## 2026-10-06 — Real randomness for visitors: signing, secret, bridge, TRNG switch (online still OFF)
- Praveen: "make it so they can see the real randomness".
- Firmware signs every packet (GT1S, HMAC-SHA256 first 8 hex) when the git-ignored secrets.h exists; key generated
  locally and never printed. Flashed; phase1-check now verifies every HMAC: 300/300 signed, 0 bad, radio INFO ok.
- `wrangler secret put DEVICE_SECRET` piped from secrets.h (not shown); `secret list` shows it.
- tools/bridge.ps1: PowerShell (.NET SerialPort + ClientWebSocket, no installs) forwards each serial line to
  wss://.../api/ingest immediately; stops on GT1,CMD,pause; reboots the board first so the relay sees HELLO.
  Tested against the LIVE relay: connected, relay replied pause(offline), bridge stopped cleanly (online is off).
- TRNG switch: ON now checks /api/state; if the owner's ESP32 is streaming online -> watch the shared live tape,
  else local Web Serial. Page shows "real ESP32 is streaming right now" banner when live (1 request per page load).
  Deployed 792bbcf6-0306-4ca6-a44f-9a9d839ecfca.
- Waiting on Praveen: set "online_enabled": true in limits.jsonc (owner-only). Then redeploy + start the bridge.
