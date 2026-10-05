// Two-state Markov regime switch (Hamilton-style), SPEC "Price model" step 5. Identical to the prototype.

export type Regime = 'expansion' | 'recession';

export const REGIMES: Record<Regime, { mu: number; sigma: number }> = {
  expansion: { mu: 0.0006, sigma: 0.009 },
  recession: { mu: -0.0009, sigma: 0.02 },
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Probability of leaving `regime` at one roll, given the central-bank rate in percent (0-15). */
export function switchProbability(regime: Regime, rate: number): number {
  return regime === 'expansion'
    ? clamp(0.03 + (rate - 5) * 0.012, 0.01, 0.5) // expansion -> recession
    : clamp(0.05 + (5 - rate) * 0.01, 0.02, 0.5); // recession -> expansion
}

/** Roll the regime with a uniform u in (0,1). */
export function rollRegime(regime: Regime, rate: number, u: number): Regime {
  if (u < switchProbability(regime, rate)) return regime === 'expansion' ? 'recession' : 'expansion';
  return regime;
}
