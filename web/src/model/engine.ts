// The tape: one packet = one GBM sub-step.
// Praveen 2026-10-05: "No rates or macro economic simulation wanted for now" -> by default there are no
// expansion/recession regimes and no rate: one driftless GBM (mu = 0) whose volatility equals the old regime mix.
// The packet's third word (c) is then unused (never reused elsewhere). The prototype's regime model is kept behind
// `regimeSwitching: true` (SPEC steps 3 + 5) for tests and a possible later return.

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

/** Single-regime parameters (before time scaling): mu 0, sigma = sqrt(0.625 x 0.009^2 + 0.375 x 0.02^2), i.e. the
 *  long-run volatility of the old expansion/recession mix, so candles keep their GBP/JPY-like size. */
export const SINGLE_REGIME = { mu: 0, sigma: 0.014164 };

export class TapeEngine {
  price: number;
  regime: Regime = 'expansion';
  /** central-bank rate in percent, 0-15 */
  rate: number;
  readonly timeScale: number;
  readonly regimeSwitching: boolean;
  private stepInRoll = 0;
  private packets = 0;

  constructor(opts: { startPrice?: number; rate?: number; timeScale?: number; regimeSwitching?: boolean } = {}) {
    this.price = opts.startPrice ?? START_PRICE;
    this.rate = opts.rate ?? 5;
    this.timeScale = opts.timeScale ?? DEFAULT_TIME_SCALE;
    this.regimeSwitching = opts.regimeSwitching ?? false;
  }

  step(p: Packet, time: number): Tick {
    const base = this.regimeSwitching ? REGIMES[this.regime] : SINGLE_REGIME;
    const mu = base.mu / this.timeScale, sigma = base.sigma / Math.sqrt(this.timeScale);
    const prevPrice = this.price;
    this.price = prevPrice * Math.exp(mu - (sigma * sigma) / 2 + sigma * gaussian(p.a, p.b));
    this.packets++;
    this.stepInRoll++;
    let shift: Tick['shift'] = null;
    const regimeUsed = this.regime;
    if (this.regimeSwitching && this.stepInRoll >= STEPS_PER_ROLL) {
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

  static from(s: EngineState, opts: { regimeSwitching?: boolean } = {}): TapeEngine {
    const e = new TapeEngine({ startPrice: s.price, rate: s.rate, ...opts });
    e.regime = s.regime;
    e.stepInRoll = s.stepInRoll;
    e.packets = s.packets;
    return e;
  }
}
