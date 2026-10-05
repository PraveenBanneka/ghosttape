// Tests for the learn page's pure computation (src/learn/analysis.ts). All randomness is seededPackets, so
// every number below is reproducible.
import { describe, expect, it } from 'vitest';
import { seededPackets } from '../src/model/random';
import type { Candle } from '../src/model/aggregator';
import type { AccountConfig } from '../src/model/account';
import { LIMITS } from '../src/config';
import { START_PRICE } from '../src/model/engine';
import {
  backtest, backtestMany, describeLook, ema, findPivots, fitTrendline, followThrough, generateSession, hasDoubleTop, histogram,
  linearRegression, mean, median, proportionMargin95, quantile, SESSION_PACKETS, stdev, welchT, winRate,
} from '../src/learn/analysis';

const CFG: AccountConfig = { ...LIMITS.trading, spread: 0 };

/** Candles from a list of closes; each candle opens at the previous close, wicks 0.2 beyond the body. */
function candlesFrom(closes: number[]): Candle[] {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    return { timestamp: i * 1000, open, close, high: Math.max(open, close) + 0.2, low: Math.min(open, close) - 0.2, volume: 0, ticks: 1 };
  });
}

describe('statistics helpers', () => {
  it('mean, sample stdev, median and quantiles', () => {
    const xs = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(mean(xs)).toBe(5);
    expect(stdev(xs)).toBeCloseTo(Math.sqrt(32 / 7), 12);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(quantile([0, 10], 0.25)).toBe(2.5);
    expect(quantile(xs, 0)).toBe(2);
    expect(quantile(xs, 1)).toBe(9);
    expect(Number.isNaN(mean([]))).toBe(true);
  });
  it('win rate counts strictly positive values; zero is not a win', () => {
    expect(winRate([1, -1, 0, 2])).toBe(0.5);
    expect(proportionMargin95(0.5, 100)).toBeCloseTo(0.098, 3);
  });
  it('histogram bins every in-range value exactly once, max lands in the last bin', () => {
    const h = histogram([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5, { min: 0, max: 10 });
    expect(h.map(b => b.count)).toEqual([2, 2, 2, 2, 3]);
    expect(h[0].lo).toBe(0);
    expect(h[4].hi).toBe(10);
    expect(histogram([-5, 50], 5, { min: 0, max: 10 }).reduce((s, b) => s + b.count, 0)).toBe(0);
  });
  it('EMA uses alpha = 2/(n+1) seeded with the first value', () => {
    const e = ema([10, 20, 30], 3); // alpha 0.5
    expect(e).toEqual([10, 15, 22.5]);
  });
  it('linear regression recovers an exact line with R^2 = 1', () => {
    const lr = linearRegression([1, 3, 5, 7, 9]);
    expect(lr.slope).toBeCloseTo(2, 12);
    expect(lr.intercept).toBeCloseTo(1, 12);
    expect(lr.r2).toBeCloseTo(1, 12);
  });
  it('Welch t is positive when the first sample is higher, about 0 for identical samples', () => {
    expect(welchT([5, 6, 7, 8], [1, 2, 3, 4])).toBeGreaterThan(3);
    expect(welchT([1, 2, 3], [1, 2, 3])).toBe(0);
  });
});

describe('sessions come from the shared engine', () => {
  it('the same seed replays the same session exactly', () => {
    const a = generateSession(seededPackets(42));
    const b = generateSession(seededPackets(42));
    expect(a.prices).toEqual(b.prices);
    expect(a.candles).toEqual(b.candles);
    expect(generateSession(seededPackets(43)).prices).not.toEqual(a.prices);
  });
  it('1,000 packets at 160 ms make 160 one-second candles starting at the start price', () => {
    const s = generateSession(seededPackets(1));
    expect(s.prices).toHaveLength(SESSION_PACKETS);
    expect(s.candles).toHaveLength(160);
    expect(s.regimes).toHaveLength(160);
    expect(s.candles[0].open).toBe(START_PRICE);
    expect(s.candles[159].close).toBe(s.prices[999]);
    for (const c of s.candles) {
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
    }
  });
});

describe('pivots, trendlines and pattern looks', () => {
  it('finds the obvious swing high and low', () => {
    const c = candlesFrom([10, 11, 12, 13, 12, 11, 10, 9, 10, 11, 12]);
    const piv = findPivots(c, 2);
    expect(piv).toContainEqual({ index: 3, price: 13.2, kind: 'high' });
    expect(piv).toContainEqual({ index: 7, price: 8.8, kind: 'low' });
  });
  it('every fitted line touches at least 2 pivots and no close crosses it between its anchors', () => {
    const next = seededPackets(7);
    let fitted = 0;
    for (let n = 0; n < 40; n++) {
      const { candles } = generateSession(next);
      for (const kind of ['support', 'resistance'] as const) {
        const line = fitTrendline(candles, kind);
        if (!line) continue;
        fitted++;
        expect(line.touches).toBeGreaterThanOrEqual(2);
        expect(line.from.kind).toBe(kind === 'support' ? 'low' : 'high');
        expect(line.at(line.from.index)).toBeCloseTo(line.from.price, 9);
        expect(line.at(line.to.index)).toBeCloseTo(line.to.price, 9);
        for (let i = line.from.index; i <= line.to.index; i++) {
          if (kind === 'support') expect(candles[i].close).toBeGreaterThanOrEqual(line.at(i) - 1e-9);
          else expect(candles[i].close).toBeLessThanOrEqual(line.at(i) + 1e-9);
        }
        expect(line.respected).toBeLessThanOrEqual(candles.length - line.to.index - 1);
        if (line.breakIndex !== null) expect(line.breakIndex).toBeGreaterThan(line.to.index);
      }
    }
    expect(fitted).toBeGreaterThanOrEqual(76); // a "valid" line can be drawn on almost every noise chart
  });
  it('followThrough counts bounces until the first close through the line', () => {
    const flat = { kind: 'support' as const, at: () => 100, tolerance: 0.4 };
    // lows: 100.1 (bounce), 101 (no touch), 99.9 (poke + close above = bounce), then close 99 (break), then a bounce that must not count
    const c: Candle[] = [
      { timestamp: 0, open: 101, close: 101, high: 101.5, low: 100.1, volume: 0, ticks: 1 },
      { timestamp: 1, open: 101, close: 102, high: 102.5, low: 101, volume: 0, ticks: 1 },
      { timestamp: 2, open: 102, close: 100.5, high: 102, low: 99.9, volume: 0, ticks: 1 },
      { timestamp: 3, open: 100.5, close: 99, high: 100.5, low: 98.8, volume: 0, ticks: 1 },
      { timestamp: 4, open: 99, close: 101, high: 101, low: 100, volume: 0, ticks: 1 },
    ];
    expect(followThrough(c, flat, 0)).toEqual({ bounces: 2, breakIndex: 3, examined: 4 });
    expect(followThrough(c.slice(0, 3), flat, 0)).toEqual({ bounces: 2, breakIndex: null, examined: 3 });
  });
  it('detects an M-shaped double top and not a straight climb', () => {
    const m = [100, 102, 104, 106, 108, 110, 108, 106, 104, 102, 100, 102, 104, 106, 108, 110, 108, 106, 104, 102];
    expect(hasDoubleTop(candlesFrom(m))).toBe(true);
    const climb = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(hasDoubleTop(candlesFrom(climb))).toBe(false);
    const look = describeLook(candlesFrom(climb));
    expect(look.uptrend).toBe(true);
    expect(look.downtrend).toBe(false);
  });
  it('noise produces "patterns" all the time', () => {
    const next = seededPackets(9);
    let trend = 0, dtop = 0;
    for (let n = 0; n < 300; n++) {
      const look = describeLook(generateSession(next).candles);
      if (look.uptrend || look.downtrend) trend++;
      if (look.doubleTop) dtop++;
    }
    expect(trend / 300).toBeGreaterThan(0.2);
    expect(dtop / 300).toBeGreaterThan(0.2);
  });
});

describe('backtests use the shared Account maths', () => {
  it('no signal, no trade, no P&L', () => {
    const flat = candlesFrom(Array.from({ length: 80 }, () => 100));
    const r = backtest(flat, 'breakout', CFG);
    expect(r.trades).toBe(0);
    expect(r.pnl).toBe(0);
    expect(r.equity).toHaveLength(80);
  });
  it('a breakout long on a steady climb earns (close - entry) x 100 per lot', () => {
    const closes = [...Array.from({ length: 25 }, (_, i) => 100 + (i % 2) * 0.1), 101, 102, 103];
    const r = backtest(candlesFrom(closes), 'breakout', CFG);
    expect(r.trades).toBe(1);
    expect(r.pnl).toBeCloseTo((103 - 101) * 100, 9);
    expect(r.equity[r.equity.length - 1]).toBeCloseTo(CFG.start_balance + r.pnl, 9);
  });
  it('is deterministic for a seed', () => {
    const a = backtestMany(seededPackets(5), 'ema', CFG, 20);
    const b = backtestMany(seededPackets(5), 'ema', CFG, 20);
    expect(a.rule.pnls).toEqual(b.rule.pnls);
    expect(a.coin.pnls).toEqual(b.coin.pnls);
  });
  it('the coin-flip trader wins about 50% of trades and sessions (spread 0)', () => {
    const r = backtestMany(seededPackets(2026), 'breakout', CFG, 600);
    expect(r.sessions).toBe(600);
    expect(Math.abs(r.coin.tradeWinRate - 0.5)).toBeLessThan(0.03);
    expect(Math.abs(r.coin.sessionWinRate - 0.5)).toBeLessThan(0.06);
    expect(r.best.pnl).toBe(Math.max(...r.rule.pnls));
  }, 60_000);
  it('neither rule beats the coin: about 50% of sessions profitable, no significant edge', () => {
    // Pins the current market-clock model (engine DEFAULT_TIME_SCALE). Under the prototype scale (k = 1) the
    // regime drift was large enough for trend rules to win ~61-67% of sessions (t = 5-12); if the model ever
    // goes back to that, this test fails and the page's verdict text switches to its "beat the coin" branch.
    for (const [id, seedNo] of [['ema', 11], ['breakout', 12]] as const) {
      const r = backtestMany(seededPackets(seedNo), id, CFG, 600);
      expect(Math.abs(r.rule.sessionWinRate - 0.5)).toBeLessThan(0.06);
      expect(Math.abs(r.edgeT)).toBeLessThan(3);
    }
  }, 60_000);
});
