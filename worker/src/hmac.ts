// HMAC check for signed packets: GT1S,<seq>,<a>,<b>,<c>,<hmac8>
// hmac8 = first 8 hex chars (lowercase) of HMAC-SHA256(DEVICE_SECRET, "<seq>,<a>,<b>,<c>"), where seq is plain
// decimal (no leading zeros, like printf %u) and a,b,c are 8-digit lowercase hex (printf %08x).
// The key is the UTF-8 bytes of the DEVICE_SECRET string.
//
// node:crypto (Workers "nodejs_compat") is used because it is SYNCHRONOUS: a packet is verified, applied and
// broadcast inside one event with no await, so two messages can never interleave inside the Durable Object.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Packet } from '../../web/src/model/random';

export const hex8 = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');

/** The exact string the device signs. */
export const canonicalMessage = (p: Packet): string => `${p.seq},${hex8(p.a)},${hex8(p.b)},${hex8(p.c)}`;

/** First 8 lowercase hex chars of HMAC-SHA256(secret, message). */
export const hmac8 = (secret: string, message: string): string =>
  createHmac('sha256', secret).update(message, 'utf8').digest('hex').slice(0, 8);

/** Constant-time compare of two hex MACs (length is public: always 8). */
export function macEqual(expected: string, got: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(got.toLowerCase(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export const verifyPacketMac = (secret: string, p: Packet, mac: string): boolean => macEqual(hmac8(secret, canonicalMessage(p)), mac);

/** Builds a signed line (tests, the e2e script, and the reference for bridges/firmware). */
export function signLine(secret: string, p: Packet): string {
  const msg = canonicalMessage(p);
  return `GT1S,${msg},${hmac8(secret, msg)}`;
}
