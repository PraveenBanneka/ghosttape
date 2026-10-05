import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalMessage, hex8, hmac8, macEqual, signLine, verifyPacketMac } from '../src/hmac';
import { classifyIngestLine } from '../src/ingest';

const SECRET = 'unit-test-secret-not-a-real-key';
const P = { seq: 42, a: 0x0000beef, b: 0xdeadbeef, c: 7 };

describe('HMAC signing of GT1S packets', () => {
  it('signs "<seq>,<a>,<b>,<c>" with 8-digit lowercase hex words and decimal seq', () => {
    expect(hex8(0xbeef)).toBe('0000beef');
    expect(hex8(0xffffffff)).toBe('ffffffff');
    expect(canonicalMessage(P)).toBe('42,0000beef,deadbeef,00000007');
  });
  it('matches the RFC 4231 test case 2 (key "Jefe"), truncated to 8 hex chars', () => {
    expect(hmac8('Jefe', 'what do ya want for nothing?')).toBe('5bdcc146');
  });
  it('hmac8 = first 8 hex chars of the full HMAC-SHA256', () => {
    const full = createHmac('sha256', SECRET).update(canonicalMessage(P)).digest('hex');
    expect(hmac8(SECRET, canonicalMessage(P))).toBe(full.slice(0, 8));
  });
  it('accepts a correctly signed packet (round trip through the shared parser)', () => {
    const line = signLine(SECRET, P);
    expect(line).toMatch(/^GT1S,42,0000beef,deadbeef,00000007,[0-9a-f]{8}$/);
    const l = classifyIngestLine(line);
    expect(l.kind).toBe('signed');
    if (l.kind !== 'signed') return;
    expect(l.packet).toEqual(P);
    expect(verifyPacketMac(SECRET, l.packet, l.mac)).toBe(true);
  });
  it('accepts an upper-case MAC (the parser lowercases it)', () => {
    const line = signLine(SECRET, P);
    const upper = line.slice(0, -8) + line.slice(-8).toUpperCase();
    const l = classifyIngestLine(upper);
    expect(l.kind === 'signed' && verifyPacketMac(SECRET, l.packet, l.mac)).toBe(true);
  });
  it('rejects a wrong key, any changed word, a changed seq and a flipped MAC digit', () => {
    const mac = hmac8(SECRET, canonicalMessage(P));
    expect(verifyPacketMac('other-secret', P, mac)).toBe(false);
    expect(verifyPacketMac(SECRET, { ...P, a: P.a ^ 1 }, mac)).toBe(false);
    expect(verifyPacketMac(SECRET, { ...P, c: P.c + 1 }, mac)).toBe(false);
    expect(verifyPacketMac(SECRET, { ...P, seq: 43 }, mac)).toBe(false);
    const flipped = mac.slice(0, 7) + (mac[7] === '0' ? '1' : '0');
    expect(verifyPacketMac(SECRET, P, flipped)).toBe(false);
  });
  it('macEqual rejects different lengths without throwing', () => {
    expect(macEqual('abcd1234', 'abcd123')).toBe(false);
    expect(macEqual('abcd1234', '')).toBe(false);
    expect(macEqual('abcd1234', 'abcd1234')).toBe(true);
  });
});
