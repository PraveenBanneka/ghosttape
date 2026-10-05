// DOM rendering for the terminal: quote, entropy chip, account strip, Trade / History / Journal, proof drawer.
import type { Account, Deal, JournalEntry, Position, Snapshot } from '../model/account';
import type { Packet } from '../model/random';
import type { FeedState } from '../entropy/source';
import { PRICE_DECIMALS } from '../model/engine';

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

export const usd = (v: number, sign = false): string =>
  (v < 0 ? '-$' : sign && v > 0 ? '+$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const px = (v: number): string => v.toFixed(PRICE_DECIMALS);
const time = (ms: number): string => new Date(ms).toLocaleTimeString('en-GB', { hour12: false });
const esc = (s: string): string => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const cls = (v: number): string => (v > 0 ? 'up' : v < 0 ? 'down' : '');

const FEED_LABEL: Record<FeedState, string> = {
  demo: 'DEMO · browser entropy, not hardware',
  waiting: 'ESP32 · waiting for packets',
  live: 'LIVE · ESP32 hardware entropy',
  offline: 'ESP32 OFFLINE · no entropy',
  radio_error: 'ESP32 RADIO NOT VERIFIED · no entropy',
};

export function renderFeed(state: FeedState, message?: string): void {
  $('feed').className = `feed ${state}`;
  $('feedLabel').textContent = FEED_LABEL[state];
  $('freeze').hidden = !(state === 'offline' || state === 'radio_error');
  $('freezeText').textContent = state === 'radio_error'
    ? 'ESP32 radio not verified · numbers withheld · no candles'
    : 'ESP32 disconnected · no entropy · no candles';
  if (message !== undefined) $('sourceMsg').textContent = message;
}

export function renderQuote(price: number, ref: number, regime: 'expansion' | 'recession'): void {
  $('price').textContent = px(price);
  const pct = ((price - ref) / ref) * 100;
  const chg = $('change');
  chg.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
  chg.className = `chg mono ${pct >= 0 ? 'up' : 'down'}`;
  const r = $('regime');
  r.textContent = regime === 'expansion' ? 'Expansion' : 'Recession';
  r.className = `regime ${regime}`;
}

export function renderAccount(a: Account, s: Snapshot, stopOut: number): void {
  $('aBalance').textContent = usd(s.balance);
  $('aEquity').textContent = usd(s.equity);
  const f = $('aFloating');
  f.textContent = usd(s.floating, true);
  f.className = cls(s.floating);
  $('aMargin').textContent = usd(s.margin);
  $('aFree').textContent = usd(s.freeMargin);
  const l = $('aLevel');
  l.textContent = s.marginLevel === null ? '—' : `${s.marginLevel.toFixed(0)}%`;
  l.className = s.marginLevel !== null && s.marginLevel < 150 ? 'down' : '';
  const w = $('marginWarn');
  w.hidden = !s.marginCall;
  if (s.marginCall) w.textContent = `⚠ MARGIN CALL: margin level ${s.marginLevel!.toFixed(0)}%. Positions are stopped out below ${stopOut}%, largest loss first.`;
  $('tradeCount').textContent = String(a.positions.length);
  $('freeMarginT').textContent = usd(s.freeMargin);
}

export function renderPositions(a: Account, mid: number): void {
  const rows = a.positions.map((p: Position) => {
    const pnl = a.pnl(p, mid);
    return `<tr><td>#${p.ticket}</td><td>${time(p.openTime)}</td><td class="${p.side === 'buy' ? 'up' : 'down'}">${p.side.toUpperCase()}</td>` +
      `<td>${p.lots.toFixed(2)}</td><td>${px(p.openPrice)}</td><td>${p.sl === null ? '—' : px(p.sl)}</td><td>${p.tp === null ? '—' : px(p.tp)}</td>` +
      `<td>${px(a.exitPrice(p.side, mid))}</td><td>${usd(a.marginOf(p))}</td><td class="${cls(pnl)}">${usd(pnl, true)}</td>` +
      `<td><button type="button" class="xbtn" data-close="${p.ticket}" aria-label="Close position ${p.ticket}">×</button></td></tr>`;
  });
  $('tab-trade').innerHTML = `<table class="grid"><thead><tr><th>Ticket</th><th>Time</th><th>Type</th><th>Volume</th><th>Price</th><th>S/L</th><th>T/P</th><th>Current</th><th>Margin</th><th>Profit</th><th></th></tr></thead><tbody>` +
    (rows.join('') || '<tr class="empty"><td colspan="11">No open positions. Use SELL / BUY, or draw a Long / Short Position box and press Place order.</td></tr>') + '</tbody></table>';
}

export function renderHistory(deals: Deal[]): void {
  const reason = { manual: 'Closed', sl: 'SL', tp: 'TP', stopout: 'Stop out' } as const;
  const rows = deals.slice(0, 300).map(d =>
    `<tr><td>#${d.ticket}</td><td class="${d.side === 'buy' ? 'up' : 'down'}">${d.side.toUpperCase()}</td><td>${d.lots.toFixed(2)}</td>` +
    `<td>${time(d.openTime)}</td><td>${px(d.openPrice)}</td><td>${time(d.closeTime)}</td><td>${px(d.closePrice)}</td>` +
    `<td>${((d.closePrice - d.openPrice) * (d.side === 'buy' ? 1 : -1) * 100).toFixed(1)}</td><td>${reason[d.reason]}</td>` +
    `<td class="${cls(d.slippage)}">${d.level === null ? '—' : d.slippage.toFixed(4)}</td><td class="${cls(d.pnl)}">${usd(d.pnl, true)}</td></tr>`);
  const total = deals.reduce((s, d) => s + d.pnl, 0);
  const wins = deals.filter(d => d.pnl > 0).length;
  $('tab-history').innerHTML = `<table class="grid"><thead><tr><th>Ticket</th><th>Type</th><th>Volume</th><th>Open time</th><th>Open</th><th>Close time</th><th>Close</th><th>Pips</th><th>Reason</th><th>Slippage</th><th>Profit</th></tr></thead><tbody>` +
    (rows.join('') || '<tr class="empty"><td colspan="11">No closed deals yet.</td></tr>') +
    (deals.length ? `<tr><td colspan="10">${deals.length} deals · ${wins} winners (${((wins / deals.length) * 100).toFixed(0)}%) · on pure noise, expect about half</td><td class="${cls(total)}">${usd(total, true)}</td></tr>` : '') +
    '</tbody></table>';
}

export function renderJournal(j: JournalEntry[]): void {
  $('tab-journal').innerHTML = `<div class="journal">${j.slice(0, 300).map(e => `<div class="k-${e.kind}"><time>${time(e.time)}</time><span>${esc(e.text)}</span></div>`).join('') || '<div>Journal is empty.</div>'}</div>`;
}

export function renderOrderPrices(bid: number, ask: number, marginReq: number, enabled: boolean): void {
  $('bidPx').textContent = px(bid);
  $('askPx').textContent = px(ask);
  $('marginReq').textContent = usd(marginReq);
  $<HTMLButtonElement>('btnBuy').disabled = !enabled;
  $<HTMLButtonElement>('btnSell').disabled = !enabled;
}

export function setOrderMsg(text: string, ok = false): void {
  const m = $('orderMsg');
  m.textContent = text;
  m.className = `order-msg${ok ? ' ok' : ''}`;
}

const hex8 = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');
const rawRows: string[] = [];
export function pushRaw(p: Packet): void {
  rawRows.unshift(`<div class="row"><span class="seq">#${p.seq === null ? 'demo' : p.seq}</span><span>${hex8(p.a)}</span><span>${hex8(p.b)}</span><span>${hex8(p.c)}</span></div>`);
  if (rawRows.length > 10) rawRows.length = 10;
}
export function clearRaw(): void { rawRows.length = 0; }

export interface ProofInfo {
  source: 'demo' | 'esp32';
  packets: number;
  gaps: number;
  restarts: number;
  rate: number;
  lastAgoMs: number | null;
  radio: string;
  regime: string;
  mu: number;
  sigma: number;
  centralRate: number;
  barTicks: number;
  tf: string;
}

export function renderProof(i: ProofInfo): void {
  if ($('proof').hidden) return;
  $('rawfeed').innerHTML = rawRows.join('') || '<div class="muted">Waiting for the first packet…</div>';
  const rows: [string, string][] = [
    ['Source', i.source === 'esp32' ? 'ESP32 esp_random() over USB serial. True random only while its radio is on (Espressif); the firmware verifies the radio and withholds numbers otherwise.' : 'Browser crypto.getRandomValues() (DEMO, not hardware).'],
    ['Radio', i.source === 'esp32' ? i.radio : 'n/a in demo'],
    ['Packets used', `${i.packets.toLocaleString('en-US')} (each exactly once)`],
    ['Gaps / restarts', i.source === 'esp32' ? `${i.gaps} lost · ${i.restarts} restarts` : 'n/a'],
    ['Rate', `${i.rate.toFixed(2)} packets/s${i.lastAgoMs === null ? '' : ` · last ${i.lastAgoMs > 9999 ? '>10 s' : `${i.lastAgoMs} ms`} ago`}`],
    ['Mapping', 'u₁=(a+1)/(2³²+1), u₂=b/2³², z=√(−2 ln u₁)·cos(2πu₂)'],
    ['Price step', `price ← price·exp((μ−σ²/2)+σz), μ=${i.mu.toFixed(4)}, σ=${i.sigma.toFixed(3)} (${i.regime})`],
    ['Regime roll', `every 8th packet with uc=(c+1)/(2³²+1), central bank rate ${i.centralRate.toFixed(1)}%`],
    ['Current bar', `${i.barTicks} packets in this ${i.tf} candle`],
  ];
  $('proofInfo').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(text: string): void {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}
