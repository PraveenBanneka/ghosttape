// Wall-clock candles for 1s / 10s / 30s / 1m / 5m, all fed by the same tick stream (SPEC addendum item 3).
// A bucket with no ticks produces no candle: when entropy stops, the chart stops.

import type { Tick } from './engine';

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
  /** synthetic, deterministic from the price path: ticks x (1 + 40 x |log return of the bar|), x100 */
  volume: number;
  ticks: number;
}

export function syntheticVolume(ticks: number, open: number, close: number): number {
  return Math.round(ticks * 100 * (1 + 40 * Math.abs(Math.log(close / open))));
}

export class CandleSeries {
  readonly bars: Candle[] = [];

  constructor(readonly tf: Timeframe, private readonly maxBars = 3000) {}

  /** Adds a tick; returns the updated bar and whether it opened a new one. */
  add(t: Tick): { bar: Candle; isNew: boolean } {
    const ms = this.tf.seconds * 1000;
    const bucket = Math.floor(t.time / ms) * ms;
    let bar = this.bars[this.bars.length - 1];
    let isNew = false;
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
    return { bar, isNew };
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

  add(t: Tick): Record<Timeframe['id'], { bar: Candle; isNew: boolean }> {
    return Object.fromEntries(TIMEFRAMES.map(tf => [tf.id, this.series[tf.id].add(t)])) as Record<Timeframe['id'], { bar: Candle; isNew: boolean }>;
  }
}
