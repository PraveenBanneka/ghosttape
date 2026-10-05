import { describe, expect, it } from 'vitest';
import { classifyIngestLine, decideSeq, MAX_LINES_PER_MESSAGE, splitMessage, toUplink } from '../src/ingest';

describe('relay line classification', () => {
  it('GT1S with a MAC is a signed packet', () => {
    const l = classifyIngestLine('GT1S,7,00000001,00000002,0000000a,1234abcd');
    expect(l).toEqual({ kind: 'signed', packet: { seq: 7, a: 1, b: 2, c: 10 }, mac: '1234abcd' });
  });
  it('plain GT1 packets are classed unsigned (the relay rejects them)', () => {
    expect(classifyIngestLine('GT1,7,00000001,00000002,0000000a').kind).toBe('unsigned');
  });
  it('status lines', () => {
    expect(classifyIngestLine('GT1,HELLO')).toEqual({ kind: 'hello' });
    expect(classifyIngestLine('GT1,INFO,radio=on,ps=none,aps=4,up=31')).toEqual({ kind: 'info', fields: { radio: 'on', ps: 'none', aps: '4', up: '31' } });
    expect(classifyIngestLine('GT1,ERR,radio_off,scan_failed')).toEqual({ kind: 'err', reason: 'radio_off', detail: 'scan_failed' });
  });
  it('malformed lines are never "repaired"', () => {
    for (const bad of [
      '', 'hello', 'GT1S,7,00000001,00000002,0000000a', // GT1S without MAC
      'GT1S,7,00000001,00000002,0000000a,1234abc', // 7-char MAC
      'GT1S,7,00000001,00000002,0000000a,1234abcg', // non-hex MAC
      'GT1S,7,0000001,00000002,0000000a,1234abcd', // 7-digit word
      'GT1S,-1,00000001,00000002,0000000a,1234abcd', // negative seq
      'GT1S,4294967296,00000001,00000002,0000000a,1234abcd', // seq > uint32
      'GT1S,7,00000001,00000002,0000000a,1234abcd,extra',
      'GT1,' + 'x'.repeat(300),
    ]) expect(classifyIngestLine(bad).kind, bad).toBe('malformed');
  });
  it('splits CRLF messages into lines and caps lines per message', () => {
    expect(splitMessage('GT1,HELLO\r\nGT1,INFO,a=1\n\n')).toEqual(['GT1,HELLO', 'GT1,INFO,a=1']);
    expect(splitMessage(Array(MAX_LINES_PER_MESSAGE + 1).fill('GT1,HELLO').join('\n'))).toBeNull();
  });
  it('relay -> uplink lines', () => {
    expect(toUplink.pause('limit')).toBe('GT1,CMD,pause,limit');
    expect(toUplink.pause('offline')).toBe('GT1,CMD,pause,offline');
    expect(toUplink.reject('bad_mac', 9)).toBe('GT1,REJECT,bad_mac,9');
    expect(toUplink.reject('malformed', null)).toBe('GT1,REJECT,malformed,-');
  });
});

describe('seq rules (each packet used once)', () => {
  it('first packet of a fresh relay is accepted at any seq', () => {
    expect(decideSeq(null, 12345, false)).toEqual({ ok: true, kind: 'first', missing: 0 });
  });
  it('strictly increasing seq is accepted; jumps count the missing packets', () => {
    expect(decideSeq(5, 6, false)).toEqual({ ok: true, kind: 'next', missing: 0 });
    expect(decideSeq(5, 9, false)).toEqual({ ok: true, kind: 'gap', missing: 3 });
  });
  it('a repeated or lower seq without HELLO is a replay', () => {
    expect(decideSeq(5, 5, false)).toEqual({ ok: false, kind: 'replay' });
    expect(decideSeq(5, 0, false)).toEqual({ ok: false, kind: 'replay' });
  });
  it('a seq reset right after GT1,HELLO is a restart', () => {
    expect(decideSeq(5000, 0, true)).toEqual({ ok: true, kind: 'restart', missing: 0 });
    expect(decideSeq(5000, 5000, true)).toEqual({ ok: true, kind: 'restart', missing: 0 });
  });
  it('HELLO does not disturb a normal increasing seq', () => {
    expect(decideSeq(5, 6, true)).toEqual({ ok: true, kind: 'next', missing: 0 });
  });
});
