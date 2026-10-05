# GhostTape work log

## State block (keep current; a cold session recovers from this)
- **Phase:** Stage 0 done + **Phase 1 PASSED with radio verification** (2026-10-05). Nothing deployed, no GitHub repo, no push.
- **Waiting on Praveen:** (1) run `node tools/lock-limits.cjs` once so `npm test` goes green;
  (2) [done] repo created PRIVATE + 4 commits pushed (2026-10-05, "GO private");
  (3) restart Claude in this folder so the guard hook goes live (it isn't loaded in the setup session).
- **Next:** Phase A engine + tests → chart-library spike → Phase B terminal.
- **Hardware:** ESP32-D0WD-V3 rev 3.1 on COM5 (CP210x). Arduino IDE 2 + esp32 core 3.3.0 installed.
- **GitHub:** https://github.com/PraveenBanneka/ghosttape (PRIVATE). Pushes need GO.

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
