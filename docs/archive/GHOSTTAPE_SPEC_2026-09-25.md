# GhostTape: build spec

> A TradingView-style chart plus an MT5-style demo trading terminal. The market is **synthetic**, and every random draw in it comes from an **ESP32's hardware random number generator** (thermal noise and clock jitter on the chip).
>
> A working single-file prototype is in `ghosttape-reference.html`. Treat it as the source of truth for the engine math and the trading rules, and rebuild it properly using the architecture below.

---

## 1. Product in one paragraph

GhostTape runs a fake instrument, `GHOST/USD`, whose price comes from a regime-switching Geometric Brownian Motion model. The usual way to build this seeds it with `Math.random()`. GhostTape seeds it with real hardware entropy streamed from an ESP32. Users watch it on a chart that looks and feels like TradingView and trade it the way they would in MT5: lots, leverage, spread, SL/TP, margin, margin calls and stop-outs. A "central bank rate" slider changes how likely the market is to fall into a recession regime. It's a toy with serious mechanics, and it has to say clearly that it's synthetic.

## 2. Non-negotiables

- **Label it as synthetic everywhere.** Keep a persistent badge ("synthetic market, not real data") and a footer disclaimer: demo account only, no real money, not financial advice, not a trading signal.
- **Show the entropy source live.** The UI always shows where the randomness is coming from right now: `ESP32 · live`, `ESP32 · stale (Xs)` or `Browser fallback`. Never claim "ESP32" when it isn't.
- **Engine is pure and testable.** Every random draw goes through an injected `RandomSource` interface. Tests use a seeded deterministic source.
- **Trading math matches MT5 conventions.** See section 6. Unit tests lock it in.
- **Credit TradingView.** The chart is built on TradingView's open-source Lightweight Charts. Keep the attribution logo on the chart plus a credits line and link (see "Built on TradingView's open-source libraries" in section 3). This is a license requirement, not optional polish.

## 3. Stack

Match my existing setup:

- **Frontend:** Next.js (App Router) + TypeScript. The app is fully client-side (chart + WebSocket), so use `output: 'export'` and deploy the static build with **Workers Static Assets**. If server rendering is ever needed, follow Cloudflare's current Next.js-on-Workers guide (they now recommend vinext, with OpenNext as the fallback). Don't use `next-on-pages`.
- **Chart:** [`lightweight-charts`](https://github.com/tradingview/lightweight-charts) **v5.x**, TradingView's open-source charting library. v5 supports **multiple panes**, which RSI needs.
  - Keep the TradingView attribution logo on (`attributionLogo: true`, the default). The Apache-2.0 license requires attribution.
  - The library has **no built-in drawing tools**. Trendline and horizontal line have to be built with its plugin API ("series primitives"). A horizontal line can use `createPriceLine`.
- **Backend:** Cloudflare Worker + **Durable Object**, which acts as the entropy pool and the shared market.
- **Firmware:** ESP32 (any WiFi-capable variant), Arduino core or ESP-IDF.
- **Shared engine:** a `packages/engine` TypeScript package with no DOM dependencies. The DO uses it server-side and the tests use it too.

### Built on TradingView's open-source libraries

GhostTape doesn't build a charting engine. The whole chart layer is **TradingView's own open-source code**, and we say so openly on the site.

| Library | License | What we use it for |
|---|---|---|
| [`lightweight-charts`](https://github.com/tradingview/lightweight-charts) v5.x (`npm i lightweight-charts`) | Apache-2.0 | Candles, volume histogram, EMA lines, RSI pane, crosshair, price lines (entry/SL/TP), trade markers |
| `plugin-examples/` in the same repo (official) | Apache-2.0 | Starting point for the drawing tools. Adapt their series-primitive examples (e.g. the trend line and drawing-tool samples) into our Trendline and H-line tools instead of writing them from scratch |

Not used, and why:

- **TradingView Advanced Charts** is free, but its license is only for companies in public projects, and it isn't open source.
- **TradingView Trading Platform** has a built-in order UI, but it's proprietary and needs a special arrangement with TradingView.

Our own code is the market engine, the MT5-style account/order logic and the ESP32 entropy pipeline.

**License obligations (required by lightweight-charts' Apache-2.0 terms, so do all three):**

1. Keep `attributionLogo: true` (the default) so the TradingView logo/link shows on the chart.
2. Add the attribution notice from the library's `NOTICE` file to the site (a Credits/About page is fine) along with a link to https://www.tradingview.com/.
3. Include the Apache-2.0 license text and NOTICE in the repo (`/THIRD_PARTY_NOTICES.md`).

UI copy for the footer: "Charts by TradingView Lightweight Charts™ (open source). GhostTape is not affiliated with TradingView."

### Suggested layout

```
/firmware/ghosttape-entropy/     ESP32 sketch (PlatformIO or Arduino)
/workers/market/                 Worker + Durable Object (entropy pool + shared market)
/packages/engine/                pure TS: RandomSource, gbm, regime, aggregator, account
/apps/web/                       Next.js UI
```

## 4. Entropy pipeline (ESP32 → chart)

### How the ESP32 RNG actually works (don't get this wrong)

- `esp_random()` / `esp_fill_random(buf, len)` read the hardware RNG (`RNG_DATA_REG`).
- It's **only a true random source while WiFi or Bluetooth is running**, because the RF subsystem is what feeds noise from the high-speed ADC into the RNG. With RF off, Espressif's own docs say the output should be treated as **pseudo-random**. (`bootloader_random_enable()` is the other way to get true randomness, but it's meant for early boot and conflicts with ADC/RF use at runtime.)
- **No firmware hacks are needed.** Connecting to WiFi is enough, and the firmware has to be on WiFi to upload anyway.

### Firmware

```
setup: connect WiFi (this also puts the RNG in true-random mode)
loop every 5 s:
  esp_fill_random(buf, 1280)            // batched: 1 request per 5 s, not per second (free-tier budget, section 4b)
  POST https://<worker>/ingest
    headers: X-Device-Id, X-Timestamp, X-Signature = HMAC-SHA256(secret, ts || body)
    body: raw 256 bytes (application/octet-stream)
  on failure: back off, keep trying; never block
```

- Flash the secret per device and store the Worker copy as a Worker secret (`wrangler secret put`).
- Budget: 1280 bytes every 5 s (256 B/s) covers the engine many times over (see 5.3).

### Worker / Durable Object (`MarketDO`)

- `POST /ingest`: verify the HMAC and reject timestamps more than 30 s old (replay protection). Append the bytes to a ring buffer (keep about 64 KB) and record `lastIngestAt`.
- **Mixing rule:** every byte the engine uses = `SHA-256(esp32_chunk || crypto.getRandomValues(32))`, expanded in counter mode. Hardware entropy is primary, and the output stays safe if the device is dead or compromised. Show the mix honestly in the proof panel.
- **Fallback:** if `now - lastIngestAt > 10 s`, the source becomes `browser/worker fallback` and the UI badge switches to match.
- The DO **runs the market itself** (section 5) so every viewer sees the same tape. It broadcasts ticks over **WebSocket** (use hibernatable WebSockets).
- `GET /state` returns a snapshot: recent candles for each timeframe, the current regime, the rate, the entropy status and the last N raw entropy bytes (hex) for the proof panel.

## 4b. Cloudflare services and free-tier budget

| Service | Job | Notes |
|---|---|---|
| **Workers Static Assets** | Serves the Next.js static build | Free |
| **Worker** | `/ingest` (ESP32), `/state`, WebSocket upgrade | Free plan: 100k requests/day |
| **Durable Object (SQLite-backed)** | Entropy pool, runs the shared market, broadcasts ticks, leaderboard (M3) | On the Free plan only SQLite-backed DOs are allowed. Free: 100k req/day, 13,000 GB-s/day, 100k SQLite rows written/day |
| **WebSocket Hibernation API** | Client connections to the DO | Outgoing messages are free; incoming count 20:1 |
| **Worker Secrets** | ESP32 HMAC key | `wrangler secret put DEVICE_SECRET` |

Not needed: KV (eventually consistent, and its write limits are wrong for a live pool), D1 (the DO's built-in SQLite covers it) and R2.

**Budget rules (keep it at $0):**

- **Requests:** an ESP32 posting every second = 86,400 requests/day, right at the 100k limit before any visitor loads the page. Batch every 5 s (17,280/day).
- **Duration:** a DO ticking every 250 ms never hibernates. At 128 MB that's 0.125 GB × 86,400 s = 10,800 GB-s/day for one DO running 24/7, which fits under the 13,000 free allowance but not with much room. **Pause the market when nobody is connected** (stop the tick alarm, keep ingesting entropy) and resume from the last price when someone joins. Show "market was paused while empty" in the journal.
- **SQLite writes:** don't write every tick or every 1m bar. At 2 s per market minute that's 43,200 rows/day for 1m alone. Keep candles in memory and snapshot to SQLite every 30 s, plus whenever the last client disconnects.
- Use a DO **alarm** (`ctx.storage.setAlarm`) for the tick loop, not `setInterval`.

### Optional: local demo with no internet

The ESP32 prints hex lines over USB serial, and a local page reads them with the **Web Serial API** (desktop Chrome/Edge only, top-level page, needs a user gesture). Handy for a live demo table. Not needed for v1.

## 5. Market engine (`packages/engine`)

### 5.1 RandomSource

```ts
interface RandomSource { nextUint32(): number }            // from the entropy pool
const u01 = (r) => (r.nextUint32() + 1) / 4294967297       // (0,1), never 0
const gaussian = (r) => Math.sqrt(-2*Math.log(u01(r))) * Math.cos(2*Math.PI*u01(r))  // Box–Muller
```

### 5.2 Price path: tick-level GBM with two regimes

```ts
REGIMES = {
  expansion: { mu:  0.0006, sigma: 0.009 },   // per tick
  recession: { mu: -0.0009, sigma: 0.020 },
}
price = price * Math.exp((mu - sigma*sigma/2) + sigma * gaussian(r))
```

- **Tick rate:** 1 tick every 250 ms of real time.
- **Market clock:** 1 tick = 7.5 s of market time, so **1 market minute = 8 ticks = 2 real seconds** (the market runs 30× faster than real time). Put that on the UI as "market clock 30×".
- Start price is 100.00, shown with 2 decimals.

### 5.3 Regime switching (once per market minute)

Rate `r` is the central bank rate slider, 0–15%, default 5%.

```ts
if (regime === 'expansion') p = clamp(0.03 + (r - 5) * 0.012, 0.01, 0.50)  // → recession
else                        p = clamp(0.05 + (5 - r) * 0.010, 0.02, 0.50)  // → expansion
if (u01(rng) < p) switch regime, log "⚡ regime shift A → B (rate X%)"
```

Higher rates push the market toward recession, the same direction as real monetary policy. The regime shows as a badge (Expansion green, Recession red).

Entropy per tick is 2 uint32 (8 bytes), so about 32 B/s plus one regime roll per market minute. The ESP32's 256 B/s leaves plenty of headroom.

### 5.4 Candles and timeframes

- Aggregate ticks into OHLC for **1m, 5m, 15m and 1h** of market time. The same tick stream feeds all four. Timeframe buttons switch which series the chart shows.
- **Volume is synthetic too:** `volume = ticksInBar * (1 + 40 * |log return of bar|) * (0.8 + 0.4*u01)`, so volatile bars have fat volume. Label it "synthetic volume."
- Keep at least 500 bars per timeframe in the DO and send the last 300 on connect.

## 6. Trading terminal: MT5 rules (client-side account in v1)

### Constants

| Thing | Value |
|---|---|
| Starting balance | $10,000.00 |
| Leverage | 1:100 |
| Contract size | 100 units per 1.00 lot |
| Lot size | 0.01 min, 5.00 max, step 0.01 |
| Spread | 0.02 (2 points), configurable |
| Margin call warning | margin level < 100% |
| Stop out | margin level < 50% |

### Formulas

```
bid = mid - spread/2 ; ask = mid + spread/2
BUY opens at ask, closes at bid.   SELL opens at bid, closes at ask.
P&L        = (closePrice - openPrice) * dir * lots * 100        (dir = +1 buy, -1 sell)
Margin     = lots * 100 * openPrice / 100      (per position)
Equity     = balance + Σ floating P&L
Free margin= equity - Σ margin
Margin lvl = equity / Σ margin * 100          ("—" when no positions)
```

Sanity examples, which should also be unit tests:

- 0.10 lot at 100.00 needs **$10.00** margin (0.10 × 100 × 100 / 100).
- 0.10 lot moving 1.00 in price is **$10.00** P&L.
- 1.00 lot BUY at ask 100.01 that is instantly closed at bid 99.99 is **−$2.00** (the spread cost).

### Behaviour

- **Multiple positions** can be open at once (MT5 hedging account). Each has a ticket number starting at `1000001`.
- **SL/TP are checked on every tick,** not per candle. A position fills at the **first tick that crosses** the level, at that tick's price (bid for long exits, ask for short exits). That means **slippage past the level is real** and gets shown in the journal. If one tick crosses both SL and TP, assume the SL hit first (conservative).
- Reject an SL/TP on the wrong side of the market with an inline message. Never fail silently.
- **Stop out:** while margin level < 50%, close the **position with the largest loss first**, recompute, and repeat. Log each one as `STOP OUT`. This matches how MT5 brokers liquidate.
- **Margin call banner** shows between 50% and 100%.
- Store the account in `localStorage` (wrapped in try/catch), with a "Reset account" button.
- **v2:** pending orders (buy/sell limit, buy/sell stop) and a trailing stop.

## 7. UI: TradingView layout, MT5 terminal

```
┌───────────────────────────────────────────────────────────────────────────┐
│ GhostTape  GHOST/USD  100.42 +0.42%  [Expansion]   ● ESP32 · live 256B/s    │ top bar
│ 1m 5m 15m 1h │ Indicators ▾ │ ✎ Trendline ─ H-line │ rate 5.0% ━━●━━  │ toolbar
├──────┬───────────────────────────────────────────────────┬────────────────┤
│tools │ O 100.31 H 100.55 L 100.12 C 100.42  EMA20 EMA50   │ SELL │ 0.10 │ BUY │
│  ↗   │                                                     │ 100.41   100.43 │
│  ─   │            candles + volume (main pane)             │ SL [    ] TP [ ]│
│  ✕   │          SL/TP/entry price lines, draggable         │ margin req $10  │
│      ├─────────────────────────────────────────────────────┤ order panel    │
│      │            RSI(14) pane, 30/70 bands                 │                │
├──────┴─────────────────────────────────────────────────────┴────────────────┤
│ Balance $10,000  Equity  Margin  Free margin  Margin level   [Reset]         │ account strip
│ [Trade] [History] [Journal]                                                  │ terminal tabs
│ #1000003 BUY 0.10 @100.21  SL 99.80 TP 101.00  cur 100.41  +$2.00  [×]       │
└───────────────────────────────────────────────────────────────────────────┘
```

- **Theme:** dark by default, close to the TradingView dark palette (background around `#131722`, grid `#1e222d`, up `#26a69a`, down `#ef5350`), with a light theme toggle. Fonts: Roboto for UI, Roboto Mono for numbers (tabular). Everything goes through CSS tokens.
- **Crosshair + legend:** the top-left legend updates on crosshair move with O/H/L/C, change and indicator values, just like TradingView.
- **Indicators:** EMA 20 and EMA 50 as line series on the main pane, RSI 14 in a second pane (lightweight-charts v5 panes). Each toggles from the Indicators menu.
- **Position lines:** entry (dashed), SL (red) and TP (green) drawn as price lines. **Dragging an SL/TP line updates the order.** This is the most "real platform" feature, so build it.
- **Trade markers:** buy/sell arrows at the entry bar (`createSeriesMarkers`).
- **Order panel:** MT5 one-click style with the bid on the SELL button and the ask on the BUY button. Update prices live and show the margin required before clicking.
- **Terminal tabs:** Trade shows open positions with live P&L and a close button. History shows closed deals with open/close price, pips and P&L. Journal shows the event log (opens, closes, SL/TP hits with slippage, stop outs, regime shifts, entropy source changes).
- **Entropy proof drawer:** the last 64 raw ESP32 bytes (hex), bytes/s, last-seen time, the mixing formula, and how many draws the last candle used.
- **Mobile:** the chart gets full width, the order panel becomes a bottom sheet, and the terminal tabs sit below the chart. No horizontal page scroll.

## 8. Milestones

1. **M1: Engine + UI, no hardware.** `packages/engine` with tests. Next.js page runs the engine in the browser with `crypto.getRandomValues` as the `RandomSource`, badge showing `Browser fallback`. Full TradingView layout, MT5 terminal and localStorage account. Deploy to Pages.
2. **M2: ESP32 live.** Firmware, `/ingest` with HMAC, Durable Object entropy pool, the DO runs the market and broadcasts ticks over WebSocket, client switches to server ticks, entropy badge and proof drawer go live, fallback logic works.
3. **M3: Retention.** A prop-firm challenge mode (hit +8% without breaching a 5% daily drawdown or a 10% max drawdown, with a pass/fail screen), a leaderboard (in the DO), pending orders and a trailing stop.

## 9. Acceptance tests

- Engine: with a seeded `RandomSource`, the same seed gives the same ticks and candles, and aggregating 8 ticks gives exactly one 1m bar with correct OHLC.
- Regime: at rate 15% the expansion→recession probability clamps to `0.03 + 10*0.012 = 0.15` per market minute; at rate 0% it clamps to the 0.01 floor.
- Account: all three sanity examples in section 6 pass. A forced drawdown triggers the margin call at <100% and stops out the largest loser first at <50%.
- SL/TP: a tick that gaps past the SL fills at the gap price, not the SL price, and the journal shows the slippage.
- Entropy: kill the ESP32, and within 10 s the badge says fallback and the tape keeps running. Bring it back and the badge recovers.
- Honesty: the synthetic badge and disclaimer are visible on every screen size.

## 10. Reference numbers from the prototype

- Prototype chart window: 46 candles; one candle = 8 GBM sub-steps (kept here as 1 market minute = 8 ticks).
- Prototype tick interval: 1.3 s per candle. The spec speeds this up to 2 s per 1m bar using 250 ms ticks.
- Prototype SL/TP used candle high/low. The spec improves this to per-tick fills with slippage.
