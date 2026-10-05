// Parser for the ESP32 serial protocol (SPEC "Packet protocol" + addendum item 9).
//   GT1,<seq>,<a>,<b>,<c>            one packet (three uint32 as 8 hex digits)
//   GT1S,<seq>,<a>,<b>,<c>,<hmac8>   signed packet (verified by the Worker, which holds the key)
//   GT1,HELLO | GT1,INFO,k=v,... | GT1,ERR,<reason>[,detail]
// Malformed lines are ignored; values are never invented to fill them.

import type { Packet } from './random';

export type Line =
  | { kind: 'packet'; packet: Packet; mac: string | null }
  | { kind: 'hello' }
  | { kind: 'info'; fields: Record<string, string> }
  | { kind: 'err'; reason: string; detail: string }
  | { kind: 'ignore' };

const HEX8 = /^[0-9a-fA-F]{8}$/;
const SEQ = /^\d{1,10}$/;

export function parseLine(raw: string): Line {
  const p = raw.trim().split(',');
  if (p[0] === 'GT1') {
    if (p[1] === 'HELLO' && p.length === 2) return { kind: 'hello' };
    if (p[1] === 'INFO') {
      const fields: Record<string, string> = {};
      for (const kv of p.slice(2)) {
        const i = kv.indexOf('=');
        if (i > 0) fields[kv.slice(0, i)] = kv.slice(i + 1);
      }
      return { kind: 'info', fields };
    }
    if (p[1] === 'ERR') return { kind: 'err', reason: p[2] ?? 'unknown', detail: p.slice(3).join(',') };
    if (p.length === 5) return packetFrom(p, null);
  }
  if (p[0] === 'GT1S' && p.length === 6 && HEX8.test(p[5])) return packetFrom(p, p[5].toLowerCase());
  return { kind: 'ignore' };
}

function packetFrom(p: string[], mac: string | null): Line {
  if (!SEQ.test(p[1]) || !HEX8.test(p[2]) || !HEX8.test(p[3]) || !HEX8.test(p[4])) return { kind: 'ignore' };
  const seq = Number(p[1]);
  if (seq > 0xffffffff) return { kind: 'ignore' };
  return { kind: 'packet', mac, packet: { seq, a: parseInt(p[2], 16) >>> 0, b: parseInt(p[3], 16) >>> 0, c: parseInt(p[4], 16) >>> 0 } };
}

/** Tracks the packet counter: a jump = lost packets (gaps), a drop = the ESP32 restarted. */
export class SeqTracker {
  last: number | null = null;
  gaps = 0;
  restarts = 0;

  observe(seq: number): 'first' | 'ok' | 'gap' | 'restart' {
    const prev = this.last;
    this.last = seq;
    if (prev === null) return 'first';
    if (seq <= prev) { this.restarts++; return 'restart'; }
    if (seq > prev + 1) { this.gaps += seq - prev - 1; return 'gap'; }
    return 'ok';
  }

  reset(): void { this.last = null; this.gaps = 0; this.restarts = 0; }
}
