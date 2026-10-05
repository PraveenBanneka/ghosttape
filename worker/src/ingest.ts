// Pure rules for lines arriving on /api/ingest (unit-tested in worker/test/ingest.test.ts).
// Parsing reuses the shared parser in web/src/model/packet.ts; this file only adds the relay's policy:
//   - only GT1S (signed) packets can move the tape; unsigned GT1 packets are rejected
//   - seq must strictly increase; a lower/equal seq is accepted only right after a GT1,HELLO line (device restart)

import { parseLine } from '../../web/src/model/packet';
import type { Packet } from '../../web/src/model/random';

/** Longest line we look at (a GT1S packet is 46 chars; INFO lines are short). */
export const MAX_LINE = 256;
/** Lines per WebSocket message; bridges must forward each serial line as soon as it arrives. */
export const MAX_LINES_PER_MESSAGE = 8;

export type IngestLine =
  | { kind: 'signed'; packet: Packet; mac: string }
  | { kind: 'unsigned'; packet: Packet }
  | { kind: 'hello' }
  | { kind: 'info'; fields: Record<string, string> }
  | { kind: 'err'; reason: string; detail: string }
  | { kind: 'malformed' };

export function classifyIngestLine(raw: string): IngestLine {
  if (raw.length > MAX_LINE) return { kind: 'malformed' };
  const l = parseLine(raw);
  switch (l.kind) {
    case 'packet':
      return l.mac === null ? { kind: 'unsigned', packet: l.packet } : { kind: 'signed', packet: l.packet, mac: l.mac };
    case 'hello':
      return { kind: 'hello' };
    case 'info':
      return { kind: 'info', fields: l.fields };
    case 'err':
      return { kind: 'err', reason: l.reason, detail: l.detail };
    default:
      return { kind: 'malformed' };
  }
}

/** Splits one WebSocket text message into non-empty lines (CRLF tolerant). null = too many lines. */
export function splitMessage(msg: string): string[] | null {
  const lines = msg.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0);
  return lines.length > MAX_LINES_PER_MESSAGE ? null : lines;
}

export type SeqDecision =
  | { ok: true; kind: 'first' | 'next' | 'gap' | 'restart'; missing: number }
  | { ok: false; kind: 'replay' };

/**
 * lastSeq = last accepted seq (null if none yet); helloArmed = this uplink sent GT1,HELLO since its last accepted packet.
 * - seq > lastSeq            -> accepted ('next', or 'gap' with the number of missing packets)
 * - seq <= lastSeq, HELLO    -> accepted as a device restart
 * - seq <= lastSeq, no HELLO -> rejected (replay or duplicate)
 */
export function decideSeq(lastSeq: number | null, seq: number, helloArmed: boolean): SeqDecision {
  if (lastSeq === null) return { ok: true, kind: 'first', missing: 0 };
  if (seq > lastSeq) return seq === lastSeq + 1 ? { ok: true, kind: 'next', missing: 0 } : { ok: true, kind: 'gap', missing: seq - lastSeq - 1 };
  if (helloArmed) return { ok: true, kind: 'restart', missing: 0 };
  return { ok: false, kind: 'replay' };
}

/** Lines the relay sends back to the uplink (device/bridge). Firmware may ignore REJECT; it must obey CMD. */
export const toUplink = {
  pause: (reason: 'limit' | 'offline' | 'not_configured') => `GT1,CMD,pause,${reason}`,
  reject: (reason: 'unsigned' | 'bad_mac' | 'seq_replay' | 'malformed' | 'too_many_lines' | 'binary', seq: number | null) =>
    `GT1,REJECT,${reason},${seq ?? '-'}`,
};
