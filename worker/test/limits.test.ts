import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_GAP_CAP_MS, activeIncrement, capReached, dayKey, DO_GB, freshUsage, gbSeconds, isLocalHost, parseJsonc,
  resolveLimits, reviveUsage, rollover, SAFE_LIMITS, sanitizeLimits, uplinkRefusal, usageReport, viewerAllowed,
  type Limits,
} from '../src/limits';

const ON: Limits = { online_enabled: true, max_stream_minutes_per_day: 60, max_ingest_messages_per_day: 21600, max_do_gb_seconds_per_day: 450, max_concurrent_viewers: 20 };
const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);

describe('pinned safe defaults (online OFF unless limits.jsonc says exactly true)', () => {
  it('SAFE_LIMITS: online off, every cap zero', () => {
    expect(SAFE_LIMITS).toEqual({ online_enabled: false, max_stream_minutes_per_day: 0, max_ingest_messages_per_day: 0, max_do_gb_seconds_per_day: 0, max_concurrent_viewers: 0 });
  });
  it('missing keys, wrong types and parse errors all mean online off', () => {
    expect(resolveLimits('{}', {}).online_enabled).toBe(false);
    expect(resolveLimits('not json', {})).toEqual(SAFE_LIMITS);
    expect(sanitizeLimits({ online_enabled: 'true' }).online_enabled).toBe(false);
    expect(sanitizeLimits({ online_enabled: 1 }).online_enabled).toBe(false);
    expect(sanitizeLimits({ online_enabled: true, max_concurrent_viewers: -3, max_stream_minutes_per_day: 'x' }))
      .toMatchObject({ online_enabled: true, max_concurrent_viewers: 0, max_stream_minutes_per_day: 0 });
  });
  it('the repo limits.jsonc parses and carries all five relay keys with valid types', () => {
    const text = readFileSync(new URL('../../limits.jsonc', import.meta.url), 'utf8');
    const raw = parseJsonc(text) as Record<string, unknown>;
    expect(typeof raw.online_enabled).toBe('boolean');
    for (const k of ['max_stream_minutes_per_day', 'max_ingest_messages_per_day', 'max_do_gb_seconds_per_day', 'max_concurrent_viewers']) {
      expect(typeof raw[k], k).toBe('number');
    }
    expect(resolveLimits(text, {}).online_enabled).toBe(raw.online_enabled);
  });
});

describe('local test override', () => {
  const base = '{ "online_enabled": false, "max_ingest_messages_per_day": 100 }';
  const OV = '{"online_enabled":true,"max_concurrent_viewers":5}';
  it('is ignored unless ALLOW_TEST_OVERRIDE is exactly "1"', () => {
    expect(resolveLimits(base, { LIMITS_OVERRIDE: OV }).online_enabled).toBe(false);
    expect(resolveLimits(base, { ALLOW_TEST_OVERRIDE: 'true', LIMITS_OVERRIDE: OV }).online_enabled).toBe(false);
    expect(resolveLimits(base, { ALLOW_TEST_OVERRIDE: '0', LIMITS_OVERRIDE: OV }).online_enabled).toBe(false);
  });
  it('merges over limits.jsonc when allowed', () => {
    expect(resolveLimits(base, { ALLOW_TEST_OVERRIDE: '1', LIMITS_OVERRIDE: OV }))
      .toMatchObject({ online_enabled: true, max_concurrent_viewers: 5, max_ingest_messages_per_day: 100 });
  });
  it('a broken override fails closed', () => {
    expect(resolveLimits(base, { ALLOW_TEST_OVERRIDE: '1', LIMITS_OVERRIDE: '{oops' })).toEqual(SAFE_LIMITS);
  });
  it('only local hosts may run with the override var present', () => {
    expect(isLocalHost('127.0.0.1')).toBe(true);
    expect(isLocalHost('localhost')).toBe(true);
    expect(isLocalHost('ghosttape.teamkestrel.workers.dev')).toBe(false);
    expect(isLocalHost('localhost.evil.example')).toBe(false);
  });
});

describe('daily caps (reset 00:00 UTC)', () => {
  it('day key is the UTC date; rollover resets everything incl. limitReached', () => {
    expect(dayKey(Date.UTC(2026, 9, 5, 23, 59, 59))).toBe('2026-10-05');
    const u = { ...freshUsage(T0), messages: 500, limitReached: 'messages' as const };
    expect(rollover(u, T0 + 3_600_000)).toBe(u);
    const next = rollover(u, Date.UTC(2026, 9, 6, 0, 0, 0));
    expect(next).toEqual(freshUsage(Date.UTC(2026, 9, 6)));
  });
  it('message cap: reached at exactly max', () => {
    expect(capReached({ ...freshUsage(T0), messages: 21599 }, ON)).toBeNull();
    expect(capReached({ ...freshUsage(T0), messages: 21600 }, ON)).toBe('messages');
  });
  it('stream-minutes cap', () => {
    expect(capReached({ ...freshUsage(T0), streamMs: 60 * 60_000 - 1 }, ON)).toBeNull();
    expect(capReached({ ...freshUsage(T0), streamMs: 60 * 60_000 }, ON)).toBe('stream_minutes');
  });
  it('DO GB-s cap: 0.125 GB x active seconds; 450 GB-s = 3,600 s', () => {
    expect(DO_GB).toBe(0.125);
    expect(gbSeconds(3_600_000)).toBe(450);
    expect(capReached({ ...freshUsage(T0), activeMs: 3_599_000 }, ON)).toBeNull();
    expect(capReached({ ...freshUsage(T0), activeMs: 3_600_000 }, ON)).toBe('do_gb_seconds');
  });
  it('active time counts event gaps up to 10 s (longer gaps can hibernate, unbilled)', () => {
    expect(activeIncrement(160)).toBe(160);
    expect(activeIncrement(60_000)).toBe(ACTIVE_GAP_CAP_MS);
    expect(activeIncrement(-5)).toBe(0);
  });
  it('zero caps stop everything immediately', () => {
    expect(capReached(freshUsage(T0), { ...ON, max_ingest_messages_per_day: 0 })).toBe('messages');
  });
  it('viewer cap and online switch', () => {
    expect(viewerAllowed(19, ON)).toBe(true);
    expect(viewerAllowed(20, ON)).toBe(false);
    expect(viewerAllowed(0, { ...ON, online_enabled: false })).toBe(false);
  });
  it('uplink refusal order: offline, then missing secret, then limit', () => {
    const u = freshUsage(T0);
    expect(uplinkRefusal(u, { ...ON, online_enabled: false }, false)).toBe('offline');
    expect(uplinkRefusal(u, ON, false)).toBe('not_configured');
    expect(uplinkRefusal({ ...u, limitReached: 'stream_minutes' }, ON, true)).toBe('limit');
    expect(uplinkRefusal({ ...u, messages: 21600 }, ON, true)).toBe('limit');
    expect(uplinkRefusal(u, ON, true)).toBeNull();
  });
  it('budget maths for the default caps: at 160 ms/packet the message cap is hit first (57.6 min)', () => {
    const perSecond = 1000 / 160; // 6.25 packets/s
    const secondsToMsgCap = ON.max_ingest_messages_per_day / perSecond;
    expect(secondsToMsgCap / 60).toBeCloseTo(57.6, 6);
    expect(ON.max_ingest_messages_per_day / 20).toBe(1080); // billed DO requests at 20:1
  });
  it('reviveUsage tolerates garbage and keeps a valid record', () => {
    expect(reviveUsage(null, T0)).toEqual(freshUsage(T0));
    expect(reviveUsage({ day: dayKey(T0), messages: 'x', limitReached: 'nope' }, T0)).toEqual(freshUsage(T0));
    const ok = { ...freshUsage(T0), messages: 9, streamMs: 1000, limitReached: 'messages' };
    expect(reviveUsage(ok, T0)).toEqual(ok);
    expect(reviveUsage(ok, T0 + 86_400_000)).toEqual(freshUsage(T0 + 86_400_000));
  });
  it('usage report shape', () => {
    const r = usageReport({ ...freshUsage(T0), messages: 10, streamMs: 90_000, activeMs: 8_000 }, ON);
    expect(r).toMatchObject({ messages: { used: 10, cap: 21600 }, stream_minutes: { used: 1.5, cap: 60 }, do_gb_seconds: { used: 1, cap: 450 } });
  });
});
