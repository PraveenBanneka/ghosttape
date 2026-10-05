// Wall-clock candles for 1s / 10s / 30s / 1m / 5m, all fed by the same tick stream (SPEC addendum item 3).
// When entropy stops the tape freezes. When it resumes, every missed bucket gets a flat "gap" candle at the frozen
// price with zero volume (Praveen: "it should keep the real time gap"), up to MAX_GAP_BARS per timeframe; longer
// outages (e.g. a session restored the next day) simply jump.

import { DEFAULT_TIME_SCALE, type Tick } from './engine';

export interface Timeframe {
  id: '1s' | '10s' | '30s' | '1m' | '5m';
  seconds: number;
}

export const TIMEFRAMES: readonly Timeframe[] = [
  { id: '1s', seconds: 1 },
  { id: '10s', seconds: 10 },
  { id: '30s', seconds: 30 },
  { id: '1m', seconds: 60 },
  { id: '5m', seconds: 300 },
];

export interface Candle {
  /** bucket start, ms */
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** synthetic, deterministic from the price path: ticks x (1 + 40 x |log return of the bar| x sqrt(k)), x100 */
  volume: number;
  ticks: number;
  /** true for a flat placeholder covering time when no entropy arrived (no price change was possible) */
  gap?: boolean;
}

export const MAX_GAP_BARS = 900;

/** The bar's return is scaled by sqrt(k) (the market-clock factor) so volatile bars still get fat volume at FX-sized moves. */
const VOLUME_RETURN_SCALE = Math.sqrt(DEFAULT_TIME_SCALE);

export function syntheticVolume(ticks: number, open: number, close: number): number {
  return Math.round(ticks * 100 * (1 + 40 * Math.abs(Math.log(close / open)) * VOLUME_RETURN_SCALE));
}

export class CandleSeries {
  readonly bars: Candle[] = [];

  constructor(readonly tf: Timeframe, private readonly maxBars = 3000) {}

  /** Adds a tick; returns the updated bar, whether it opened a new one, and any gap bars inserted before it. */
  add(t: Tick): { bar: Candle; isNew: boolean; gapBars: Candle[] } {
    const ms = this.tf.seconds * 1000;
    const bucket = Math.floor(t.time / ms) * ms;
    let bar = this.bars[this.bars.length - 1];
    let isNew = false;
    const gapBars: Candle[] = [];
    if (bar && bucket > bar.timestamp + ms) {
      const missing = (bucket - bar.timestamp) / ms - 1;
      if (missing <= MAX_GAP_BARS) {
        for (let ts = bar.timestamp + ms; ts < bucket; ts += ms) {
          const c = bar.close;
          gapBars.push({ timestamp: ts, open: c, high: c, low: c, close: c, volume: 0, ticks: 0, gap: true });
        }
        this.bars.push(...gapBars);
      }
    }
    if (!bar || bucket > bar.timestamp) {
      const open = t.prevPrice;
      bar = { timestamp: bucket, open, high: open, low: open, close: open, volume: 0, ticks: 0 };
      this.bars.push(bar);
      if (this.bars.length > this.maxBars) this.bars.splice(0, this.bars.length - this.maxBars);
      isNew = true;
    }
    bar.close = t.price;
    if (t.price > bar.high) bar.high = t.price;
    if (t.price < bar.low) bar.low = t.price;
    bar.ticks++;
    bar.volume = syntheticVolume(bar.ticks, bar.open, bar.close);
    return { bar, isNew, gapBars };
  }

  last(): Candle | undefined {
    return this.bars[this.bars.length - 1];
  }
}

/** One CandleSeries per timeframe. */
export class MultiSeries {
  readonly series: Record<Timeframe['id'], CandleSeries>;

  constructor(maxBars?: number) {
    this.series = Object.fromEntries(TIMEFRAMES.map(tf => [tf.id, new CandleSeries(tf, maxBars)])) as MultiSeries['series'];
  }

  add(t: Tick): Record<Timeframe['id'], ReturnType<CandleSeries['add']>> {
    return Object.fromEntries(TIMEFRAMES.map(tf => [tf.id, this.series[tf.id].add(t)])) as Record<Timeframe['id'], ReturnType<CandleSeries['add']>>;
  }
}
