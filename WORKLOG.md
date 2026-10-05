# GhostTape work log

## State block (keep current; a cold session recovers from this)
- **Phase:** Stage 0 (safe setup) done locally on 2026-10-05; nothing deployed, no GitHub repo, no push.
- **Waiting on Praveen:** (1) run `node tools/lock-limits.cjs` once so `npm test` goes green;
  (2) OK to overwrite whatever is on the ESP32 with the GhostTape firmware (Phase 1).
- **Next:** Phase 1 flash + 1,000-packet check → Phase A engine + tests → chart-library spike → Phase B terminal.
- **Hardware:** ESP32-D0WD-V3 rev 3.1 on COM5 (CP210x). Arduino IDE 2 + esp32 core 3.3.0 installed.
- **Open question:** GitHub repo public or private (ask at creation, GO-gated).

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
