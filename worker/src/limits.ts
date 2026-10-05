// Owner limits (repo-root limits.jsonc, Praveen edits it by hand) and the daily-cap maths.
// Pure functions only, so every rule here is unit-tested (worker/test/limits.test.ts).
// Safe default everywhere: anything missing or malformed means online mode OFF.

export interface Limits {
  online_enabled: boolean;
  max_stream_minutes_per_day: number;
  max_ingest_messages_per_day: number;
  max_do_gb_seconds_per_day: number;
  max_concurrent_viewers: number;
}

/** Used when limits.jsonc cannot be read or a value is invalid: online off, caps at zero. */
export const SAFE_LIMITS: Readonly<Limits> = Object.freeze({
  online_enabled: false,
  max_stream_minutes_per_day: 0,
  max_ingest_messages_per_day: 0,
  max_do_gb_seconds_per_day: 0,
  max_concurrent_viewers: 0,
});

/** Durable Object duration is billed on the 128 MB allocation regardless of use (DO pricing page). */
export const DO_GB = 0.125;
/** Gaps between DO events longer than this are not counted as active (the object can hibernate). */
export const ACTIVE_GAP_CAP_MS = 10_000;

/** Same comment stripping as web/src/config.ts parseJsonc and tools/limits-lib.cjs
 * (the file holds no strings containing "//"). */
export function parseJsonc(text: string): unknown {
  return JSON.parse(
    text.replace(/\r\n/g, '\n').replace(/^\s*\/\/.*$/gm, '').replace(/,?\s*\/\/[^\n"]*$/gm, m => (m.trim().startsWith(',') ? ',' : '')),
  );
}

const NUM_KEYS = ['max_stream_minutes_per_day', 'max_ingest_messages_per_day', 'max_do_gb_seconds_per_day', 'max_concurrent_viewers'] as const;

/** Takes only the five relay keys; a wrong type or negative number falls back to the safe value. */
export function sanitizeLimits(raw: unknown): Limits {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Limits = { ...SAFE_LIMITS };
  out.online_enabled = r.online_enabled === true; // strictly true; "true", 1, missing -> off
  for (const k of NUM_KEYS) {
    const v = r[k];
    out[k] = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
  }
  return out;
}

export interface OverrideEnv {
  ALLOW_TEST_OVERRIDE?: string;
  LIMITS_OVERRIDE?: string;
}

/**
 * Effective limits = limits.jsonc, plus (local tests only) LIMITS_OVERRIDE when ALLOW_TEST_OVERRIDE === "1".
 * ALLOW_TEST_OVERRIDE lives only in the git-ignored .dev.vars; the Worker additionally refuses every /api
 * request when that var is present on a non-local host (see isLocalHost / index.ts), so it cannot act in production.
 */
export function resolveLimits(limitsText: string, env: OverrideEnv): Limits {
  let base: Record<string, unknown>;
  try {
    base = parseJsonc(limitsText) as Record<string, unknown>;
  } catch {
    return { ...SAFE_LIMITS };
  }
  if (env.ALLOW_TEST_OVERRIDE === '1' && env.LIMITS_OVERRIDE) {
    try {
      const o = JSON.parse(env.LIMITS_OVERRIDE) as Record<string, unknown>;
      base = { ...base, ...o };
    } catch {
      return { ...SAFE_LIMITS };
    }
  }
  return sanitizeLimits(base);
}

/** Hosts where the test override may act (wrangler dev). */
export function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

// ---------------------------------------------------------------- daily usage (resets 00:00 UTC)

export interface Usage {
  /** UTC day, YYYY-MM-DD */
  day: string;
  /** every incoming WebSocket message (uplink lines and stray viewer messages): each one is billed */
  messages: number;
  /** accumulated time with an authenticated uplink connected, ms */
  streamMs: number;
  /** estimated non-hibernated DO time, ms (event gaps capped at ACTIVE_GAP_CAP_MS) */
  activeMs: number;
  peakViewers: number;
  /** which cap stopped the stream today, or null */
  limitReached: CapName | null;
}

export type CapName = 'messages' | 'stream_minutes' | 'do_gb_seconds';

export const dayKey = (now: number): string => new Date(now).toISOString().slice(0, 10);

export const freshUsage = (now: number): Usage => ({
  day: dayKey(now), messages: 0, streamMs: 0, activeMs: 0, peakViewers: 0, limitReached: null,
});

/** Returns the same object on the same UTC day, a fresh one after midnight UTC. */
export function rollover(u: Usage, now: number): Usage {
  return u.day === dayKey(now) ? u : freshUsage(now);
}

/** Loads a stored usage record defensively (unknown shape -> fresh day). */
export function reviveUsage(raw: unknown, now: number): Usage {
  const r = raw as Partial<Usage> | null;
  if (!r || typeof r !== 'object' || typeof r.day !== 'string') return freshUsage(now);
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const caps: CapName[] = ['messages', 'stream_minutes', 'do_gb_seconds'];
  return rollover({
    day: r.day,
    messages: n(r.messages),
    streamMs: n(r.streamMs),
    activeMs: n(r.activeMs),
    peakViewers: n(r.peakViewers),
    limitReached: caps.includes(r.limitReached as CapName) ? (r.limitReached as CapName) : null,
  }, now);
}

export const gbSeconds = (activeMs: number): number => (DO_GB * activeMs) / 1000;

/** Active-time increment for one DO event after a gap (hibernation-eligible gaps are not billed). */
export const activeIncrement = (gapMs: number): number => Math.min(Math.max(gapMs, 0), ACTIVE_GAP_CAP_MS);

/** First cap that is reached (>=), or null. A cap of 0 is reached immediately. */
export function capReached(u: Usage, l: Limits): CapName | null {
  if (u.messages >= l.max_ingest_messages_per_day) return 'messages';
  if (u.streamMs >= l.max_stream_minutes_per_day * 60_000) return 'stream_minutes';
  if (gbSeconds(u.activeMs) >= l.max_do_gb_seconds_per_day) return 'do_gb_seconds';
  return null;
}

/** May one more viewer connect, given how many are connected now? */
export const viewerAllowed = (current: number, l: Limits): boolean => l.online_enabled && current < l.max_concurrent_viewers;

/** May an uplink stream right now? Returns the refusal reason or null. */
export function uplinkRefusal(u: Usage, l: Limits, hasSecret: boolean): 'offline' | 'not_configured' | 'limit' | null {
  if (!l.online_enabled) return 'offline';
  if (!hasSecret) return 'not_configured';
  if (u.limitReached || capReached(u, l)) return 'limit';
  return null;
}

export function usageReport(u: Usage, l: Limits) {
  return {
    day: u.day,
    resets: 'daily at 00:00 UTC',
    messages: { used: u.messages, cap: l.max_ingest_messages_per_day },
    stream_minutes: { used: +(u.streamMs / 60_000).toFixed(2), cap: l.max_stream_minutes_per_day },
    do_gb_seconds: { used: +gbSeconds(u.activeMs).toFixed(2), cap: l.max_do_gb_seconds_per_day },
    peak_viewers: { used: u.peakViewers, cap: l.max_concurrent_viewers },
    limit_reached: u.limitReached,
  };
}
