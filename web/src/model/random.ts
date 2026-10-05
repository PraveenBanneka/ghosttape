// Uniform and Gaussian mappings from raw 32-bit entropy words (SPEC "Price model" steps 1-2).
// Identical to prototype/index.html: toU() and gaussianFrom().

export const TWO32 = 4294967296;

/** (a+1)/(2^32+1): strictly inside (0,1), so log() is always safe. */
export const u1 = (a: number): number => (a + 1) / (TWO32 + 1);

/** b/2^32: [0,1), used for the Box-Muller angle. */
export const u2 = (b: number): number => b / TWO32;

/** (c+1)/(2^32+1): (0,1), used for the regime roll. */
export const uc = (c: number): number => (c + 1) / (TWO32 + 1);

/** Box-Muller: one standard normal draw from two words. */
export function gaussian(a: number, b: number): number {
  return Math.sqrt(-2 * Math.log(u1(a))) * Math.cos(2 * Math.PI * u2(b));
}

/** One entropy packet = three uint32 words; seq is null for demo (browser) packets. */
export interface Packet {
  seq: number | null;
  a: number;
  b: number;
  c: number;
}

/** Deterministic packet source for tests and the seeded replay only (mulberry32). Never used for the live tape. */
export function seededPackets(seed: number): () => Packet {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  let seq = 0;
  return () => ({ seq: seq++, a: next(), b: next(), c: next() });
}
