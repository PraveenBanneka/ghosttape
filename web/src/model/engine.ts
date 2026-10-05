// The tape: one packet = one GBM sub-step; the regime is rolled with the packet's third word on every
// 8th packet (SPEC steps 3 + 5; addendum item 3 keeps this rhythm while candles become clock buckets).

import { gaussian, uc, type Packet } from './random';
import { REGIMES, rollRegime, type Regime } from './regime';

export const STEPS_PER_ROLL = 8;
/** GBP/JPY-like presentation (Praveen, 2026-10-05: "most like real fx charts, think GJ"). */
export const START_PRICE = 190;
export const PRICE_DECIMALS = 3;

export interface Tick {
  /** wall-clock ms when the packet arrived */
  time: number;
  price: number;
  prevPrice: number;
  regime: Regime;
  /** set when this tick's roll switched the regime */
  shift: { from: Regime; to: Regime; rate: number } | null;
  seq: number | null;
  /** packets consumed by this tape so far, including this one (each is used exactly once) */
  index: number;
}

export interface EngineState {
  price: number;
  regime: Regime;
  rate: number;
  stepInRoll: number;
  packets: number;
}

/**
 * Market-clock scale k: per-step drift mu/k and volatility sigma/sqrt(k), i.e. the same GBM on a slower clock.
 * k = 1 reproduces the prototype exactly. Praveen chose the GBP/JPY-like preset (2026-10-05): k = 1,400,000 gives
 * about 0.023% per 1-minute candle, 0.2% per hour and ~1% per day at 6.25 packets/s (simulated, see WORKLOG),
 * with no meaningful long-run drift. Expansion ~ a calm session, recession ~ about twice as volatile.
 */
export const DEFAULT_TIME_SCALE = 1_400_000;

export class TapeEngine {
  price: number;
  regime: Regime = 'expansion';
  /** central-bank rate in percent, 0-15 */
  rate: number;
  readonly timeScale: number;
  private stepInRoll = 0;
  private packets = 0;

  constructor(opts: { startPrice?: number; rate?: number; timeScale?: number } = {}) {
    this.price = opts.startPrice ?? START_PRICE;
    this.rate = opts.rate ?? 5;
    this.timeScale = opts.timeScale ?? DEFAULT_TIME_SCALE;
  }

  step(p: Packet, time: number): Tick {
    const base = REGIMES[this.regime];
    const mu = base.mu / this.timeScale, sigma = base.sigma / Math.sqrt(this.timeScale);
    const prevPrice = this.price;
    this.price = prevPrice * Math.exp(mu - (sigma * sigma) / 2 + sigma * gaussian(p.a, p.b));
    this.packets++;
    this.stepInRoll++;
    let shift: Tick['shift'] = null;
    const regimeUsed = this.regime;
    if (this.stepInRoll >= STEPS_PER_ROLL) {
      this.stepInRoll = 0;
      const next = rollRegime(this.regime, this.rate, uc(p.c));
      if (next !== this.regime) {
        shift = { from: this.regime, to: next, rate: this.rate };
        this.regime = next;
      }
    }
    return { time, price: this.price, prevPrice, regime: regimeUsed, shift, seq: p.seq, index: this.packets };
  }

  state(): EngineState {
    return { price: this.price, regime: this.regime, rate: this.rate, stepInRoll: this.stepInRoll, packets: this.packets };
  }

  static from(s: EngineState): TapeEngine {
    const e = new TapeEngine({ startPrice: s.price, rate: s.rate });
    e.regime = s.regime;
    e.stepInRoll = s.stepInRoll;
    e.packets = s.packets;
    return e;
  }
}
