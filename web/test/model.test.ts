import { describe, expect, it } from 'vitest';
import { gaussian, seededPackets, TWO32, u1, u2, uc } from '../src/model/random';
import { REGIMES, rollRegime, switchProbability } from '../src/model/regime';
import { DEFAULT_TIME_SCALE, PRICE_DECIMALS, SINGLE_REGIME, STEPS_PER_ROLL, TapeEngine } from '../src/model/engine';
import { CandleSeries, MultiSeries, syntheticVolume, TIMEFRAMES } from '../src/model/aggregator';
import { parseLine, SeqTracker } from '../src/model/packet';
import { LIMITS, parseJsonc } from '../src/config';

describe('uniform + Box-Muller mapping (identical to the prototype)', () => {
  it('u1/uc never hit 0 or 1, so log() is safe', () => {
    expect(u1(0)).toBeGreaterThan(0);
    expect(u1(TWO32 - 1)).toBeLessThan(1);
    expect(uc(0)).toBe(1 / (TWO32 + 1));
    expect(u2(0)).toBe(0);
    expect(u2(TWO32 - 1)).toBeLessThan(1);
  });
  it('matches the prototype formula exactly', () => {
    const a = 0x5d58021f, b = 0x1dd112cd;
    const proto = Math.sqrt(-2 * Math.log((a + 1) / (TWO32 + 1))) * Math.cos(2 * Math.PI * (b / TWO32));
    expect(gaussian(a, b)).toBe(proto);
    expect(Number.isFinite(gaussian(0, 0))).toBe(true);
  });
  it('produces a standard normal over many seeded draws', () => {
    const next = seededPackets(42);
    let s = 0, s2 = 0;
    const n = 200_000;
    for (let i = 0; i < n; i++) { const p = next(); const z = gaussian(p.a, p.b); s += z; s2 += z * z; }
    const mean = s / n, variance = s2 / n - mean * mean;
    expect(Math.abs(mean)).toBeLessThan(0.01);
    expect(Math.abs(variance - 1)).toBeLessThan(0.02);
  });
});

describe('regime switching (SPEC acceptance)', () => {
  it('rate 15% clamps expansion->recession to 0.15; rate 0% hits the 0.01 floor', () => {
    expect(switchProbability('expansion', 15)).toBeCloseTo(0.15, 12);
    expect(switchProbability('expansion', 0)).toBe(0.01);
    expect(switchProbability('expansion', 5)).toBeCloseTo(0.03, 12);
  });
  it('recession->expansion: 0.05 at 5%, floor 0.02 at high rates, ceiling 0.5', () => {
    expect(switchProbability('recession', 5)).toBeCloseTo(0.05, 12);
    expect(switchProbability('recession', 15)).toBe(0.02);
    expect(switchProbability('recession', 0)).toBeCloseTo(0.1, 12);
  });
  it('rolls when u < p', () => {
    expect(rollRegime('expansion', 5, 0.029)).toBe('recession');
    expect(rollRegime('expansion', 5, 0.031)).toBe('expansion');
  });
});

describe('TapeEngine', () => {
  it('same seed gives the same tape (deterministic for tests)', () => {
    const run = () => { const e = new TapeEngine(); const next = seededPackets(7); return Array.from({ length: 500 }, (_, i) => e.step(next(), i * 160).price); };
    expect(run()).toEqual(run());
  });
  it('one packet = one GBM step with the prototype formula (k = 1, start 100)', () => {
    const e = new TapeEngine({ startPrice: 100, timeScale: 1, regimeSwitching: true });
    const p = { seq: 0, a: 123456789, b: 987654321, c: 5 };
    const { mu, sigma } = REGIMES.expansion;
    const expected = 100 * Math.exp(mu - (sigma * sigma) / 2 + sigma * gaussian(p.a, p.b));
    expect(e.step(p, 0).price).toBe(expected);
  });
  it('rolls the regime only on every 8th packet, using that packet\'s c word', () => {
    const e = new TapeEngine({ rate: 15, regimeSwitching: true });
    const shifting = { seq: 0, a: 1, b: 1, c: 0 }; // uc(0) is tiny -> always switches when rolled
    for (let i = 1; i < STEPS_PER_ROLL; i++) expect(e.step({ ...shifting, seq: i }, i).shift).toBeNull();
    const t = e.step({ ...shifting, seq: 8 }, 8);
    expect(t.shift).toEqual({ from: 'expansion', to: 'recession', rate: 15 });
    expect(e.regime).toBe('recession');
    expect(t.index).toBe(8);
  });
  it('state round-trips', () => {
    const e = new TapeEngine();
    const next = seededPackets(3);
    for (let i = 0; i < 13; i++) e.step(next(), i);
    const f = TapeEngine.from(e.state());
    expect(f.state()).toEqual(e.state());
    const p = next();
    expect(f.step(p, 99)).toEqual(e.step(p, 99));
  });
});

describe('wall-clock candles', () => {
  const tick = (time: number, prevPrice: number, price: number) => ({ time, prevPrice, price, regime: 'expansion' as const, shift: null, seq: 0, index: 0 });
  it('aggregates ticks in one 1s bucket into one bar with correct OHLC', () => {
    const s = new CandleSeries(TIMEFRAMES[0]);
    const prices = [100, 101, 99, 100.5, 100.2, 99.5, 100.8, 100.1];
    let prev = 100;
    prices.slice(1).forEach((p, i) => { s.add(tick(5000 + i * 100, prev, p)); prev = p; });
    expect(s.bars).toHaveLength(1);
    const b = s.bars[0];
    expect([b.timestamp, b.open, b.high, b.low, b.close, b.ticks]).toEqual([5000, 100, 101, 99, 100.1, 7]);
    expect(b.volume).toBe(syntheticVolume(7, 100, 100.1));
  });
  it('opens a new bar per bucket, open = previous close, and skips empty buckets', () => {
    const s = new CandleSeries(TIMEFRAMES[1]); // 10s
    s.add(tick(1000, 100, 101));
    s.add(tick(12000, 101, 102));
    s.add(tick(45000, 102, 103)); // 20-40s had no entropy -> no bars there
    expect(s.bars.map(b => b.timestamp)).toEqual([0, 10000, 40000]);
    expect(s.bars[1].open).toBe(101);
  });
  it('feeds all five timeframes from one stream', () => {
    const m = new MultiSeries();
    const e = new TapeEngine();
    const next = seededPackets(11);
    for (let i = 0; i < 2000; i++) m.add(e.step(next(), i * 160)); // 320 s of ticks
    expect(TIMEFRAMES.map(tf => m.series[tf.id].bars.length)).toEqual([320, 32, 11, 6, 2]);
    expect(m.series['5m'].last()!.close).toBe(e.price);
    expect(m.series['1s'].bars.reduce((n, b) => n + b.ticks, 0)).toBe(2000);
  });
});

describe('packet parser', () => {
  it('parses GT1 packets, status lines and signed packets', () => {
    expect(parseLine('GT1,155,b80177cf,b29010dd,0687fd2e\r')).toEqual({ kind: 'packet', mac: null, packet: { seq: 155, a: 0xb80177cf, b: 0xb29010dd, c: 0x0687fd2e } });
    expect(parseLine('GT1,HELLO')).toEqual({ kind: 'hello' });
    expect(parseLine('GT1,INFO,radio=on,ps=none,aps=5,up=153')).toEqual({ kind: 'info', fields: { radio: 'on', ps: 'none', aps: '5', up: '153' } });
    expect(parseLine('GT1,ERR,radio_off,scan_failed')).toEqual({ kind: 'err', reason: 'radio_off', detail: 'scan_failed' });
    expect(parseLine('GT1S,7,00000001,00000002,00000003,DEADBEEF')).toMatchObject({ kind: 'packet', mac: 'deadbeef', packet: { seq: 7, a: 1, b: 2, c: 3 } });
  });
  it('ignores malformed lines instead of inventing values', () => {
    for (const bad of ['', 'GT1,12,zzzzzzzz,00000000,00000000', 'GT1,12,0000000,00000000,00000000', 'GT1,-1,00000000,00000000,00000000',
      'mode:DIO, clock div:1', 'GT1,1,00000000,00000000', 'GT1S,1,00000000,00000000,00000000,xyz']) {
      expect(parseLine(bad)).toEqual({ kind: 'ignore' });
    }
  });
  it('counts gaps and restarts', () => {
    const t = new SeqTracker();
    expect([5, 6, 9, 10, 0].map(s => t.observe(s))).toEqual(['first', 'ok', 'gap', 'ok', 'restart']);
    expect([t.gaps, t.restarts]).toEqual([2, 1]);
  });
});

describe('owner limits (pinned defaults)', () => {
  it('parses limits.jsonc and keeps the safe defaults', () => {
    expect(LIMITS.online_enabled).toBe(false);
    expect(LIMITS.trading.spread).toBe(0);
    expect(LIMITS.trading.leverage).toBe(100);
    expect(LIMITS.trading.start_balance).toBe(10000);
    expect(parseJsonc('{\n // c\n "a": 1, // x\n "b": 2\n}')).toEqual({ a: 1, b: 2 });
  });
});

describe('market-clock time scale (owner chose the GBP/JPY-like preset)', () => {
  it('pins the GJ defaults: start 190.000, 3 decimals, k = 1,400,000', () => {
    const e = new TapeEngine();
    expect([e.price, e.timeScale, PRICE_DECIMALS, DEFAULT_TIME_SCALE]).toEqual([190, 1_400_000, 3, 1_400_000]);
  });
  it('GJ preset: ~0.2% hourly volatility, no runaway drift', () => {
    const e = new TapeEngine();
    const next = seededPackets(5);
    const h: number[] = [];
    let ph = e.price;
    for (let i = 1; i <= 22500 * 12; i++) { e.step(next(), 0); if (i % 22500 === 0) { h.push(Math.log(e.price / ph)); ph = e.price; } }
    const sd = Math.sqrt(h.reduce((s, x) => s + x * x, 0) / h.length) * 100;
    expect(sd).toBeGreaterThan(0.08);
    expect(sd).toBeLessThan(0.45);
    expect(Math.abs(Math.log(e.price / 190))).toBeLessThan(0.05);
  });
  it('k = 1 is the prototype formula; k scales drift by 1/k and volatility by 1/sqrt(k)', () => {
    const p = { seq: 0, a: 123456789, b: 987654321, c: 5 };
    const z = gaussian(p.a, p.b);
    const { mu, sigma } = REGIMES.expansion;
    expect(new TapeEngine({ startPrice: 100, timeScale: 1, regimeSwitching: true }).step(p, 0).price).toBe(100 * Math.exp(mu - (sigma * sigma) / 2 + sigma * z));
    const k = 234, m = mu / k, s = sigma / Math.sqrt(k);
    expect(new TapeEngine({ startPrice: 100, timeScale: k, regimeSwitching: true }).step(p, 0).price).toBeCloseTo(100 * Math.exp(m - (s * s) / 2 + s * z), 12);
  });
});

describe('no rates or macro simulation by default (Praveen, 2026-10-05)', () => {
  it('default engine: no regime switching, no drift, never shifts, c word unused', () => {
    const e = new TapeEngine();
    expect(e.regimeSwitching).toBe(false);
    expect(SINGLE_REGIME.mu).toBe(0);
    const p = { seq: 0, a: 123456789, b: 987654321, c: 0 }; // c = 0 would always flip a regime if rolled
    const s = SINGLE_REGIME.sigma / Math.sqrt(DEFAULT_TIME_SCALE);
    let price = 190;
    for (let i = 0; i < 64; i++) {
      const t = e.step({ ...p, seq: i }, i);
      price *= Math.exp(-(s * s) / 2 + s * gaussian(p.a, p.b));
      expect(t.shift).toBeNull();
      expect(t.price).toBeCloseTo(price, 9);
    }
    expect(e.regime).toBe('expansion');
  });
  it('the c word does not change the price path', () => {
    const a = new TapeEngine(), b = new TapeEngine();
    const next = seededPackets(9);
    for (let i = 0; i < 500; i++) { const p = next(); a.step(p, i); b.step({ ...p, c: (p.c ^ 0xffffffff) >>> 0 }, i); }
    expect(a.price).toBe(b.price);
  });
});
