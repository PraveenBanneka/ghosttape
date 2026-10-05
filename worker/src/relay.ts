// TapeRelay: the one Durable Object (name "main") that relays ESP32 packets to viewers.
//
// Live-path rules (docs/SPEC.md):
//   - no entropy stock: every accepted packet is applied and broadcast inside the same event, nothing is queued
//   - each packet is used exactly once (strictly increasing seq; replays rejected)
//   - packets stop -> the tape stops; viewers are told "frozen" 400 ms after the last packet
//   - storage holds derived state only (engine state, candles, counters), never raw unused entropy
//
// Uses the WebSocket Hibernation API (ctx.acceptWebSocket + webSocketMessage/Close) so idle sockets cost no
// duration. Memory is lost on hibernation; the constructor reloads the last snapshot from SQLite.

import { DurableObject } from 'cloudflare:workers';
import { TapeEngine, type EngineState, type Tick } from '../../web/src/model/engine';
import { MultiSeries, TIMEFRAMES, type Candle, type Timeframe } from '../../web/src/model/aggregator';
import type { Packet } from '../../web/src/model/random';
import { currentLimits } from './config';
import type { Env } from './env';
import { verifyPacketMac } from './hmac';
import { classifyIngestLine, decideSeq, splitMessage, toUplink } from './ingest';
import {
  activeIncrement, capReached, freshUsage, reviveUsage, rollover, uplinkRefusal, usageReport, viewerAllowed,
  type CapName, type Limits, type Usage,
} from './limits';

export const LABEL = 'Synthetic tape, not real market data. No advice.';
/** 2.5 x the 160 ms packet interval (SPEC watchdog); viewers must see "frozen" within ~0.5 s. */
export const STALL_MS = 400;
/** Persist this long after a stall, before the object may hibernate (~10 s idle) and lose memory. */
const IDLE_PERSIST_MS = 2_000;
/** Free-plan write budget: periodic snapshot at most every 30 s while streaming. */
const PERSIST_EVERY_MS = 30_000;
/** Candles kept per timeframe (memory, snapshot and storage). */
export const MAX_BARS = 300;
/** At most one active uplink plus one candidate (e.g. the ESP32 reconnecting after a Wi-Fi blip). */
const MAX_UPLINK_SOCKETS = 2;

type UplinkState = 'down' | 'up' | 'stalled';
type ViewerAtt = { role: 'viewer'; since: number };
type UplinkAtt = { role: 'uplink'; since: number; active: boolean; hello: boolean };
type Att = ViewerAtt | UplinkAtt;

interface Radio { level: 'info' | 'err'; fields?: Record<string, string>; reason?: string; detail?: string; at: number }
interface Stats { accepted: number; rejected: number; gaps: number; restarts: number }

const CAP_TEXT: Record<CapName, string> = {
  messages: 'daily message cap',
  stream_minutes: 'daily stream-minutes cap',
  do_gb_seconds: 'daily Durable Object GB-s cap',
};

export class TapeRelay extends DurableObject<Env> {
  private readonly limits: Limits;
  private engine = new TapeEngine();
  private series = new MultiSeries(MAX_BARS);
  private usage: Usage;
  private lastSeq: number | null = null;
  private lastPacketAt: number | null = null;
  private stats: Stats = { accepted: 0, rejected: 0, gaps: 0, restarts: 0 };
  private radio: Radio | null = null;
  private uplink: UplinkState = 'down';
  /** start of the not-yet-accounted stretch of authenticated-uplink time */
  private streamSince: number | null = null;
  /** last DO event, for the active-time (GB-s) estimate; not persisted on purpose (hibernated time is free) */
  private lastEventAt: number | null = null;
  private dirty = false;
  private lastPersistAt = 0;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.limits = currentLimits(env);
    this.usage = freshUsage(Date.now());
    this.load(); // SQLite calls are synchronous: nothing runs before this finishes
  }

  // ------------------------------------------------------------------ storage (derived state only)

  private load(): void {
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS snap (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    const rows = new Map<string, unknown>();
    for (const r of sql.exec<{ k: string; v: string }>('SELECT k, v FROM snap')) {
      try { rows.set(r.k, JSON.parse(r.v)); } catch { /* ignore a corrupt row */ }
    }
    const now = Date.now();
    this.usage = reviveUsage(rows.get('usage'), now);
    const eng = rows.get('engine') as EngineState | undefined;
    if (eng && typeof eng.price === 'number' && eng.price > 0 && (eng.regime === 'expansion' || eng.regime === 'recession')) {
      this.engine = TapeEngine.from(eng);
    }
    for (const tf of TIMEFRAMES) {
      const bars = rows.get(`bars:${tf.id}`);
      if (Array.isArray(bars)) this.series.series[tf.id].bars.push(...(bars as Candle[]).slice(-MAX_BARS));
    }
    const meta = rows.get('meta') as { lastSeq?: number | null; lastPacketAt?: number | null; stats?: Stats; streamSince?: number | null; radio?: Radio | null } | undefined;
    if (meta) {
      this.lastSeq = typeof meta.lastSeq === 'number' ? meta.lastSeq : null;
      this.lastPacketAt = typeof meta.lastPacketAt === 'number' ? meta.lastPacketAt : null;
      if (meta.stats) this.stats = { ...this.stats, ...meta.stats };
      this.radio = meta.radio ?? null;
    }
    // Woken from hibernation with the uplink socket still open: it was silent (we persist on stall), so "stalled".
    if (this.activeUplink()) {
      this.uplink = 'stalled';
      this.streamSince = typeof meta?.streamSince === 'number' ? meta.streamSince : now;
    }
  }

  /** One transaction, ~8 rows. Called at most every 30 s while streaming, plus on stall/close/limit. */
  private persist(now: number): void {
    this.accountStream(now);
    const sql = this.ctx.storage.sql;
    const put = (k: string, v: unknown) => sql.exec('INSERT OR REPLACE INTO snap (k, v) VALUES (?, ?)', k, JSON.stringify(v));
    this.ctx.storage.transactionSync(() => {
      put('engine', this.engine.state());
      put('usage', this.usage);
      put('meta', { lastSeq: this.lastSeq, lastPacketAt: this.lastPacketAt, stats: this.stats, streamSince: this.streamSince, radio: this.radio });
      for (const tf of TIMEFRAMES) put(`bars:${tf.id}`, this.series.series[tf.id].bars);
    });
    this.lastPersistAt = now;
    this.dirty = false;
  }

  // ------------------------------------------------------------------ accounting

  /** Every DO event: day rollover + active-time estimate. */
  private touch(now: number): void {
    this.usage = rollover(this.usage, now);
    if (this.lastEventAt !== null) this.usage.activeMs += activeIncrement(now - this.lastEventAt);
    this.lastEventAt = now;
  }

  private accountStream(now: number): void {
    if (this.streamSince === null) return;
    this.usage.streamMs += Math.max(0, now - this.streamSince);
    this.streamSince = now;
  }

  // ------------------------------------------------------------------ helpers

  private viewers(): WebSocket[] { return this.ctx.getWebSockets('viewer'); }

  private activeUplink(): WebSocket | null {
    for (const ws of this.ctx.getWebSockets('uplink')) if ((ws.deserializeAttachment() as UplinkAtt | null)?.active) return ws;
    return null;
  }

  private broadcast(msg: unknown): void {
    const s = JSON.stringify(msg);
    for (const ws of this.viewers()) {
      try { ws.send(s); } catch { /* closing socket */ }
    }
  }

  private statusMessage(): string {
    if (!this.limits.online_enabled) return 'online mode is off';
    if (this.usage.limitReached) return 'daily limit reached';
    if (this.uplink === 'up') return 'live';
    if (this.uplink === 'stalled') return 'uplink silent: tape frozen';
    return 'uplink down: tape frozen';
  }

  private status() {
    return {
      online_enabled: this.limits.online_enabled,
      uplink: this.uplink,
      frozen: this.uplink !== 'up',
      message: this.statusMessage(),
      last_packet_at: this.lastPacketAt,
      last_seq: this.lastSeq,
      limit_reached: this.usage.limitReached,
      viewers: this.viewers().length,
      radio: this.radio,
    };
  }

  private broadcastStatus(): void { this.broadcast({ type: 'status', status: this.status() }); }

  private candles(): Record<Timeframe['id'], Candle[]> {
    return Object.fromEntries(TIMEFRAMES.map(tf => [tf.id, this.series.series[tf.id].bars.slice(-MAX_BARS)])) as Record<Timeframe['id'], Candle[]>;
  }

  private setUplink(s: UplinkState): void {
    if (this.uplink === s) return;
    this.uplink = s;
    this.broadcastStatus();
  }

  /** Refuses a socket with a final message and an application close code (4000-4999). */
  private refuse(text: string, code: number, reason: string): Response {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.send(text);
    server.close(code, reason);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ------------------------------------------------------------------ HTTP entry (called by the Worker)

  async fetch(req: Request): Promise<Response> {
    const now = Date.now();
    this.touch(now);
    const url = new URL(req.url);
    switch (url.pathname) {
      case '/api/state':
        return Response.json(this.stateJson(url.searchParams.get('candles') !== '0'), { headers: { 'cache-control': 'no-store' } });
      case '/api/tape':
        return this.acceptViewer(now);
      case '/api/ingest':
        return this.acceptUplink(now);
      default:
        return new Response('not found', { status: 404 });
    }
  }

  private stateJson(withCandles: boolean) {
    return {
      label: LABEL,
      online_enabled: this.limits.online_enabled,
      uplink_connected: this.activeUplink() !== null,
      status: this.status(),
      last_packet_at: this.lastPacketAt,
      engine: this.engine.state(),
      usage: usageReport(this.usage, this.limits),
      stats: this.stats,
      candles: withCandles ? this.candles() : undefined,
    };
  }

  private acceptViewer(now: number): Response {
    const statusJson = (message: string) => JSON.stringify({ type: 'status', status: { ...this.status(), message } });
    if (!this.limits.online_enabled) return this.refuse(statusJson('online mode is off'), 4003, 'online mode is off');
    const count = this.viewers().length;
    if (!viewerAllowed(count, this.limits)) return this.refuse(statusJson('viewer limit reached'), 4029, 'viewer limit reached');
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, ['viewer']);
    server.serializeAttachment({ role: 'viewer', since: now } satisfies ViewerAtt);
    if (count + 1 > this.usage.peakViewers) this.usage.peakViewers = count + 1;
    // Snapshot and later packets go out from this single-threaded object, so no packet can slip in between.
    server.send(JSON.stringify({
      type: 'snapshot', label: LABEL, server_time: now, engine: this.engine.state(), last_seq: this.lastSeq,
      candles: this.candles(), status: this.status(),
    }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private acceptUplink(now: number): Response {
    const why = uplinkRefusal(this.usage, this.limits, !!this.env.DEVICE_SECRET);
    if (why === 'offline') return this.refuse(toUplink.pause('offline'), 4003, 'online mode is off');
    if (why === 'not_configured') return this.refuse(toUplink.pause('not_configured'), 4001, 'relay has no DEVICE_SECRET');
    if (why === 'limit') return this.refuse(toUplink.pause('limit'), 4029, 'daily limit reached');
    if (this.ctx.getWebSockets('uplink').length >= MAX_UPLINK_SOCKETS) return this.refuse('GT1,REJECT,busy,-', 4009, 'uplink busy');
    const [client, server] = Object.values(new WebSocketPair());
    // A new uplink is a candidate until its first valid signed packet; only then does it replace the old one.
    this.ctx.acceptWebSocket(server, ['uplink']);
    server.serializeAttachment({ role: 'uplink', since: now, active: false, hello: false } satisfies UplinkAtt);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ------------------------------------------------------------------ WebSocket events (hibernation API)

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const now = Date.now();
    this.touch(now);
    const att = ws.deserializeAttachment() as Att | null;
    if (!att || att.role === 'viewer') {
      // Viewers are read-only. Every incoming message is billed, so count it and close the socket.
      this.usage.messages++;
      this.dirty = true;
      try { ws.close(1008, 'viewers are read-only'); } catch { /* already closed */ }
      return;
    }
    // Over a cap already? Count the (billed) message, then pause + close.
    const before = this.usage.limitReached ?? capReached(this.usage, this.limits);
    this.usage.messages++;
    this.dirty = true;
    if (before) return this.hitLimit(before, now);
    if (att.active) this.accountStream(now);

    if (typeof message !== 'string') {
      this.stats.rejected++;
      ws.send(toUplink.reject('binary', null));
    } else {
      const lines = splitMessage(message);
      if (lines === null) {
        this.stats.rejected++;
        ws.send(toUplink.reject('too_many_lines', null));
      } else {
        for (const line of lines) this.handleLine(ws, att, line, now);
      }
    }

    const after = capReached(this.usage, this.limits);
    if (after) this.hitLimit(after, now);
    else if (now - this.lastPersistAt >= PERSIST_EVERY_MS && this.dirty) this.persist(now);
  }

  private handleLine(ws: WebSocket, att: UplinkAtt, line: string, now: number): void {
    const l = classifyIngestLine(line);
    switch (l.kind) {
      case 'hello':
        // Arms a seq reset for this socket's next valid packet (device rebooted, seq restarts at 0).
        att.hello = true;
        ws.serializeAttachment(att);
        return;
      case 'info':
      case 'err':
        // Radio status is forwarded only from the authenticated uplink (a candidate could spoof it).
        if (!att.active) return;
        this.radio = l.kind === 'info' ? { level: 'info', fields: l.fields, at: now } : { level: 'err', reason: l.reason, detail: l.detail, at: now };
        this.dirty = true;
        this.broadcast({ type: 'radio', radio: this.radio });
        return;
      case 'unsigned':
        this.stats.rejected++;
        ws.send(toUplink.reject('unsigned', l.packet.seq));
        return;
      case 'malformed':
        this.stats.rejected++;
        ws.send(toUplink.reject('malformed', null));
        return;
      case 'signed':
        return this.handlePacket(ws, att, l.packet, l.mac, now);
    }
  }

  private handlePacket(ws: WebSocket, att: UplinkAtt, p: Packet, mac: string, now: number): void {
    const secret = this.env.DEVICE_SECRET;
    if (!secret) { ws.send(toUplink.pause('not_configured')); ws.close(4001, 'relay has no DEVICE_SECRET'); return; }
    if (!verifyPacketMac(secret, p, mac)) {
      this.stats.rejected++;
      ws.send(toUplink.reject('bad_mac', p.seq));
      return;
    }
    const d = decideSeq(this.lastSeq, p.seq as number, att.hello);
    if (!d.ok) {
      this.stats.rejected++;
      ws.send(toUplink.reject('seq_replay', p.seq));
      return;
    }
    if (!att.active) this.promote(ws, att, now);
    if (att.hello) { att.hello = false; ws.serializeAttachment(att); }
    if (d.kind === 'restart') {
      this.stats.restarts++;
      this.broadcast({ type: 'event', event: 'restart', seq: p.seq, message: 'ESP32 restarted (seq reset after HELLO)' });
    } else if (d.kind === 'gap') {
      this.stats.gaps += d.missing;
      this.broadcast({ type: 'event', event: 'gap', seq: p.seq, missing: d.missing, message: `${d.missing} packet(s) lost upstream` });
    }

    // Use the packet once, now: step the authoritative engine and broadcast. Nothing is queued.
    const tick: Tick = this.engine.step(p, now);
    this.series.add(tick);
    this.lastSeq = p.seq;
    this.lastPacketAt = now;
    this.stats.accepted++;
    this.dirty = true;
    this.broadcast({
      type: 'packet',
      packet: { seq: p.seq, a: p.a, b: p.b, c: p.c }, // the MAC is never forwarded (it would enable replays)
      time: now,
      tick: { price: tick.price, prevPrice: tick.prevPrice, regime: tick.regime, shift: tick.shift, index: tick.index },
    });
    this.setUplink('up');
    this.armStall();
  }

  /** First valid signed packet from a candidate socket: it becomes the uplink; any older one is closed. */
  private promote(ws: WebSocket, att: UplinkAtt, now: number): void {
    for (const other of this.ctx.getWebSockets('uplink')) {
      if (other === ws) continue;
      const oa = other.deserializeAttachment() as UplinkAtt | null;
      if (oa?.active) {
        oa.active = false;
        other.serializeAttachment(oa);
        try { other.close(4000, 'replaced by a newer uplink'); } catch { /* gone */ }
      }
    }
    att.active = true;
    ws.serializeAttachment(att);
    if (this.streamSince === null) this.streamSince = now;
  }

  private armStall(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const at = this.lastPacketAt;
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      if (this.lastPacketAt !== at || this.uplink !== 'up') return;
      this.setUplink('stalled');
      // Save before the object can hibernate and drop memory (viewers keep their copy; we must match it on wake).
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (this.lastPacketAt === at && this.dirty) this.persist(Date.now());
      }, IDLE_PERSIST_MS);
    }, STALL_MS);
  }

  private clearTimers(): void {
    if (this.stallTimer) { clearTimeout(this.stallTimer); this.stallTimer = null; }
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  private hitLimit(which: CapName, now: number): void {
    const first = this.usage.limitReached === null;
    this.usage.limitReached = which;
    for (const ws of this.ctx.getWebSockets('uplink')) {
      const a = ws.deserializeAttachment() as UplinkAtt | null;
      if (a) { a.active = false; ws.serializeAttachment(a); }
      try { ws.send(toUplink.pause('limit')); ws.close(4029, 'daily limit reached'); } catch { /* gone */ }
    }
    this.clearTimers();
    this.persist(now);
    this.streamSince = null;
    this.uplink = 'down';
    if (first) this.broadcast({ type: 'limit', cap: which, message: `daily limit reached (${CAP_TEXT[which]})` });
    this.broadcastStatus();
  }

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    this.onGone(ws, Date.now());
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closed'); } catch { /* already closed */ }
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.onGone(ws, Date.now());
  }

  private onGone(ws: WebSocket, now: number): void {
    this.touch(now);
    const att = ws.deserializeAttachment() as Att | null;
    if (att?.role !== 'uplink' || !att.active) return;
    att.active = false;
    ws.serializeAttachment(att);
    this.clearTimers();
    this.persist(now); // accounts stream time up to now
    this.streamSince = null;
    this.setUplink('down');
  }
}
