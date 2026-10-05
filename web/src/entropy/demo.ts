// DEMO source: browser crypto, same cadence as the firmware (160 ms). Always labelled as not hardware.
import type { Packet } from '../model/random';
import type { EntropySource, SourceEvents } from './source';

export const PACKET_MS = 160;

export function cryptoPacket(): Packet {
  const w = new Uint32Array(3);
  crypto.getRandomValues(w);
  return { seq: null, a: w[0], b: w[1], c: w[2] };
}

export class DemoSource implements EntropySource {
  readonly kind = 'demo' as const;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly on: SourceEvents) {}

  async start(): Promise<void> {
    this.stop();
    this.on.state('demo', '');
    this.timer = setInterval(() => this.on.packet(cryptoPacket()), PACKET_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
