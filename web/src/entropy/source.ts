// Entropy sources feed packets to the tape. The tape never generates randomness itself.
//   demo   : browser crypto.getRandomValues, always labelled "DEMO · browser entropy, not hardware"
//   esp32  : USB Web Serial, one packet per price step, no buffering, freezes when packets stop
import type { Packet } from '../model/random';

export type FeedState = 'demo' | 'waiting' | 'live' | 'offline' | 'radio_error';

export interface SourceEvents {
  packet: (p: Packet) => void;
  state: (s: FeedState, message: string) => void;
  /** status lines from the ESP32 (HELLO / INFO / ERR), restarts, gaps */
  status: (kind: 'hello' | 'info' | 'err' | 'restart' | 'gap', detail: string, fields?: Record<string, string>) => void;
}

export interface EntropySource {
  readonly kind: 'demo' | 'esp32';
  start(): Promise<void>;
  stop(): void;
}
