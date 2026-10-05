// GhostTape terminal: entropy source -> TapeEngine (one packet = one step) -> candles (1s..5m) -> chart + MT5 account.
import './styles.css';
import type { Overlay } from 'klinecharts';
import { LIMITS } from './config';
import { Account, type AccountState, type Deal, type Side } from './model/account';
import { MultiSeries, TIMEFRAMES, type Candle, type Timeframe } from './model/aggregator';
import { TapeEngine, type EngineState, type Tick } from './model/engine';
import { REGIMES } from './model/regime';
import type { Packet } from './model/random';
import { cryptoPacket, DemoSource, PACKET_MS } from './entropy/demo';
import { SerialSource, webSerialSupported } from './entropy/serial';
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
const SESSION_KEY = 'gt.session.v1';
const PREFS_KEY = 'gt.prefs.v1';
const DEMO_HISTORY_MIN = 30;   // instant labelled demo history so the chart isn't empty in demo mode
const MAX_BARS = 1500;

type Mode = 'demo' | 'esp32';
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
let radio = 'not reported yet';
let packets = 0;
let rateWindow: number[] = [];
const prefs = storage.get<{ tf: Timeframe['id']; indicators: string[] }>(PREFS_KEY) ?? { tf: '1s', indicators: DEFAULT_INDICATORS };
/** ticket -> overlay ids (price lines, or the linked position box) */
const linked = new Map<number, { lines: string[]; box?: string }>();

const tape = new TapeChart($('chart'), tf => series.series[tf].bars, prefs.tf);
const mid = (): number => engine.price;
const tapeLive = (): boolean => mode === 'demo' || feedState === 'live';

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
  if (live) for (const tf of TIMEFRAMES) tape.push(tf.id, updates[tf.id].bar);
  if (t.shift) {
    const src = mode === 'esp32' ? 'ESP32' : 'demo';
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
    renderQuote(m, startPrice, engine.regime);
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
  const r = REGIMES[engine.regime];
  renderProof({
    source: mode, packets, gaps: serialSrc?.seq.gaps ?? 0, restarts: serialSrc?.seq.restarts ?? 0, rate, lastAgoMs: mode === 'esp32' ? ago : null,
    radio, regime: engine.regime, mu: r.mu, sigma: r.sigma, centralRate: engine.rate,
    barTicks: series.series[tape.tf].last()?.ticks ?? 0, tf: tape.tf,
  });
}
setInterval(renderStats, 500);

// ---------------------------------------------------------------- sessions
function resetState(newMode: Mode): void {
  mode = newMode;
  engine = new TapeEngine({ rate: Number($<HTMLInputElement>('rate').value) });
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
  } else {
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
  account.log(Date.now(), 'info', `Session restored (${s.mode === 'esp32' ? 'ESP32' : 'demo'}), resuming from ${engine.price.toFixed(2)}`);
}

// ---------------------------------------------------------------- entropy sources
const events: SourceEvents = {
  packet: onPacket,
  state: (s, msg) => {
    const was = feedState;
    feedState = s;
    renderFeed(s, msg);
    if (s === 'offline' && was !== 'offline') log('entropy-bad', `entropy lost, tape frozen at ${engine.price.toFixed(2)}`);
    if (s === 'live' && (was === 'offline' || was === 'waiting' || was === 'radio_error')) log('entropy', `ESP32 packets flowing${was === 'offline' ? `, resuming from ${engine.price.toFixed(2)}` : ''}`);
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

async function useDemo(): Promise<void> {
  source?.stop();
  serialSrc = null;
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
  source?.stop();
  source = serialSrc = next;
  const saved = storage.get<SavedSession>(SESSION_KEY);
  if (mode === 'esp32' && saved?.mode === 'esp32') log('entropy', 'ESP32 reconnected to the existing ESP32 session');
  else newSession('esp32');
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
  setOrderMsg(`#${r.value.ticket} ${side.toUpperCase()} ${lots.toFixed(2)} @ ${r.value.openPrice.toFixed(2)}`, true);
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
    if (o) tape.chart.overrideOverlay({ id: box, lock: true, extendData: { ...o.extendData, state: 'closed', result: `#${d.ticket} ${what} @ ${d.closePrice.toFixed(2)} · ${usd(d.pnl, true)}` } });
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
  const d = Math.max(0.05, entry * 0.001, span * 0.08);
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
      const r = account.modify(pos.ticket, { sl: round2(stop), tp: round2(target) }, mid(), Date.now());
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
  const v = round2(o.points[0].value!);
  const r = account.modify(ticket, { sl: kind === 'sl' ? v : pos.sl, tp: kind === 'tp' ? v : pos.tp }, mid(), Date.now());
  if (!r.ok) toast(r.error);
  tape.chart.overrideOverlay({ id: o.id, points: [{ ...o.points[0], value: kind === 'sl' ? pos.sl! : pos.tp! }] });
  scheduleRender(true);
};

const round2 = (v: number): number => Math.round(v * 100) / 100;

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
    el.innerHTML = `<span>${side === 'buy' ? 'Long' : 'Short'} · SL <b>${stop.toFixed(2)}</b> · TP <b>${target.toFixed(2)}</b> · R:R <b>${rr.toFixed(2)}</b></span>` +
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
  const r = account.open(side, fresh.extendData.lots, { sl: round2(stop), tp: round2(target) }, mid(), Date.now());
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
  toast(`#${r.value.ticket} ${side.toUpperCase()} ${r.value.lots.toFixed(2)} @ ${r.value.openPrice.toFixed(2)} · SL ${r.value.sl!.toFixed(2)} · TP ${r.value.tp!.toFixed(2)}`);
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

const menu = $('indicatorMenu');
menu.innerHTML = `<div class="menu-title">On the chart</div>` +
  INDICATOR_CHOICES.filter(c => c.pane === 'main').map(c => `<label><input type="checkbox" data-ind="${c.name}"${prefs.indicators.includes(c.name) ? ' checked' : ''}> ${c.label}</label>`).join('') +
  `<div class="menu-title">Bottom panes</div>` +
  INDICATOR_CHOICES.filter(c => c.pane === 'sub').map(c => `<label><input type="checkbox" data-ind="${c.name}"${prefs.indicators.includes(c.name) ? ' checked' : ''}> ${c.label}</label>`).join('');
menu.onchange = e => {
  const t = e.target as HTMLInputElement;
  const name = t.dataset.ind;
  if (!name) return;
  tape.setIndicator(name, t.checked);
  prefs.indicators = t.checked ? [...new Set([...prefs.indicators, name])] : prefs.indicators.filter(n => n !== name);
  storage.set(PREFS_KEY, prefs);
};
$('btnIndicators').onclick = e => {
  e.stopPropagation();
  menu.hidden = !menu.hidden;
  $('btnIndicators').setAttribute('aria-expanded', String(!menu.hidden));
};
document.addEventListener('click', e => { if (!menu.hidden && !menu.contains(e.target as Node)) { menu.hidden = true; $('btnIndicators').setAttribute('aria-expanded', 'false'); } });
for (const name of prefs.indicators) tape.setIndicator(name, true);

$('btnConnect').onclick = () => void connectEsp32();
$('btnDemo').onclick = () => void useDemo();
$('rate').oninput = e => {
  const v = Number((e.target as HTMLInputElement).value);
  engine.rate = v;
  $('rateVal').textContent = `${v.toFixed(1)}%`;
};
$('rate').onchange = () => log('info', `central bank rate set to ${engine.rate.toFixed(1)}%`);
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
$('spread').textContent = T.spread.toFixed(2);
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
