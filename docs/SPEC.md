# GhostTape: build spec for Claude Code

> **Addendum 2026-10-05 (Praveen's decisions; these win over conflicting text below).**
> Paths: this file moved from `ghosttape/CLAUDE.md` to `docs/SPEC.md`; the prototype is now `prototype/index.html`;
> the project root is `GhostTapeTradingTRNG/` (no `ghosttape/` subfolder). Safety rules live in the root `CLAUDE.md`.
>
> 1. **Theme: light** (TradingView light palette), not dark. All colours via CSS tokens.
> 2. **UI = TradingView full-chart layout** (from the 2026-10-05 screen recording): left drawing-tool rail, a
>    draggable favourites toolbar, trendline / H-line / ray / rectangle, **Long and Short Position boxes**
>    (drag + stretch, labels for Stop, Target, R:R, open P&L) that can be turned into real demo orders, SELL/BUY
>    one-click buttons, popular indicators addable in bottom panes (ATR, EMA bands, EMA 20/50, RSI, MACD,
>    synthetic volume), $10,000 demo account, Trade / History / Journal tabs.
> 3. **Timeframes: 1s, 10s, 30s, 1m, 5m** (max 5m), as wall-clock buckets all fed by the one packet stream.
>    One packet = one GBM sub-step and the regime roll every 8 packets stay exactly as in the model below;
>    only the candle aggregation changes (the "8 sub-steps make one candle" display rule is replaced).
> 4. **Spread 0** for now (BUY and SELL fill at the same price). **Gapped stops fill at the first price that
>    crosses the level** (MT5 behaviour), and the journal shows the slippage. This replaces "Fill at the stop level".
> 5. **Proof notebook:** a Google Colab `.ipynb` comparing the ESP32 capture with MT19937, NumPy PCG64, the OS
>    CSPRNG and RANDU (a known-bad control). Honest framing: tests show "no detectable pattern"; the "true
>    random" claim rests on the physical source (Espressif: true random only while Wi-Fi/BT is on and the RF
>    subsystem is not asleep, or while `bootloader_random_enable()` is active).
> 6. **Online mode (Phase 5) is OFF by default** and switched only by Praveen in the owner-only `limits.jsonc`;
>    the Worker enforces its daily caps on the server.
> 7. Chart library: 1-hour spike on KLineChart (Apache-2.0, built-in drawings + indicators), falling back to
>    TradingView Lightweight Charts + our own tools. Either way, keep the library's attribution and licence notices.
> 8. The prototype's real CSE price panel is dropped.
> 9. **Radio verification (approved "radio fix OK").** The firmware proves the true-random condition instead of
>    assuming it: at boot it starts Wi-Fi STA, disables sleep and runs one Wi-Fi scan (a completed scan proves the
>    radio is physically running); it re-checks mode + power-save every 30 s. New status lines, which 5-field
>    packet parsers ignore: `GT1,INFO,radio=on,ps=none,aps=<networks found>,up=<s>` and
>    `GT1,ERR,radio_off,<reason>`. **If verification fails, no packets are sent** (the chart freezes rather than run
>    on pseudo-random numbers). Blue LED (GPIO 2) is on only while verified. The UI should show the radio status.

GhostTape is a synthetic, tradable price chart whose every move comes from physical randomness: thermal and RF noise sampled by an ESP32. It looks and trades like a real terminal (candles, drawings, lots, SL/TP, margin), but it is pure noise by construction. Patterns traders "see" in it predict nothing, which is the point of the project.

The starting prototype is `index.html` in this folder. It already runs in two modes: **Demo** (browser `crypto.getRandomValues`, clearly labelled) and **ESP32 live** (Web Serial). Treat it as the reference for behaviour and the model, then rebuild it properly following the phases below.

## Non-negotiable rules

1. **In ESP32 mode, every price move comes from one ESP32 packet.** The browser never generates randomness in this mode, and never falls back to `Math.random` or `crypto` silently.
2. **No entropy stock on the live path.** Do not buffer, pre-generate or queue numbers between the ESP32 and the chart. Unplugging the ESP32 must freeze the candles within about 0.2 s (USB) or 0.5 s (cloud).
3. **Each random number is used exactly once.** Never reuse or replay packets.
4. **Demo mode is always labelled** "DEMO · browser entropy, not hardware". Switching modes starts a new session.
5. **The ESP32 must run with Wi-Fi enabled** (or `bootloader_random_enable()` active). Otherwise `esp_random()` is only pseudo-random and the project claim is false.
6. **Always show "Synthetic tape, not real market data"** and the no-advice notice. No real money, no real broker, ever.
7. Ask Praveen before changing the price model's parameters, the packet format, or anything that weakens rules 1–5.

## Architecture

```
ESP32 (esp_random, RF/thermal noise)
  │  USB serial, 115200 baud, text packets          ← stage demo (Phase 1–3)
  │  or Wi-Fi WebSocket (wss)                        ← online version (Phase 5)
  ▼
Browser: Web Serial reader ──► packet parser ──► model step ──► chart + account
                                    ▲
Cloudflare Worker + Durable Object (relay only, holds no unused numbers)
  ├─ receives the ESP32 WebSocket, verifies HMAC
  ├─ broadcasts each packet to all viewers immediately
  └─ D1: stores finished candles only (for history), never raw unused entropy
```

## Stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Firmware | Arduino IDE 2 or PlatformIO, arduino-esp32 core 3.x | `firmware/ghosttape_esp32/ghosttape_esp32.ino` |
| USB driver | CP210x or CH340 (match the board) | Windows needs it to see the COM port |
| Frontend | Vite + TypeScript, no framework needed | Keep it a single page |
| Chart | TradingView Lightweight Charts (Apache-2.0) | Licence requires visible TradingView attribution (keep `attributionLogo: true`). Trendlines/H-lines need series primitives or a small custom drawing layer. |
| USB input | Web Serial API | Chrome or Edge desktop only; page must be served from `localhost` or https |
| Relay (Phase 5) | Cloudflare Workers + Durable Objects (WebSocket hibernation API), Wrangler | One Durable Object per tape |
| History (Phase 5) | Cloudflare D1 | Finished candles only |
| ESP32 WebSocket client | `links2004/arduinoWebSockets` with SSL | Phase 5 |
| Packet signing | HMAC-SHA256 via mbedTLS (built into the ESP32 core) | Phase 5; key in a git-ignored header |
| Randomness tests | `ent`, dieharder, PractRand (`RNG_test`) | `tools/capture.py` dumps raw bytes |

## Packet protocol (v1)

Text lines at 115200 baud: `GT1,<seq>,<a_hex>,<b_hex>,<c_hex>\n`

- `seq`: uint32 counter, resets to 0 on boot. A drop in `seq` means the ESP32 restarted; a jump means lost packets (count and display gaps).
- `a`, `b`: uint32 for one Box–Muller Gaussian. `c`: uint32 for the regime roll.
- `GT1,HELLO` is sent once on boot. Ignore malformed lines; never invent values to fill them.
- Phase 5 adds a signed variant: `GT1S,<seq>,<a>,<b>,<c>,<hmac8>` where `hmac8` is the first 8 hex chars of HMAC-SHA256 over `seq,a,b,c`.

## Price model (methodology)

All of this already exists in `index.html`; keep the maths identical unless Praveen approves a change.

1. **Uniforms.** `u1 = (a + 1) / (2^32 + 1)` (never 0, so `log` is safe), `u2 = b / 2^32`, `uc = (c + 1) / (2^32 + 1)`.
2. **Gaussian.** Box–Muller: `z = sqrt(-2 ln u1) · cos(2π u2)`.
3. **Sub-step.** Geometric Brownian motion: `price ← price · exp((μ − σ²/2) + σ z)`. One packet = one sub-step.
4. **Candle.** 8 sub-steps make one candle. The forming candle updates live on every packet (open, high, low, close).
5. **Regimes.** Two-state Markov switch (Hamilton-style): expansion μ = 0.0006, σ = 0.009; recession μ = −0.0009, σ = 0.020. At each candle close, roll `uc` against the switch probability:
   - expansion → recession: `p = clamp(0.03 + (rate − 5) · 0.012, 0.01, 0.5)`
   - recession → expansion: `p = clamp(0.05 + (5 − rate) · 0.010, 0.02, 0.5)`
   - `rate` is the central-bank slider (0–15 %).
6. **Account (MT5-style demo).** Balance 10,000 USD, leverage 1:100, 1 lot = 100 units. Margin = lots · 100 · entry / 100. Margin call warning below 100 % margin level; stop-out closes the worst position below 50 %.
7. **Stops.** SL/TP are checked against every sub-step price as it arrives, so stops fire intrabar and never against prices from before the trade was opened. Fill at the stop level.
8. **Later, optional (ask first):** fat tails (Student-t from the uniform via inverse CDF) and volatility clustering (a slowly varying σ also driven by ESP32 numbers). These make the tape feel more like a real market without adding any predictability.

## Unplug demo behaviour

- No packets → no price changes. The forming candle freezes mid-candle.
- Watchdog: no packet for 2.5 × packet interval (400 ms at 160 ms) → status turns red, overlay "ESP32 disconnected · no entropy · no candles".
- `navigator.serial` `disconnect` event and a rejected `reader.read()` both trigger the same offline state.
- Replug: the `connect` event reopens the previously granted port automatically and the tape resumes from the frozen price. A `seq` reset is logged as "ESP32 restarted".
- A raw feed panel shows the last packets (seq + hex) so the audience sees numbers stop at the same instant as the candles.

## Phases and acceptance checks

**Phase 1: firmware.** Flash the sketch. Serial monitor shows `GT1,...` lines at about 6 per second. Done when 1,000 consecutive packets parse with no gaps.

**Phase 2: browser live mode.** Vite + TS page with Connect ESP32, raw feed panel, status chip, watchdog. Done when unplugging freezes the chart in under 0.2 s, replugging resumes it, and Demo mode is visibly labelled.

**Phase 3: chart and trading.** Port the model and account from `index.html`; switch rendering to Lightweight Charts with a drawing layer for trendlines and H-lines. Done when SL/TP, margin call and stop-out behave as in the prototype, and unit tests cover Box–Muller mapping, the regime probabilities and margin maths (Vitest).

**Phase 4: prove the randomness.** Set `CAPTURE_MODE 1`, capture at least 10 MB with `tools/capture.py`, run `ent`, dieharder and PractRand. Save the outputs in `docs/randomness/` and add a short results page linked from the app. Done when results are saved and the app shows the date and pass summary.

**Phase 5: online version.** ESP32 connects over Wi-Fi to a Cloudflare Worker WebSocket; one Durable Object relays packets to viewers with no queue of unused numbers; HMAC verified per packet; D1 keeps finished candles for history. Done when two browsers show identical candles live and pulling the ESP32's power freezes both within about 0.5 s.

**Phase 6: polish.** Session replay from D1, shareable read-only tape link, mobile layout, and the "strategy lie detector" page that explains why patterns appear in pure noise.

## Suggested structure

```
ghosttape/
  CLAUDE.md
  index.html                  # prototype: reference only
  firmware/ghosttape_esp32/ghosttape_esp32.ino
  tools/capture.py
  web/                        # Vite + TS app (Phases 2–3)
    src/entropy/serial.ts     # Web Serial source + watchdog
    src/entropy/demo.ts       # labelled demo source
    src/model/                # uniforms, box-muller, gbm, regimes, account
    src/chart/                # Lightweight Charts + drawing layer
  worker/                     # Cloudflare Worker + Durable Object (Phase 5)
  docs/randomness/
```

## Commands

- `cd web && npm create vite@latest . -- --template vanilla-ts && npm i lightweight-charts`
- `npm run dev`, then open `http://localhost:5173` in Chrome or Edge (Web Serial needs localhost or https)
- `npm i -D vitest` for model tests
- Phase 5: `npm create cloudflare@latest worker`, `npx wrangler dev`, `npx wrangler deploy`

## Start here

Read `index.html` and this file, then begin Phase 2. Show Praveen the plan for the `web/` folder before writing code.
