// Online mode (docs/RELAY_PROTOCOL.md):
//  - RelayViewer: read-only WebSocket to /api/tape. Starts from the relay's snapshot and applies every packet with
//    the shared engine, so all viewers show the identical tape. Own 400 ms watchdog.
//  - RelayBridge: forwards a USB-connected ESP32's serial lines verbatim to /api/ingest, one line per message, the
//    moment each arrives (no buffering: the no-stock rule applies to the bridge too). The device signs packets;
//    the bridge never sees the key.
import type { Candle, Timeframe } from '../model/aggregator';
import type { EngineState } from '../model/engine';
import type { Packet } from '../model/random';
import type { Tick } from '../model/engine';

export interface RelayStatus {
  online_enabled: boolean;
  uplink: 'up' | 'stalled' | 'down';
  frozen: boolean;
  message: string;
  last_packet_at: number | null;
  viewers: number;
}

export interface RelaySnapshot {
  engine: EngineState;
  candles: Record<Timeframe['id'], Candle[]>;
  status: RelayStatus;
  label: string;
}

export interface ViewerEvents {
  snapshot: (s: RelaySnapshot) => void;
  packet: (p: Packet, time: number, relayTick: Pick<Tick, 'price'>) => void;
  status: (s: RelayStatus) => void;
  info: (text: string, bad: boolean) => void;
  closed: (reason: string) => void;
}

const wsUrl = (path: string): string => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;
export const WATCHDOG_MS = 400;

export class RelayViewer {
  private ws: WebSocket | null = null;
  private lastPacketAt = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private frozen = true;

  constructor(private readonly on: ViewerEvents) {}

  start(): void {
    this.stop();
    const ws = new WebSocket(wsUrl('/api/tape'));
    this.ws = ws;
    ws.onmessage = e => this.handle(String(e.data));
    ws.onclose = e => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.on.closed(e.reason || `connection closed (${e.code})`);
    };
    this.watchdog = setInterval(() => {
      if (!this.frozen && performance.now() - this.lastPacketAt > WATCHDOG_MS) {
        this.frozen = true;
        this.on.info('no relay packet for 400 ms: tape frozen', true);
      }
    }, 50);
  }

  stop(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, 'viewer left');
  }

  private handle(raw: string): void {
    let m: { type: string; [k: string]: unknown };
    try { m = JSON.parse(raw); } catch { return; }
    switch (m.type) {
      case 'snapshot':
        this.on.snapshot(m as unknown as RelaySnapshot);
        return;
      case 'packet': {
        this.lastPacketAt = performance.now();
        this.frozen = false;
        this.on.packet(m.packet as Packet, m.time as number, m.tick as Pick<Tick, 'price'>);
        return;
      }
      case 'status':
        this.on.status(m.status as RelayStatus);
        return;
      case 'radio': {
        const r = m.radio as { level: string; fields?: Record<string, string>; reason?: string; detail?: string };
        this.on.info(r.level === 'err' ? `ESP32 radio NOT verified: ${r.reason} (${r.detail})` : `ESP32 radio verified · ${r.fields?.aps ?? '?'} Wi-Fi networks heard`, r.level === 'err');
        return;
      }
      case 'event':
        this.on.info(String(m.message), m.event === 'gap');
        return;
      case 'limit':
        this.on.info(String(m.message), true);
        return;
      default:
        return;
    }
  }
}

export class RelayBridge {
  private ws: WebSocket | null = null;
  stopped = false;

  constructor(private readonly onEvent: (text: string, bad: boolean, fatal: boolean) => void) {}

  start(): void {
    this.stopped = false;
    const ws = new WebSocket(wsUrl('/api/ingest'));
    this.ws = ws;
    ws.onopen = () => this.onEvent('bridge connected: forwarding signed ESP32 lines to the relay', false, false);
    ws.onmessage = e => {
      const line = String(e.data);
      if (line.startsWith('GT1,CMD,pause,')) {
        this.onEvent(`relay asked the bridge to pause (${line.split(',')[3]})`, true, true);
        this.stop();
      } else if (line.startsWith('GT1,REJECT,')) {
        this.onEvent(`relay rejected a line: ${line.slice(11)}`, true, false);
      }
    };
    ws.onclose = e => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.stopped) this.onEvent(`bridge closed: ${e.reason || e.code}`, true, true);
    };
  }

  /** Forward one serial line immediately (called from the serial read loop). */
  forward(line: string): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN && line.startsWith('GT1')) ws.send(line.trim());
  }

  stop(): void {
    this.stopped = true;
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, 'bridge stopped');
  }

  get active(): boolean { return this.ws !== null; }
}
