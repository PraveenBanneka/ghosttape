// Pure computation for the "why patterns appear in pure noise" page (learn.html).
// No DOM here: everything is deterministic given a packet source, so the Vitest suite can pin it with
// seededPackets. The maths of the tape itself is NOT duplicated: sessions come from the shared TapeEngine
// and CandleSeries, and the backtest trades through the shared MT5-style Account.

import type { Packet } from '../model/random';
import { START_PRICE, TapeEngine } from '../model/engine';
import { CandleSeries, TIMEFRAMES, type Candle, type Timeframe } from '../model/aggregator';
import { Account, type AccountConfig, type Side } from '../model/account';
import type { Regime } from '../model/regime';

export type PacketSource = () => Packet;

/** Firmware cadence (one packet every 160 ms), used to give demo sessions a realistic wall clock. */
export const DEMO_PACKET_MS = 160;
/** Default session: 1,000 packets = 1,000 random steps, about 2.7 minutes of live tape, ~160 one-second candles. */
export const SESSION_PACKETS = 1000;
/** Backtest sessions are longer (2,000 packets, ~320 candles) so a 50-candle average has room to trade. */
export const BACKTEST_PACKETS = 2000;
/** Backtest position size: 1 lot = 100 units (margin about $190 at 1:100), a normal demo-terminal trade. */
export const BACKTEST_LOTS = 1;

// ---------------------------------------------------------------------------------------------------------------
// Sessions

export interface Session {
  candles: Candle[];
  /** regime in force at each candle's last tick (for the optional shading) */
  regimes: Regime[];
  /** every tick price, in order (length = packets) */
  prices: number[];
  /** number of regime switches during the session */
  shifts: number;
}

export interface SessionOptions {
  packets?: number;
  rate?: number;
  timeframe?: Timeframe['id'];
  packetMs?: number;
  startTime?: number;
  /** packets run (and discarded) before recording, so the session starts in a random regime, like joining the tape mid-stream */
  burnIn?: number;
}

/** Runs `packets` packets through a fresh TapeEngine and buckets them into wall-clock candles. */
export function generateSession(next: PacketSource, opts: SessionOptions = {}): Session {
  const packets = opts.packets ?? SESSION_PACKETS;
  const packetMs = opts.packetMs ?? DEMO_PACKET_MS;
  const t0 = opts.startTime ?? 0;
  const tf = TIMEFRAMES.find(t => t.id === (opts.timeframe ?? '1s'))!;
  const engine = new TapeEngine({ rate: opts.rate ?? 5 });
  const series = new CandleSeries(tf, Math.max(3000, packets));
  const regimes: Regime[] = [];
  const prices: number[] = [];
  let shifts = 0;
  for (let i = 0; i < (opts.burnIn ?? 0); i++) engine.step(next(), t0);
  engine.price = START_PRICE;
  for (let i = 0; i < packets; i++) {
    const tick = engine.step(next(), t0 + i * packetMs);
    if (tick.shift) shifts++;
    prices.push(tick.price);
    const { isNew } = series.add(tick);
    if (isNew) regimes.push(tick.regime);
    else regimes[regimes.length - 1] = tick.regime;
  }
  return { candles: series.bars.slice(), regimes, prices, shifts };
}

// ---------------------------------------------------------------------------------------------------------------
// Statistics helpers

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation (n - 1). */
export function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

/** Linear-interpolated quantile, q in [0,1]. */
export function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = Math.min(1, Math.max(0, q)) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export const median = (xs: readonly number[]): number => quantile(xs, 0.5);

/** Fraction of values strictly greater than zero. */
export function winRate(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  let w = 0;
  for (const x of xs) if (x > 0) w++;
  return w / xs.length;
}

/** Normal-approximation 95% interval for a proportion (half-width), e.g. win rate +/- this. */
export function proportionMargin95(p: number, n: number): number {
  return n > 0 ? 1.96 * Math.sqrt((p * (1 - p)) / n) : NaN;
}

export interface Bin {
  lo: number;
  hi: number;
  count: number;
}

/** Equal-width histogram. Values equal to `max` land in the last bin. */
export function histogram(xs: readonly number[], bins: number, range?: { min: number; max: number }): Bin[] {
  const min = range?.min ?? Math.min(...xs);
  const max = range?.max ?? Math.max(...xs);
  const width = (max - min) / bins || 1;
  const out: Bin[] = Array.from({ length: bins }, (_, i) => ({ lo: min + i * width, hi: min + (i + 1) * width, count: 0 }));
  for (const x of xs) {
    if (x < min || x > max) continue;
    const i = Math.min(bins - 1, Math.floor((x - min) / width));
    out[i].count++;
  }
  return out;
}

/** Exponential moving average with the usual alpha = 2 / (period + 1), seeded with the first value. */
export function ema(values: readonly number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** Least-squares line y = a + b x over x = 0..n-1, with R^2 and the slope's t-statistic. */
export function linearRegression(ys: readonly number[]): { intercept: number; slope: number; r2: number; tSlope: number } {
  const n = ys.length;
  const mx = (n - 1) / 2;
  const my = mean(ys);
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (i - mx) * (i - mx);
    sxy += (i - mx) * (ys[i] - my);
    syy += (ys[i] - my) * (ys[i] - my);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  const sse = Math.max(0, syy - slope * sxy);
  const r2 = syy > 0 ? 1 - sse / syy : 0;
  const se = n > 2 && sxx > 0 ? Math.sqrt(sse / (n - 2) / sxx) : Infinity;
  return { intercept, slope, r2, tSlope: se > 0 ? slope / se : 0 };
}

// ---------------------------------------------------------------------------------------------------------------
// Pivots, trendlines and "patterns"

export interface Pivot {
  index: number;
  price: number;
  kind: 'high' | 'low';
}

/** A swing high/low: the bar's high (low) is the extreme of the `span` bars either side. */
export function findPivots(candles: readonly Candle[], span = 3): Pivot[] {
  const out: Pivot[] = [];
  for (let i = span; i < candles.length - span; i++) {
    let isHigh = true, isLow = true;
    // Ties are common (a candle opens at the previous close), so the first of equal extremes is the pivot:
    // bars on the left must be strictly beyond, bars on the right may equal it.
    for (let j = i - span; j <= i + span; j++) {
      if (j === i) continue;
      if (j < i ? candles[j].high >= candles[i].high : candles[j].high > candles[i].high) isHigh = false;
      if (j < i ? candles[j].low <= candles[i].low : candles[j].low < candles[i].low) isLow = false;
    }
    if (isHigh) out.push({ index: i, price: candles[i].high, kind: 'high' });
    if (isLow) out.push({ index: i, price: candles[i].low, kind: 'low' });
  }
  return out;
}

export interface Trendline {
  kind: 'support' | 'resistance';
  /** the two pivots that define the line */
  from: Pivot;
  to: Pivot;
  slope: number;
  /** price on the line at candle index i */
  at: (i: number) => number;
  /** pivots (of the same kind) within tolerance of the line, including the two anchors */
  touches: number;
  /** bounces after the second anchor, before the first break (see followThrough) */
  respected: number;
  /** first candle index after `to` where the close crossed the line, or null */
  breakIndex: number | null;
  /** "touching" distance in price units (a fraction of the fitted chart's height) */
  tolerance: number;
}

/** Highest high minus lowest low. All pattern thresholds are fractions of this, so they work at any price scale. */
export function chartHeight(candles: readonly Candle[]): number {
  let hi = -Infinity, lo = Infinity;
  for (const c of candles) { if (c.high > hi) hi = c.high; if (c.low < lo) lo = c.low; }
  return candles.length ? hi - lo : 0;
}

/** Default "touch" tolerance: 2% of the chart's height. */
export const TOUCH_FRACTION = 0.02;

/**
 * The "best" support (resistance) line the way a chartist draws one: a line through two swing lows (highs)
 * that no candle body closes through between them, chosen to touch the most other pivots.
 * `touchFraction` is how close (as a fraction of the chart's height) counts as "touching".
 */
export function fitTrendline(candles: readonly Candle[], kind: 'support' | 'resistance', opts: { span?: number; touchFraction?: number } = {}): Trendline | null {
  const span = opts.span ?? 3;
  const tol = (opts.touchFraction ?? TOUCH_FRACTION) * chartHeight(candles);
  const want = kind === 'support' ? 'low' : 'high';
  const pivots = findPivots(candles, span).filter(p => p.kind === want);
  let best: Trendline | null = null;
  let bestScore = -Infinity;
  for (let a = 0; a < pivots.length; a++) {
    for (let b = a + 1; b < pivots.length; b++) {
      const p = pivots[a], q = pivots[b];
      if (q.index - p.index < 2 * span) continue;
      const slope = (q.price - p.price) / (q.index - p.index);
      const at = (i: number): number => p.price + slope * (i - p.index);
      // no close on the wrong side between the anchors (that is what makes it look "valid")
      let valid = true;
      for (let i = p.index; i <= q.index && valid; i++) {
        const c = candles[i].close;
        if (kind === 'support' ? c < at(i) : c > at(i)) valid = false;
      }
      if (!valid) continue;
      let touches = 0;
      for (const piv of pivots) if (Math.abs(piv.price - at(piv.index)) <= tol) touches++;
      const score = touches * 1000 + (q.index - p.index); // most touches first, then the longest line
      if (score > bestScore) {
        bestScore = score;
        best = { kind, from: p, to: q, slope, at, touches, respected: 0, breakIndex: null, tolerance: tol };
      }
    }
  }
  if (best) scoreRespect(candles, best);
  return best;
}

export interface FollowThrough {
  /** candles before the first break whose wick reached the line (within tolerance) but closed on the right side */
  bounces: number;
  /** first candle index (>= start) whose close crossed to the wrong side, or null if it never did */
  breakIndex: number | null;
  /** candles examined */
  examined: number;
}

/** What price did relative to a line from candle `start` on: bounces until the first break, then stop. */
export function followThrough(candles: readonly Candle[], line: Pick<Trendline, 'kind' | 'at' | 'tolerance'>, start: number): FollowThrough {
  const tolerance = line.tolerance;
  let bounces = 0, examined = 0;
  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const lv = line.at(i);
    if (!Number.isFinite(lv)) break;
    examined++;
    if (line.kind === 'support' ? c.close < lv : c.close > lv) return { bounces, breakIndex: i, examined };
    const wick = line.kind === 'support' ? c.low : c.high;
    if (Math.abs(wick - lv) <= tolerance || (line.kind === 'support' ? wick < lv : wick > lv)) bounces++;
  }
  return { bounces, breakIndex: null, examined };
}

function scoreRespect(candles: readonly Candle[], line: Trendline): void {
  const f = followThrough(candles, line, line.to.index + 1);
  line.respected = f.bounces;
  line.breakIndex = f.breakIndex;
}

/** How a chartist would label the chart. Purely descriptive: it says what the shape LOOKS like. */
export interface Look {
  uptrend: boolean;
  downtrend: boolean;
  doubleTop: boolean;
  /** t-statistic of the regression slope of closes ("how straight the trend looks") */
  trendT: number;
  r2: number;
}

export function describeLook(candles: readonly Candle[]): Look {
  const closes = candles.map(c => c.close);
  const lr = linearRegression(closes.map(Math.log));
  const trendy = lr.r2 > 0.5 && Math.abs(lr.tSlope) > 3;
  return { uptrend: trendy && lr.slope > 0, downtrend: trendy && lr.slope < 0, doubleTop: hasDoubleTop(candles), trendT: lr.tSlope, r2: lr.r2 };
}

/**
 * Double top: two swing highs within 5% of the chart's height of each other, at least 8 bars apart, both in the
 * top quarter of the chart, with a dip of at least 25% of the chart's height between them.
 */
export function hasDoubleTop(candles: readonly Candle[], span = 3): boolean {
  if (candles.length < 10) return false;
  let hi = -Infinity, lo = Infinity;
  for (const c of candles) { if (c.high > hi) hi = c.high; if (c.low < lo) lo = c.low; }
  const highs = findPivots(candles, span).filter(p => p.kind === 'high' && p.price >= lo + 0.75 * (hi - lo));
  for (let a = 0; a < highs.length; a++) {
    for (let b = a + 1; b < highs.length; b++) {
      const p = highs[a], q = highs[b];
      if (q.index - p.index < 8) continue;
      if (Math.abs(p.price - q.price) > 0.05 * (hi - lo)) continue;
      let trough = Infinity;
      for (let i = p.index + 1; i < q.index; i++) trough = Math.min(trough, candles[i].low);
      if (Math.min(p.price, q.price) - trough >= 0.25 * (hi - lo)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Backtests through the shared MT5 account maths

export type StrategyId = 'ema' | 'breakout';

export interface StrategyInfo {
  id: StrategyId;
  name: string;
  rule: string;
}

export const STRATEGIES: Record<StrategyId, StrategyInfo> = {
  ema: { id: 'ema', name: 'EMA 20/50 crossover', rule: 'Buy when the 20-candle average crosses above the 50-candle average; sell when it crosses below. Always in the market.' },
  breakout: { id: 'breakout', name: '20-candle breakout', rule: 'Buy when a candle closes above the highest high of the last 20 candles; sell when it closes below the lowest low. Always in the market after the first signal.' },
};

/** Desired position after candle i closes (+1 long, -1 short, 0 flat), or null for "no change". */
function signals(candles: readonly Candle[], id: StrategyId): (1 | -1 | null)[] {
  const closes = candles.map(c => c.close);
  const out: (1 | -1 | null)[] = new Array(candles.length).fill(null);
  if (id === 'ema') {
    const fast = ema(closes, 20), slow = ema(closes, 50);
    for (let i = 50; i < candles.length; i++) {
      const prev = Math.sign(fast[i - 1] - slow[i - 1]), now = Math.sign(fast[i] - slow[i]);
      if (now !== 0 && now !== prev) out[i] = now as 1 | -1;
    }
  } else {
    const N = 20;
    for (let i = N; i < candles.length; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - N; j < i; j++) { if (candles[j].high > hh) hh = candles[j].high; if (candles[j].low < ll) ll = candles[j].low; }
      if (closes[i] > hh) out[i] = 1;
      else if (closes[i] < ll) out[i] = -1;
    }
  }
  return out;
}

export interface BacktestResult {
  /** net P&L in USD after closing everything at the last price */
  pnl: number;
  /** pnl as a percentage of the starting balance */
  returnPct: number;
  trades: number;
  winningTrades: number;
  /** equity after each candle, for drawing the equity curve */
  equity: number[];
}

/**
 * Trades one session with the real Account class (spread from the config, 0 for now). Orders are placed at
 * the close of the signal candle, which is also where the next candle opens, so there is no look-ahead.
 * With `coin`, the trade TIMES stay the same but each direction is a coin flip: the "no skill" baseline.
 */
export function backtest(candles: readonly Candle[], id: StrategyId, cfg: AccountConfig, coin?: PacketSource, lots = 1): BacktestResult {
  const acct = new Account(cfg);
  const sig = signals(candles, id);
  const equity: number[] = [];
  let trades = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    let want = sig[i];
    if (want !== null && coin) want = coin().c < 0x80000000 ? 1 : -1;
    if (want !== null) {
      const side: Side = want === 1 ? 'buy' : 'sell';
      const open = acct.positions[0];
      if (!open || open.side !== side) {
        if (open) acct.close(open.ticket, c.close, c.timestamp);
        const r = acct.open(side, lots, { sl: null, tp: null }, c.close, c.timestamp);
        if (r.ok) trades++;
      }
    }
    acct.onPrice(c.close, c.timestamp);
    equity.push(acct.snapshot(c.close).equity);
  }
  const last = candles[candles.length - 1];
  for (const p of [...acct.positions]) acct.close(p.ticket, last.close, last.timestamp);
  const pnl = acct.balance - cfg.start_balance;
  const winningTrades = acct.history.filter(d => d.pnl > 0).length;
  if (equity.length) equity[equity.length - 1] = acct.balance;
  return { pnl, returnPct: (pnl / cfg.start_balance) * 100, trades, winningTrades, equity };
}

export interface ArmStats {
  /** net P&L of each session in USD */
  pnls: number[];
  /** fraction of sessions that ended with a profit */
  sessionWinRate: number;
  /** fraction of all individual trades that made money */
  tradeWinRate: number;
  totalTrades: number;
  meanPnl: number;
  medianPnl: number;
}

export interface ManyResult {
  strategy: StrategyId;
  sessions: number;
  rule: ArmStats;
  /** same sessions, same trade times, coin-flip directions */
  coin: ArmStats;
  /** Welch t-statistic of (rule mean - coin mean); |t| > 2 means the gap is unlikely to be luck */
  edgeT: number;
  best: { index: number; pnl: number; session: Session; result: BacktestResult };
  worst: { index: number; pnl: number };
}

/** Incremental accumulator, so the page can run 1,000 sessions in small slices without freezing. */
export interface ManyAccumulator {
  strategy: StrategyId;
  rule: { pnls: number[]; trades: number; winningTrades: number };
  coin: { pnls: number[]; trades: number; winningTrades: number };
  best: ManyResult['best'] | null;
  worst: ManyResult['worst'] | null;
}

export function startMany(id: StrategyId): ManyAccumulator {
  return { strategy: id, rule: { pnls: [], trades: 0, winningTrades: 0 }, coin: { pnls: [], trades: 0, winningTrades: 0 }, best: null, worst: null };
}

/** One fresh session from `next`; the coin baseline draws its flips from the same packet source. */
export function stepMany(acc: ManyAccumulator, next: PacketSource, cfg: AccountConfig, opts: SessionOptions = {}): BacktestResult {
  const session = generateSession(next, { packets: BACKTEST_PACKETS, ...opts });
  const result = backtest(session.candles, acc.strategy, cfg, undefined, BACKTEST_LOTS);
  const coin = backtest(session.candles, acc.strategy, cfg, next, BACKTEST_LOTS);
  const index = acc.rule.pnls.length;
  for (const [arm, r] of [[acc.rule, result], [acc.coin, coin]] as const) {
    arm.pnls.push(r.pnl);
    arm.trades += r.trades;
    arm.winningTrades += r.winningTrades;
  }
  if (!acc.best || result.pnl > acc.best.pnl) acc.best = { index, pnl: result.pnl, session, result };
  if (!acc.worst || result.pnl < acc.worst.pnl) acc.worst = { index, pnl: result.pnl };
  return result;
}

function armStats(a: ManyAccumulator['rule']): ArmStats {
  const r = a.pnls;
  return {
    pnls: r, sessionWinRate: winRate(r), tradeWinRate: a.trades ? a.winningTrades / a.trades : NaN,
    totalTrades: a.trades, meanPnl: mean(r), medianPnl: median(r),
  };
}

/** Welch's t for the difference of two means. */
export function welchT(a: readonly number[], b: readonly number[]): number {
  const va = stdev(a) ** 2 / a.length, vb = stdev(b) ** 2 / b.length;
  const se = Math.sqrt(va + vb);
  return se > 0 ? (mean(a) - mean(b)) / se : 0;
}

export function finishMany(acc: ManyAccumulator): ManyResult {
  return {
    strategy: acc.strategy, sessions: acc.rule.pnls.length,
    rule: armStats(acc.rule), coin: armStats(acc.coin),
    edgeT: welchT(acc.rule.pnls, acc.coin.pnls),
    best: acc.best!, worst: acc.worst!,
  };
}

/** Runs the strategy (and its coin-flip twin) on `n` fresh sessions. */
export function backtestMany(next: PacketSource, id: StrategyId, cfg: AccountConfig, n: number, opts: SessionOptions = {}): ManyResult {
  const acc = startMany(id);
  for (let i = 0; i < n; i++) stepMany(acc, next, cfg, opts);
  return finishMany(acc);
}
