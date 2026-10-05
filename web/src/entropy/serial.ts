// ESP32 source over Web Serial (Chrome / Edge desktop, localhost or https).
// SPEC rules: every price move = one ESP32 packet; no buffering/queueing of numbers; each used once;
// unplug -> frozen within ~0.2 s (rejected read, `disconnect` event, or the 400 ms watchdog).
// The firmware only sends packets while its radio is verified (GT1,INFO); GT1,ERR means it is withholding them.
import { parseLine, SeqTracker } from '../model/packet';
import type { EntropySource, SourceEvents } from './source';

export const WATCHDOG_MS = 400; // 2.5 x the 160 ms packet interval
const BAUD = 115200;

// Minimal Web Serial typings (not in the TS DOM lib yet).
interface SerialPortLike {
  open(o: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
}
interface SerialLike extends EventTarget {
  requestPort(): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
}
const serial = (): SerialLike | undefined => (navigator as unknown as { serial?: SerialLike }).serial;

export const webSerialSupported = (): boolean => !!serial();

export class SerialSource implements EntropySource {
  readonly kind = 'esp32' as const;
  readonly seq = new SeqTracker();
  /** optional tap on every raw serial line (used by the online USB bridge to forward lines verbatim) */
  onLine: ((raw: string) => void) | null = null;
  lastPacketAt = 0;
  live = false;
  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<string> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private radioError = false;
  private readonly onDisconnect = () => this.offline('USB disconnected. No entropy, no candles.');
  private readonly onConnect = (e: Event) => void this.reconnect(e.target as unknown as SerialPortLike);

  constructor(private readonly on: SourceEvents) {}

  /** Must be called from a user gesture (the browser shows the port picker). */
  async start(): Promise<void> {
    const s = serial();
    if (!s) throw new Error('Web Serial is not available. Use desktop Chrome or Edge on localhost or https.');
    const port = await s.requestPort();
    await port.open({ baudRate: BAUD });
    this.port = port;
    this.stopped = false;
    s.addEventListener('disconnect', this.onDisconnect);
    s.addEventListener('connect', this.onConnect);
    this.on.state('waiting', 'Every price step now needs a fresh packet from the ESP32. Unplug it to freeze the tape.');
    this.watchdog = setInterval(() => {
      if (this.live && performance.now() - this.lastPacketAt > WATCHDOG_MS) {
        this.offline(`No packet for ${WATCHDOG_MS} ms. The tape is frozen until entropy returns.`);
      }
    }, 50);
    void this.readLoop();
  }

  stop(): void {
    this.stopped = true;
    const s = serial();
    s?.removeEventListener('disconnect', this.onDisconnect);
    s?.removeEventListener('connect', this.onConnect);
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    const r = this.reader, p = this.port;
    this.reader = null;
    this.port = null;
    this.live = false;
    r?.cancel().catch(() => {});
    if (p) setTimeout(() => p.close().catch(() => {}), 50);
  }

  private async reconnect(port: SerialPortLike): Promise<void> {
    if (this.stopped || this.reader) return;
    try {
      await port.open({ baudRate: BAUD });
      this.port = port;
      this.on.state('waiting', 'ESP32 reconnected. Waiting for packets; the tape resumes from the frozen price.');
      void this.readLoop();
    } catch { /* not ours or already open */ }
  }

  private offline(msg: string): void {
    if (this.stopped) return;
    if (this.live || !this.radioError) this.on.state('offline', msg);
    this.live = false;
  }

  private async readLoop(): Promise<void> {
    const port = this.port;
    if (!port?.readable) return;
    const decoder = new TextDecoderStream();
    port.readable.pipeTo(decoder.writable as unknown as WritableStream<Uint8Array>).catch(() => {});
    const reader = decoder.readable.getReader();
    this.reader = reader;
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read(); // rejects the instant USB is pulled
        if (done) break;
        buf += value;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          this.handle(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
        if (buf.length > 4096) buf = '';
      }
    } catch { /* unplugged */ } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
      if (this.reader === reader) this.reader = null;
      this.offline('The ESP32 stopped sending. Plug it back in to resume from the frozen price.');
      try { await port.close(); } catch { /* already closed */ }
    }
  }

  private handle(raw: string): void {
    this.onLine?.(raw);
    const l = parseLine(raw);
    switch (l.kind) {
      case 'hello':
        this.on.status('hello', 'ESP32 booted, verifying its radio');
        return;
      case 'info':
        this.radioError = false;
        this.on.status('info', `radio ${l.fields.radio ?? '?'} · sleep ${l.fields.ps ?? '?'} · ${l.fields.aps ?? '?'} Wi-Fi networks heard`, l.fields);
        return;
      case 'err':
        this.radioError = true;
        this.live = false;
        this.on.status('err', `${l.reason} (${l.detail})`);
        this.on.state('radio_error', `The ESP32 could not verify its radio (${l.detail}), so it is withholding numbers: they would only be pseudo-random.`);
        return;
      case 'packet': {
        const r = this.seq.observe(l.packet.seq!);
        if (r === 'restart') this.on.status('restart', `ESP32 restarted, sequence reset to ${l.packet.seq}`);
        if (r === 'gap') this.on.status('gap', `${this.seq.gaps} packet(s) lost so far`);
        this.lastPacketAt = performance.now();
        if (!this.live) { this.live = true; this.on.state('live', ''); }
        this.on.packet(l.packet);
        return;
      }
      default:
        return; // malformed or boot noise: ignored, never filled in
    }
  }
}
