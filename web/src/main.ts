// GhostTape terminal: entropy source -> TapeEngine (one packet = one step) -> candles (1s..5m) -> chart + MT5 account.
import './styles.css';
import type { Overlay } from 'klinecharts';
import { LIMITS } from './config';
import { Account, type AccountState, type Deal, type Side } from './model/account';
import { MultiSeries, TIMEFRAMES, type Candle, type Timeframe } from './model/aggregator';
import { PRICE_DECIMALS, SINGLE_REGIME, TapeEngine, type EngineState, type Tick } from './model/engine';
import type { Packet } from './model/random';
import { cryptoPacket, DemoSource, PACKET_MS } from './entropy/demo';
import { SerialSource, webSerialSupported } from './entropy/serial';
import { RelayBridge, RelayViewer, type RelayStatus } from './entropy/relay';
import type { EntropySource, FeedState, SourceEvents } from './entropy/source';
import { TapeChart } from './chart/chart';
import { DEFAULT_INDICATORS, INDICATOR_CHOICES } from './chart/indicators';
import { hooks, type LineExt, type PosExt, type PositionKind } from './chart/overlays';
import { ToolRail } from './chart/tools';
import {
  $, clearRaw, pushRaw, renderAccount, renderFeed, renderHistory, renderJournal, renderOrderPrices,
  renderPositions, renderProof, renderQuote, setOrderMsg, toast, usd,
} from './ui/terminal';

const T = LIMITS.trading;
const SESSION_KEY = 'gt.session.v2'; // v2: GBP/JPY-like preset (start 190, k = 1.4M)
const PREFS_KEY = 'gt.prefs.v1';
const DEMO_HISTORY_MIN = 360;  // instant labelled demo history (6 h) so every timeframe has bars in demo mode
const MAX_BARS = 1500;

type Mode = 'demo' | 'esp32' | 'online';
interface SavedSession {
  mode: Mode;
  savedAt: number;
  startPrice: number;
  engine: EngineState;
  bars: Record<Timeframe['id'], Candle[]>;
  account: AccountState;
  drawings: { name: string; points: Overlay['points']; extendData: unknown }[];
}

const storage = {
  get<T>(k: string): T | null { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : null; } catch { return null; } },
  set(k: string, v: unknown): void { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked: session just won't persist */ } },
};

// ---------------------------------------------------------------- state
let mode: Mode = 'demo';
let engine = new TapeEngine();
let series = new MultiSeries(MAX_BARS);
let account = new Account(T);
let startPrice = engine.price;
let feedState: FeedState = 'demo';
let source: EntropySource | null = null;
let serialSrc: SerialSource | null = null;
let viewer: RelayViewer | null = null;
let bridge: RelayBridge | null = null;
let radio = 'not reported yet';
let packets = 0;
let rateWindow: number[] = [];
const prefs = storage.get<{ tf: Timeframe['id']; indicators: string[] }>(PREFS_KEY) ?? { tf: '1s', indicators: DEFAULT_INDICATORS };
/** ticket -> overlay ids (price lines, or the linked position box) */
const linked = new Map<number, { lines: string[]; box?: string }>();

const tape = new TapeChart($('chart'), tf => series.series[tf].bars, prefs.tf);
const mid = (): number => engine.price;
const tapeLive = (): boolean => mode === 'demo' || feedState === 'live';
const modeLabel = (): string => ({ demo: 'demo', esp32: 'ESP32', online: 'online relay' })[mode];

// ---------------------------------------------------------------- journal helpers
const log = (kind: Parameters<Account['log']>[1], text: string): void => { account.log(Date.now(), kind, text); scheduleRender(true); };

// ---------------------------------------------------------------- tick pipeline
function onPacket(p: Packet): void {
  const t = engine.step(p, Date.now());
  packets++;
  rateWindow.push(performance.now());
  pushRaw(p);
  applyTick(t, true);
}

function applyTick(t: Tick, live: boolean): void {
  const updates = series.add(t);
  if (live) for (const tf of TIMEFRAMES) {
    for (const g of updates[tf.id].gapBars) tape.push(tf.id, g); // keep the real-time gap visible
    tape.push(tf.id, updates[tf.id].bar);
  }
  if (t.shift) {
    const src = mode === 'demo' ? 'demo' : 'ESP32';
    account.log(t.time, 'regime', `⚡ regime shift ${t.shift.from} → ${t.shift.to} (rate ${t.shift.rate.toFixed(1)}%, ${src} roll)`);
  }
  const closed = account.onPrice(t.price, t.time);
  for (const d of closed) onDealClosed(d);
  if (live) scheduleRender(closed.length > 0 || !!t.shift);
}

// ---------------------------------------------------------------- rendering (coalesced to one frame)
let renderQueued = false;
let heavyQueued = false;
function scheduleRender(heavy = false): void {
  heavyQueued ||= heavy;
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const m = mid();
    renderQuote(m, startPrice);
    renderAccount(account, account.snapshot(m), T.stop_out_level_pct);
    renderPositions(account, m);
    const lots = readLots();
    renderOrderPrices(account.bid(m), account.ask(m), lots === null ? 0 : account.requiredMargin('buy', lots, m), tapeLive());
    if (heavyQueued) { renderHistory(account.history); renderJournal(account.journal); heavyQueued = false; }
    renderStats();
  });
}

function renderStats(): void {
  const now = performance.now();
  rateWindow = rateWindow.filter(x => now - x < 5000);
  const rate = rateWindow.length / 5;
  const ago = serialSrc && serialSrc.lastPacketAt ? Math.round(now - serialSrc.lastPacketAt) : null;
  $('feedStats').textContent = `${packets.toLocaleString('en-US')} packets · ${rate.toFixed(1)}/s` +
    (mode === 'esp32' && serialSrc ? ` · ${serialSrc.seq.gaps} gaps` : '');
  const sigma = SINGLE_REGIME.sigma / Math.sqrt(engine.timeScale);
  renderProof({
    source: mode, packets, gaps: serialSrc?.seq.gaps ?? 0, restarts: serialSrc?.seq.restarts ?? 0, rate, lastAgoMs: mode === 'esp32' ? ago : null,
    radio, mu: 0, sigma,
    barTicks: series.series[tape.tf].last()?.ticks ?? 0, tf: tape.tf,
  });
}
setInterval(renderStats, 500);

// ---------------------------------------------------------------- sessions
function resetState(newMode: Mode): void {
  mode = newMode;
  engine = new TapeEngine(); // rate fixed at the default 5% (slider removed, Praveen 2026-10-05)
  series = new MultiSeries(MAX_BARS);
  account = new Account(T);
  startPrice = engine.price;
  packets = 0;
  rateWindow = [];
  linked.clear();
  clearRaw();
  tape.chart.removeOverlay();
}

function newSession(newMode: Mode): void {
  resetState(newMode);
  if (newMode === 'demo') {
    // Labelled demo history from browser crypto, back-dated so every timeframe has bars to look at.
    const n = Math.round((DEMO_HISTORY_MIN * 60000) / PACKET_MS);
    const t0 = Date.now() - n * PACKET_MS;
    for (let i = 0; i < n; i++) applyTick(engine.step(cryptoPacket(), t0 + i * PACKET_MS), false);
    startPrice = series.series['5m'].bars[0]?.open ?? 100;
    account.log(Date.now(), 'entropy', `New DEMO session: ${DEMO_HISTORY_MIN} min of instant history from browser entropy (not hardware)`);
  } else if (newMode === 'esp32') {
    account.log(Date.now(), 'entropy', 'New ESP32 session: every candle from here comes from the chip\'s radio-verified hardware noise');
  }
  tape.reload();
  scheduleRender(true);
  saveSession();
}

function saveSession(): void {
  const bars = Object.fromEntries(TIMEFRAMES.map(tf => [tf.id, series.series[tf.id].bars.slice(-600)])) as SavedSession['bars'];
  const drawings = tape.chart.getOverlays().filter(o => o.name !== 'gtPriceLine' && (o.name.endsWith('Position') ? (o.extendData as PosExt).state !== 'live' : true))
    .map(o => ({ name: o.name, points: o.points, extendData: o.extendData }));
  storage.set(SESSION_KEY, { mode, savedAt: Date.now(), startPrice, engine: engine.state(), bars, account: account.state(), drawings } satisfies SavedSession);
}
setInterval(saveSession, 5000);
addEventListener('pagehide', saveSession);

function restoreSession(s: SavedSession): void {
  resetState(s.mode);
  engine = TapeEngine.from(s.engine);
  for (const tf of TIMEFRAMES) series.series[tf.id].bars.push(...(s.bars[tf.id] ?? []));
  account = new Account(T, s.account);
  startPrice = s.startPrice;
  tape.reload();
  for (const p of account.positions) drawPositionLines(p.ticket);
  for (const d of s.drawings) tape.chart.createOverlay({ name: d.name, points: d.points, extendData: d.extendData });
  account.log(Date.now(), 'info', `Session restored (${modeLabel()}), resuming from ${pf(engine.price)}`);
}

// ---------------------------------------------------------------- entropy sources
const events: SourceEvents = {
  packet: p => { if (mode !== 'online') onPacket(p); },
  state: (s, msg) => {
    const was = feedState;
    feedState = s;
    renderFeed(s, msg);
    if (s === 'offline' && was !== 'offline') log('entropy-bad', `entropy lost, tape frozen at ${pf(engine.price)}`);
    if (s === 'live' && (was === 'offline' || was === 'waiting' || was === 'radio_error')) log('entropy', `ESP32 packets flowing${was === 'offline' ? `, resuming from ${pf(engine.price)}` : ''}`);
    scheduleRender();
  },
  status: (kind, detail, fields) => {
    if (kind === 'info') { radio = `verified on · sleep ${fields?.ps ?? '?'} · ${fields?.aps ?? '?'} Wi-Fi networks heard · up ${fields?.up ?? '?'} s`; }
    if (kind === 'err') radio = `NOT verified: ${detail}`;
    const k = kind === 'err' || kind === 'gap' ? 'entropy-bad' : 'entropy';
    const routineRecheck = kind === 'info' && Number(fields?.up ?? 0) >= 30; // the 30 s re-checks update the proof panel only
    if (!routineRecheck) log(k, `ESP32 ${kind}: ${detail}`);
  },
};

function stopOnline(): void {
  viewer?.stop();
  viewer = null;
  bridge?.stop();
  bridge = null;
}

async function useDemo(): Promise<void> {
  stopOnline();
  source?.stop();
  serialSrc = null;
  $('btnBridge').hidden = true;
  source = new DemoSource(events);
  newSession('demo');
  await source.start();
}

async function connectEsp32(): Promise<void> {
  if (!webSerialSupported()) {
    renderFeed(feedState, 'Web Serial is not available here. Open GhostTape in desktop Chrome or Edge (served from localhost or https).');
    return;
  }
  const next = new SerialSource(events);
  try {
    await next.start(); // shows the browser's port picker
  } catch (e) {
    renderFeed(feedState, `Could not open the ESP32: ${(e as Error).message}. Pick the board's COM port and close any serial monitor holding it.`);
    return;
  }
  stopOnline();
  source?.stop();
  source = serialSrc = next;
  $('btnBridge').hidden = false;
  const saved = storage.get<SavedSession>(SESSION_KEY);
  if (mode === 'esp32' && saved?.mode === 'esp32') log('entropy', 'ESP32 reconnected to the existing ESP32 session');
  else newSession('esp32');
}

// ---------------------------------------------------------------- online relay (viewer + USB bridge)

function relayFeed(s: RelayStatus): void {
  const live = s.online_enabled && s.uplink === 'up' && !s.frozen;
  feedState = live ? 'live' : 'offline';
  renderFeed(feedState, live ? '' : `Online relay: ${s.message}${s.online_enabled ? '' : ' (the owner switches it on in limits.jsonc)'}.`);
  scheduleRender();
}

/** Watch the shared online tape. keepSerial = this browser is also the USB bridge. */
function useOnline(keepSerial = false): void {
  viewer?.stop();
  viewer = null;
  if (!keepSerial) { bridge?.stop(); bridge = null; source?.stop(); source = null; serialSrc = null; $('btnBridge').hidden = true; }
  else if (source && source !== serialSrc) source.stop();
  resetState('online');
  tape.reload();
  feedState = 'waiting';
  renderFeed('waiting', 'Connecting to the online relay…');
  viewer = new RelayViewer({
    snapshot: s => {
      resetState('online');
      engine = TapeEngine.from(s.engine);
      for (const tf of TIMEFRAMES) series.series[tf.id].bars.push(...(s.candles[tf.id] ?? []));
      startPrice = series.series['5m'].bars[0]?.open ?? engine.price;
      tape.reload();
      account.log(Date.now(), 'entropy', `Joined the online relay tape at ${pf(engine.price)} (shared by every viewer)`);
      relayFeed(s.status);
      scheduleRender(true);
    },
    packet: (p, time, relayTick) => {
      const t = engine.step(p, time);
      if (Math.abs(t.price - relayTick.price) > 1e-9) log('entropy-bad', 'this viewer drifted from the relay tape');
      packets++;
      rateWindow.push(performance.now());
      pushRaw(p);
      if (feedState !== 'live') { feedState = 'live'; renderFeed('live', ''); }
      applyTick(t, true);
    },
    status: relayFeed,
    info: (text, bad) => {
      if (bad && text.includes('frozen')) { feedState = 'offline'; renderFeed('offline', `Online relay: ${text}.`); }
      log(bad ? 'entropy-bad' : 'entropy', text);
    },
    closed: reason => { feedState = 'offline'; renderFeed('offline', `Online relay closed: ${reason}.`); scheduleRender(); },
  });
  viewer.start();
}

/** This browser forwards its USB ESP32's signed lines to the relay and then watches the shared tape. */
function shareOnline(): void {
  if (!serialSrc) return;
  bridge?.stop();
  const b = new RelayBridge((text, bad, fatal) => {
    log(bad ? 'entropy-bad' : 'entropy', text);
    if (fatal && serialSrc) serialSrc.onLine = null;
  });
  bridge = b;
  serialSrc.onLine = line => b.forward(line);
  b.start();
  useOnline(true);
}

// ---------------------------------------------------------------- orders from the ticket
function readLots(): number | null {
  const v = Number($<HTMLInputElement>('lots').value);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}
const readStop = (id: string): number | null => {
  const raw = $<HTMLInputElement>(id).value.trim();
  return raw === '' ? null : Number(raw);
};

function placeOrder(side: Side): void {
  if (!tapeLive()) { setOrderMsg('The tape is frozen. Orders need a live price, so reconnect the ESP32 first.'); return; }
  const lots = readLots();
  if (lots === null) { setOrderMsg('Enter a volume in lots.'); return; }
  const r = account.open(side, lots, { sl: readStop('sl'), tp: readStop('tp') }, mid(), Date.now());
  if (!r.ok) { setOrderMsg(r.error); scheduleRender(true); return; }
  setOrderMsg(`#${r.value.ticket} ${side.toUpperCase()} ${lots.toFixed(2)} @ ${pf(r.value.openPrice)}`, true);
  $<HTMLInputElement>('sl').value = '';
  $<HTMLInputElement>('tp').value = '';
  drawPositionLines(r.value.ticket);
  scheduleRender(true);
}

function drawPositionLines(ticket: number): void {
  const p = account.positions.find(x => x.ticket === ticket);
  if (!p) return;
  const lastTs = series.series[tape.tf].last()?.timestamp ?? Date.now();
  const mk = (kind: LineExt['kind'], value: number): string =>
    tape.chart.createOverlay({ name: 'gtPriceLine', lock: kind === 'entry', points: [{ timestamp: lastTs, value }], extendData: { ticket, kind, side: p.side } satisfies LineExt }) as string;
  const lines = [mk('entry', p.openPrice)];
  if (p.sl !== null) lines.push(mk('sl', p.sl));
  if (p.tp !== null) lines.push(mk('tp', p.tp));
  linked.set(ticket, { ...linked.get(ticket), lines });
}

function removeLines(ticket: number): void {
  for (const id of linked.get(ticket)?.lines ?? []) tape.chart.removeOverlay({ id });
  const l = linked.get(ticket);
  if (l) l.lines = [];
}

function onDealClosed(d: Deal): void {
  removeLines(d.ticket);
  const box = linked.get(d.ticket)?.box;
  if (box) {
    const o = tape.chart.getOverlays({ id: box })[0] as Overlay<PosExt> | undefined;
    const what = { manual: 'Closed', sl: 'Stop hit', tp: 'Target hit', stopout: 'Stopped out' }[d.reason];
    if (o) tape.chart.overrideOverlay({ id: box, lock: true, extendData: { ...o.extendData, state: 'closed', result: `#${d.ticket} ${what} @ ${pf(d.closePrice)} · ${usd(d.pnl, true)}` } });
  }
  linked.delete(d.ticket);
  if (d.reason !== 'manual') toast(`${d.reason === 'tp' ? 'Take profit' : d.reason === 'sl' ? 'Stop loss' : 'Stop out'} #${d.ticket}: ${usd(d.pnl, true)}${d.level !== null ? ` (slippage ${d.slippage.toFixed(4)})` : ''}`);
}

function closeTicket(ticket: number): void {
  const r = account.close(ticket, mid(), Date.now());
  if (r.ok) onDealClosed(r.value);
  scheduleRender(true);
}

// ---------------------------------------------------------------- position boxes (Long / Short Position tools)
let selectedBox: string | null = null;

function boxPrices(o: Overlay<PosExt>): { entry: number; target: number; stop: number } {
  return { entry: o.points[0].value!, target: o.points[1].value!, stop: o.points[2].value! };
}

hooks.mid = () => engine.price;
hooks.contract = () => T.contract_size;

hooks.onPositionDrawn = o => {
  rail.done();
  const p0 = o.points[0];
  const entry = p0.value!;
  const dir = o.name === 'longPosition' ? 1 : -1;
  const bars = 25, step = tape.periodMs();
  const right = { timestamp: (p0.timestamp ?? Date.now()) + bars * step, dataIndex: (p0.dataIndex ?? 0) + bars };
  // size the box from the recent range (like TradingView), stop = 1 unit, target = 2 units (R:R 2)
  const recent = series.series[tape.tf].bars.slice(-120);
  const span = recent.length ? Math.max(...recent.map(b => b.high)) - Math.min(...recent.map(b => b.low)) : entry * 0.02;
  const d = Math.max(0.05, span * 0.12); // at least 5 pips
  tape.chart.overrideOverlay({
    id: o.id,
    points: [p0, { ...right, value: entry + dir * 2 * d }, { ...right, value: entry - dir * d }],
    extendData: { state: 'plan', lots: readLots() ?? 0.1 } satisfies PosExt,
  });
  showBoxAction(o.id);
};

hooks.onPositionSelected = o => {
  if (o) showBoxAction(o.id);
  else setTimeout(() => { if (!$('boxAction').matches(':hover')) hideBoxAction(); }, 150);
};

hooks.onPositionMoved = o => {
  const ext = o.extendData;
  if (ext.state === 'live' && ext.ticket !== undefined) {
    const pos = account.positions.find(p => p.ticket === ext.ticket);
    if (pos) {
      const { target, stop } = boxPrices(o);
      const r = account.modify(pos.ticket, { sl: roundPx(stop), tp: roundPx(target) }, mid(), Date.now());
      if (!r.ok) toast(r.error);
      // the entry is where the order filled; keep it there whatever was dragged
      const p = o.points;
      tape.chart.overrideOverlay({ id: o.id, points: [{ ...p[0], value: pos.openPrice }, { ...p[1], value: pos.tp ?? p[1].value }, { ...p[2], value: pos.sl ?? p[2].value }] });
      scheduleRender(true);
    }
  }
  if (selectedBox === o.id) showBoxAction(o.id);
};

hooks.onLineMoved = o => {
  const { ticket, kind } = o.extendData;
  const pos = account.positions.find(p => p.ticket === ticket);
  if (!pos || kind === 'entry') return;
  const v = roundPx(o.points[0].value!);
  const r = account.modify(ticket, { sl: kind === 'sl' ? v : pos.sl, tp: kind === 'tp' ? v : pos.tp }, mid(), Date.now());
  if (!r.ok) toast(r.error);
  tape.chart.overrideOverlay({ id: o.id, points: [{ ...o.points[0], value: kind === 'sl' ? pos.sl! : pos.tp! }] });
  scheduleRender(true);
};

const round2 = (v: number): number => Math.round(v * 100) / 100;
const roundPx = (v: number): number => Number(v.toFixed(PRICE_DECIMALS));
const pf = (v: number): string => v.toFixed(PRICE_DECIMALS);

function showBoxAction(id: string): void {
  const o = tape.chart.getOverlays({ id })[0] as Overlay<PosExt> | undefined;
  if (!o || o.points.length < 3) return;
  selectedBox = id;
  const el = $('boxAction');
  const ext = o.extendData;
  const kind = o.name as PositionKind;
  const side: Side = kind === 'longPosition' ? 'buy' : 'sell';
  const { entry, target, stop } = boxPrices(o);
  const rr = Math.abs(target - entry) / Math.max(1e-9, Math.abs(entry - stop));
  if (ext.state === 'plan') {
    el.innerHTML = `<span>${side === 'buy' ? 'Long' : 'Short'} · SL <b>${pf(stop)}</b> · TP <b>${pf(target)}</b> · R:R <b>${rr.toFixed(2)}</b></span>` +
      `<label>Lots <input id="boxLots" class="mono" type="number" min="${T.min_lots}" max="${T.max_lots}" step="0.01" value="${ext.lots.toFixed(2)}" style="width:64px"></label>` +
      `<button type="button" class="place ${side}" data-act="place">Place ${side.toUpperCase()} at market</button>` +
      `<button type="button" class="ghost" data-act="delete">Delete</button>`;
  } else if (ext.state === 'live') {
    el.innerHTML = `<span><b>#${ext.ticket}</b> live · drag the stop or target edge to modify SL/TP</span>` +
      `<button type="button" class="ghost" data-act="close">Close position</button>`;
  } else {
    el.innerHTML = `<span>${ext.result ?? 'Closed'}</span><button type="button" class="ghost" data-act="delete">Remove</button>`;
  }
  el.hidden = false;
  el.onclick = e => {
    const act = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]')?.dataset.act;
    if (act === 'delete') { tape.chart.removeOverlay({ id }); hideBoxAction(); }
    if (act === 'close' && ext.ticket !== undefined) { closeTicket(ext.ticket); hideBoxAction(); }
    if (act === 'place') placeFromBox(o, side);
  };
  el.oninput = e => {
    const t = e.target as HTMLInputElement;
    if (t.id === 'boxLots' && Number.isFinite(Number(t.value))) tape.chart.overrideOverlay({ id, extendData: { ...ext, lots: round2(Number(t.value)) } });
  };
}

function hideBoxAction(): void {
  $('boxAction').hidden = true;
  selectedBox = null;
}

function placeFromBox(o: Overlay<PosExt>, side: Side): void {
  if (!tapeLive()) { toast('The tape is frozen. Reconnect the ESP32 first.'); return; }
  const fresh = tape.chart.getOverlays({ id: o.id })[0] as Overlay<PosExt>;
  const { target, stop } = boxPrices(fresh);
  const r = account.open(side, fresh.extendData.lots, { sl: roundPx(stop), tp: roundPx(target) }, mid(), Date.now());
  if (!r.ok) { toast(r.error); scheduleRender(true); return; }
  const data = tape.chart.getDataList();
  const last = data[data.length - 1];
  const p = fresh.points;
  const minRight = (data.length - 1) + 15;
  const right = (p[1].dataIndex ?? 0) < minRight ? { dataIndex: minRight, timestamp: last.timestamp + 15 * tape.periodMs() } : { dataIndex: p[1].dataIndex, timestamp: p[1].timestamp };
  tape.chart.overrideOverlay({
    id: o.id,
    points: [{ timestamp: last.timestamp, dataIndex: data.length - 1, value: r.value.openPrice }, { ...right, value: r.value.tp! }, { ...right, value: r.value.sl! }],
    extendData: { state: 'live', ticket: r.value.ticket, lots: r.value.lots } satisfies PosExt,
  });
  linked.set(r.value.ticket, { lines: [], box: o.id });
  toast(`#${r.value.ticket} ${side.toUpperCase()} ${r.value.lots.toFixed(2)} @ ${pf(r.value.openPrice)} · SL ${pf(r.value.sl!)} · TP ${pf(r.value.tp!)}`);
  showBoxAction(o.id);
  scheduleRender(true);
}

// ---------------------------------------------------------------- toolbar wiring
const rail = new ToolRail($('toolrail'), $('favbar'), tape.chart,
  kind => tape.chart.createOverlay({ name: kind, extendData: { state: 'plan', lots: readLots() ?? 0.1 } satisfies PosExt }),
  () => {
    for (const o of tape.chart.getOverlays()) {
      const live = o.name === 'gtPriceLine' || (o.name.endsWith('Position') && (o.extendData as PosExt).state === 'live');
      if (!live) tape.chart.removeOverlay({ id: o.id });
    }
    hideBoxAction();
  });

$('timeframes').innerHTML = TIMEFRAMES.map(tf => `<button type="button" class="tbtn${tf.id === prefs.tf ? ' active' : ''}" data-tf="${tf.id}">${tf.id}</button>`).join('');
$('timeframes').onclick = e => {
  const tf = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-tf]')?.dataset.tf as Timeframe['id'] | undefined;
  if (!tf) return;
  tape.setTimeframe(tf);
  prefs.tf = tf;
  storage.set(PREFS_KEY, prefs);
  for (const b of $('timeframes').querySelectorAll<HTMLButtonElement>('[data-tf]')) b.classList.toggle('active', b.dataset.tf === tf);
};

// ---------------------------------------------------------------- Indicators dialog (search, groups, add/remove)
const GROUPS = ['All', 'Added', 'Trend', 'Volatility', 'Momentum', 'Volume'] as const;
let indGroup: (typeof GROUPS)[number] = 'All';
const dialog = $('indDialog');
const savePrefs = (): void => storage.set(PREFS_KEY, prefs);
function setIndicatorPref(name: string, on: boolean): void {
  prefs.indicators = on ? [...new Set([...prefs.indicators, name])] : prefs.indicators.filter(n => n !== name);
  savePrefs();
}
function renderIndicatorList(): void {
  const q = $<HTMLInputElement>('indSearch').value.trim().toLowerCase();
  $('indGroups').innerHTML = GROUPS.map(g => `<button type="button" data-g="${g}" class="${g === indGroup ? 'active' : ''}">${g}${g === 'Added' ? ` (${prefs.indicators.length})` : ''}</button>`).join('');
  const rows = INDICATOR_CHOICES.filter(c =>
    (indGroup === 'All' || (indGroup === 'Added' ? prefs.indicators.includes(c.name) : c.group === indGroup)) &&
    (!q || `${c.name} ${c.label} ${c.about}`.toLowerCase().includes(q)));
  $('indList').innerHTML = rows.map(c => {
    const on = prefs.indicators.includes(c.name);
    return `<li role="option" tabindex="0" aria-selected="${on}" data-ind="${c.name}" class="${on ? 'on' : ''}"><div><div class="ind-name">${c.label}</div><div class="ind-about">${c.about}</div></div>` +
      `<div class="ind-meta"><span class="ind-pane">${c.pane === 'main' ? 'on chart' : 'new pane'}</span><span class="ind-add">${on ? 'Remove' : 'Add'}</span></div></li>`;
  }).join('') || '<li class="empty">No indicators match.</li>';
}
function toggleIndicator(name: string): void {
  const on = !prefs.indicators.includes(name);
  tape.setIndicator(name, on);
  setIndicatorPref(name, on);
  renderIndicatorList();
}
function openIndicators(): void {
  dialog.hidden = false;
  $<HTMLInputElement>('indSearch').value = '';
  renderIndicatorList();
  $<HTMLInputElement>('indSearch').focus();
}
const closeIndicators = (): void => { dialog.hidden = true; $('btnIndicators').focus(); };
$('btnIndicators').onclick = openIndicators;
$('indClose').onclick = closeIndicators;
dialog.onclick = e => { if (e.target === dialog) closeIndicators(); };
dialog.onkeydown = e => {
  if (e.key === 'Escape') closeIndicators();
  const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-ind]');
  if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleIndicator(li.dataset.ind!); }
};
$('indSearch').oninput = renderIndicatorList;
$('indGroups').onclick = e => {
  const g = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-g]')?.dataset.g as (typeof GROUPS)[number] | undefined;
  if (g) { indGroup = g; renderIndicatorList(); }
};
$('indList').onclick = e => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-ind]');
  if (li) toggleIndicator(li.dataset.ind!);
};
tape.onIndicatorRemoved = name => { setIndicatorPref(name, false); if (!dialog.hidden) renderIndicatorList(); };
for (const name of prefs.indicators) tape.setIndicator(name, true);

// TRNG switch: OFF = browser randomness (demo), ON = ESP32 hardware over USB (online relay if this browser has no Web Serial)
const trng = $<HTMLInputElement>('trngSwitch');
function syncTrngSwitch(): void {
  trng.checked = mode !== 'demo';
  $('trngState').textContent = mode === 'demo' ? 'off · browser' : mode === 'online' ? 'on · online ESP32' : 'on · ESP32';
}
/** Is the owner's ESP32 streaming to the online relay right now? (one Worker request; false on any error) */
async function onlineLive(): Promise<boolean> {
  try {
    const s = await (await fetch('/api/state?candles=0', { cache: 'no-store' })).json() as { online_enabled?: boolean; uplink_connected?: boolean };
    return !!(s.online_enabled && s.uplink_connected);
  } catch { return false; }
}
// ON: the shared live ESP32 tape if it is streaming, otherwise an ESP32 plugged into this computer (Web Serial).
trng.onchange = async () => {
  if (trng.checked) {
    if (await onlineLive()) useOnline();
    else if (webSerialSupported()) await connectEsp32();
    else useOnline(); // shows "online mode is off" / "uplink down" honestly
  } else {
    await useDemo();
  }
  syncTrngSwitch(); // a cancelled port picker leaves the tape in demo mode, so the switch flips back off
};
setInterval(syncTrngSwitch, 1000);
// Tell visitors when the real chip is live (one request per page load).
void onlineLive().then(live => {
  if (live && mode === 'demo') renderFeed('demo', 'The real ESP32 hardware tape is streaming right now: flip TRNG on to watch it live.');
});
$('btnOnline').onclick = () => { useOnline(); syncTrngSwitch(); };
$('btnBridge').onclick = () => shareOnline();
$('btnProof').onclick = () => {
  const p = $('proof');
  p.hidden = !p.hidden;
  $('btnProof').setAttribute('aria-expanded', String(!p.hidden));
  renderStats();
};
$('btnBuy').onclick = () => placeOrder('buy');
$('btnSell').onclick = () => placeOrder('sell');
const stepLots = (d: number): void => {
  const v = Math.min(T.max_lots, Math.max(T.min_lots, round2((readLots() ?? 0.1) + d)));
  $<HTMLInputElement>('lots').value = v.toFixed(2);
  scheduleRender();
};
$('lotsUp').onclick = () => stepLots(0.01);
$('lotsDown').onclick = () => stepLots(-0.01);
$('lots').oninput = () => scheduleRender();
$('leverage').textContent = `1:${T.leverage}`;
$('spread').textContent = pf(T.spread);
$('btnReset').onclick = () => {
  for (const p of account.positions) { removeLines(p.ticket); const b = linked.get(p.ticket)?.box; if (b) tape.chart.removeOverlay({ id: b }); }
  linked.clear();
  account.reset(Date.now());
  setOrderMsg('');
  scheduleRender(true);
};
$('tab-trade').onclick = e => {
  const t = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-close]')?.dataset.close;
  if (t) closeTicket(Number(t));
};
for (const tab of document.querySelectorAll<HTMLButtonElement>('.tab')) {
  tab.onclick = () => {
    for (const t of document.querySelectorAll<HTMLButtonElement>('.tab')) { t.classList.toggle('active', t === tab); t.setAttribute('aria-selected', String(t === tab)); }
    for (const id of ['trade', 'history', 'journal']) $(`tab-${id}`).hidden = id !== tab.dataset.tab;
  };
}

// ---------------------------------------------------------------- boot
const saved = storage.get<SavedSession>(SESSION_KEY);
if (saved && saved.engine && Date.now() - saved.savedAt < 12 * 3600_000) {
  restoreSession(saved);
  if (saved.mode === 'demo') {
    source = new DemoSource(events);
    void source.start();
  } else {
    feedState = 'offline';
    renderFeed('offline', 'Your ESP32 session was restored but is frozen: no entropy until you press Connect ESP32. Demo entropy starts a new session.');
  }
  scheduleRender(true);
} else {
  void useDemo();
}

// dev-only handle for automated browser checks (stripped from production builds)
if (import.meta.env.DEV) Object.assign(window, { __gt: { tape, get engine() { return engine; }, get account() { return account; } } });
