// Learn page: "why patterns appear in pure noise". Wires the five demos to analysis.ts (pure maths) and
// draw.ts (canvas). Demo randomness only: browser crypto or a labelled fixed seed, never the live ESP32 path.
import './learn.css';
import { gaussian, seededPackets, type Packet } from '../model/random';
import { LIMITS } from '../config';
import type { AccountConfig } from '../model/account';
import { PRICE_DECIMALS, START_PRICE } from '../model/engine';
import {
  describeLook, finishMany, fitTrendline, followThrough, generateSession, histogram, quantile, startMany, stepMany,
  STRATEGIES, type ManyResult, type PacketSource, type Session, type StrategyId, type Trendline,
} from './analysis';
import { drawCandles, drawHistogram, drawLine, mount, redrawAll, theme, type LineOverlay } from './draw';

// The demo account uses the owner's trading constants (spread 0 for now) from limits.jsonc.
const CFG: AccountConfig = LIMITS.trading;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const pct = (v: number, d = 1): string => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}%`;
const share = (v: number): string => `${(v * 100).toFixed(0)}%`;
const usd = (v: number): string => `${v < 0 ? '−' : '+'}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const px = (v: number): string => v.toFixed(PRICE_DECIMALS);
const move = (v: number): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(PRICE_DECIMALS)}`;
const hex = (w: number): string => w.toString(16).padStart(8, '0');
const esc = (s: string): string => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// ---------------------------------------------------------------------------------------------------------------
// Randomness source (browser crypto or fixed seed)

type Mode = 'browser' | 'seed';
let mode: Mode = 'browser';
let seed = 42;
const SECTION = { s1: 1, s2: 2, s2stats: 3, s3: 4, s3many: 5, s4: 6 } as const;
const counters = new Map<keyof typeof SECTION, number>();

/** FNV-style mix so each section and each "new" press gets its own reproducible stream for a given seed. */
function mix(...xs: number[]): number {
  let h = 2166136261;
  for (const x of xs) {
    h ^= x >>> 0;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
  }
  return h >>> 0;
}

/**
 * Browser packets from crypto.getRandomValues, fetched 1,000 packets at a time for speed (the 1,000-session
 * backtest needs millions). Demo pages only: the live ESP32 path never buffers numbers.
 */
function browserPackets(): PacketSource {
  const buf = new Uint32Array(3000);
  let i = buf.length;
  return (): Packet => {
    if (i >= buf.length) { crypto.getRandomValues(buf); i = 0; }
    const p = { seq: null, a: buf[i], b: buf[i + 1], c: buf[i + 2] };
    i += 3;
    return p;
  };
}

function source(key: keyof typeof SECTION): PacketSource {
  if (mode === 'browser') return browserPackets();
  const n = (counters.get(key) ?? 0) + 1;
  counters.set(key, n);
  return seededPackets(mix(seed, SECTION[key], n));
}

/** Wraps a source and keeps the first `n` packets it hands out (for the "how the steps were made" table). */
function recording(src: PacketSource, n: number): { src: PacketSource; seen: Packet[] } {
  const seen: Packet[] = [];
  return { seen, src: () => { const p = src(); if (seen.length < n) seen.push(p); return p; } };
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Every candle is a coin flip

let s1: Session | null = null;

function s1New(): void {
  const rec = recording(source('s1'), 8);
  s1 = generateSession(rec.src);
  const c = s1.candles;
  const first = c[0].open, last = c[c.length - 1].close;
  const recessionShare = s1.regimes.filter(r => r === 'recession').length / s1.regimes.length;
  $('s1Stats').textContent =
    `1,000 random steps → ${c.length} one-second candles · ${px(first)} → ${px(last)} (${move(last - first)}, ${pct((last / first - 1) * 100, 3)}) · ` +
    `mood flipped ${s1.shifts} time${s1.shifts === 1 ? '' : 's'} · ${share(recessionShare)} of candles in recession`;
  const body = $('s1Packets').querySelector('tbody')!;
  body.innerHTML = rec.seen.map((p, i) => {
    const z = gaussian(p.a, p.b);
    const price = s1!.prices[i], prev = i ? s1!.prices[i - 1] : START_PRICE;
    const cls = price >= prev ? 'up' : 'down';
    return `<tr><td>${i + 1}</td><td>${hex(p.a)} · ${hex(p.b)}</td><td class="${z >= 0 ? 'up' : 'down'}">${z >= 0 ? '+' : '−'}${Math.abs(z).toFixed(3)}</td>` +
      `<td class="${cls}">${price.toFixed(PRICE_DECIMALS + 2)} ${price >= prev ? '▲' : '▼'}</td></tr>`;
  }).join('');
  $('s1Chart').setAttribute('aria-label', `Candlestick chart of one random session: ${c.length} candles from ${px(first)} to ${px(last)}.`);
  s1Draw();
}

function s1Draw(): void {
  if (!s1) return;
  const shadeOn = $<HTMLInputElement>('s1Shade').checked;
  $('s1Legend').hidden = !shadeOn;
  const session = s1;
  mount($<HTMLCanvasElement>('s1Chart'), () => drawCandles($<HTMLCanvasElement>('s1Chart'), session.candles, {
    axis: true, shade: shadeOn ? session.regimes.map(r => r === 'recession') : undefined,
  }));
}

// ---------------------------------------------------------------------------------------------------------------
// 2. Spot the pattern

const S2_VISIBLE = 110;
type Tag = 'up' | 'dtop';
interface Mini { session: Session; tags: Set<Tag>; canvas: HTMLCanvasElement; el: HTMLElement }
let minis: Mini[] = [];
let s2Revealed = false;

function s2New(): void {
  const src = source('s2');
  s2Revealed = false;
  $('s2Result').hidden = true;
  $<HTMLButtonElement>('s2Reveal').disabled = false;
  const grid = $('s2Grid');
  grid.innerHTML = '';
  minis = Array.from({ length: 6 }, (_, i) => {
    const session = generateSession(src);
    const el = document.createElement('div');
    el.className = 'mini';
    el.innerHTML = `<div class="mini-head"><span>Chart ${String.fromCharCode(65 + i)}</span><span class="who"></span></div>` +
      `<canvas height="120" role="img" aria-label="Chart ${String.fromCharCode(65 + i)}"></canvas>` +
      `<div class="tags"><button type="button" class="tag" data-tag="up" aria-pressed="false">Uptrend</button>` +
      `<button type="button" class="tag" data-tag="dtop" aria-pressed="false">Double top</button></div><p class="after" hidden></p>`;
    grid.appendChild(el);
    const m: Mini = { session, tags: new Set(), canvas: el.querySelector('canvas')!, el };
    el.querySelectorAll<HTMLButtonElement>('.tag').forEach(b => b.addEventListener('click', () => {
      if (s2Revealed) return;
      const t = b.dataset.tag as Tag;
      if (m.tags.has(t)) m.tags.delete(t); else m.tags.add(t);
      b.setAttribute('aria-pressed', String(m.tags.has(t)));
    }));
    return m;
  });
  minis.forEach(s2DrawMini);
}

function s2DrawMini(m: Mini): void {
  mount(m.canvas, () => drawCandles(m.canvas, m.session.candles, { pad: 4, splitAt: S2_VISIBLE, hideAfterSplit: !s2Revealed }));
}

function s2Reveal(): void {
  if (s2Revealed) return;
  s2Revealed = true;
  $<HTMLButtonElement>('s2Reveal').disabled = true;
  const tagged = { up: { n: 0, rose: 0 }, dtop: { n: 0, fell: 0 } };
  let machineTrend = 0, machineDtop = 0;
  for (const m of minis) {
    const visible = m.session.candles.slice(0, S2_VISIBLE);
    const look = describeLook(visible);
    const before = visible[visible.length - 1].close;
    const after = m.session.candles[m.session.candles.length - 1].close;
    const change = after - before;
    if (m.tags.has('up')) { tagged.up.n++; if (change > 0) tagged.up.rose++; }
    if (m.tags.has('dtop')) { tagged.dtop.n++; if (change < 0) tagged.dtop.fell++; }
    if (look.uptrend || look.downtrend) machineTrend++;
    if (look.doubleTop) machineDtop++;
    const seen = [look.uptrend && 'an uptrend', look.downtrend && 'a downtrend', look.doubleTop && 'a double top'].filter(Boolean) as string[];
    m.el.classList.add('revealed');
    m.el.querySelector('.who')!.textContent = 'pure noise';
    m.el.querySelectorAll<HTMLButtonElement>('.tag').forEach(b => { b.disabled = true; });
    const p = m.el.querySelector<HTMLElement>('.after')!;
    p.hidden = false;
    p.innerHTML = `Pattern finder sees: ${seen.length ? seen.join(' and ') : 'nothing special'}.<br>Next 50 candles: <b class="${change >= 0 ? 'up' : 'down'}">${move(change)}</b>`;
    s2DrawMini(m);
  }
  // How often does the same pattern finder "see" something in noise? 300 fresh charts.
  const src = source('s2stats');
  let trend = 0, dtop = 0;
  const N = 300;
  for (let i = 0; i < N; i++) {
    const look = describeLook(generateSession(src).candles.slice(0, S2_VISIBLE));
    if (look.uptrend || look.downtrend) trend++;
    if (look.doubleTop) dtop++;
  }
  const yours: string[] = [];
  if (tagged.up.n) yours.push(`You tagged ${tagged.up.n} as an uptrend: afterwards ${tagged.up.rose} went up and ${tagged.up.n - tagged.up.rose} went down.`);
  if (tagged.dtop.n) yours.push(`You tagged ${tagged.dtop.n} as a double top: afterwards ${tagged.dtop.fell} fell and ${tagged.dtop.n - tagged.dtop.fell} did not.`);
  if (!yours.length) yours.push('You tagged nothing, which is the most honest answer.');
  const r = $('s2Result');
  r.hidden = false;
  r.innerHTML =
    `<p><b>All six charts are pure noise</b>, made by the same random process. Nobody put a pattern in any of them.</p>` +
    `<p>${yours.map(esc).join(' ')}</p>` +
    `<p>A simple computer pattern finder saw a trend in ${machineTrend} and a double top in ${machineDtop} of these six. ` +
    `On ${N} more random charts it saw a trend in ${share(trend / N)} and a double top in ${share(dtop / N)}. ` +
    `Shapes like these are what noise looks like. A handful of charts cannot tell you whether a shape means anything.</p>`;
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Trendlines always fit

const S3_FIT = 110;
let s3: { session: Session; sup: Trendline | null; res: Trendline | null } | null = null;

function s3New(): void {
  const session = generateSession(source('s3'));
  const fit = session.candles.slice(0, S3_FIT);
  s3 = { session, sup: fitTrendline(fit, 'support'), res: fitTrendline(fit, 'resistance') };
  const th = theme();
  const n = session.candles.length;
  const lines: LineOverlay[] = [];
  const dots: { index: number; price: number; color: string }[] = [];
  const tiles: string[] = [];
  for (const line of [s3.sup, s3.res]) {
    if (!line) continue;
    const color = line.kind === 'support' ? th.up : th.down;
    lines.push({ x1: line.from.index, y1: line.from.price, x2: line.to.index, y2: line.to.price, extendTo: n - 1, color });
    dots.push({ index: line.from.index, price: line.from.price, color }, { index: line.to.index, price: line.to.price, color });
    const after = followThrough(session.candles, line, S3_FIT);
    const name = line.kind === 'support' ? 'Support' : 'Resistance';
    const swing = line.kind === 'support' ? 'swing lows' : 'swing highs';
    tiles.push(`<div class="tile"><div class="k">${name} line touches</div><div class="v">${line.touches}</div><div class="s">${swing} within 2% of the chart's height</div></div>`);
    tiles.push(`<div class="tile"><div class="k">${name}: after the divider</div><div class="v">${after.breakIndex === null ? 'held' : 'broke'}</div>` +
      `<div class="s">${after.bounces} bounce${after.bounces === 1 ? '' : 's'}${after.breakIndex === null ? '' : `, broke after ${after.breakIndex - S3_FIT + 1} candle${after.breakIndex - S3_FIT === 0 ? '' : 's'}`}</div></div>`);
  }
  if (!tiles.length) tiles.push('<div class="tile"><div class="k">No line found</div><div class="v">rare</div><div class="s">try another chart</div></div>');
  $('s3Tiles').innerHTML = tiles.join('');
  const cur = s3;
  mount($<HTMLCanvasElement>('s3Chart'), () => drawCandles($<HTMLCanvasElement>('s3Chart'), cur.session.candles, { axis: true, splitAt: S3_FIT, lines, dots }));
}

function s3Many(): void {
  const src = source('s3many');
  const N = 200;
  let sup3 = 0, res3 = 0, any3 = 0, lines = 0, broke = 0, touches = 0;
  for (let i = 0; i < N; i++) {
    const s = generateSession(src);
    const fit = s.candles.slice(0, S3_FIT);
    const sup = fitTrendline(fit, 'support');
    const res = fitTrendline(fit, 'resistance');
    if (sup && sup.touches >= 3) sup3++;
    if (res && res.touches >= 3) res3++;
    if ((sup && sup.touches >= 3) || (res && res.touches >= 3)) any3++;
    for (const l of [sup, res]) {
      if (!l) continue;
      lines++;
      touches += l.touches;
      if (followThrough(s.candles, l, S3_FIT).breakIndex !== null) broke++;
    }
  }
  $('s3Many_out').textContent =
    `On ${N} random charts: a support line touching 3+ swing lows could be drawn on ${share(sup3 / N)}, a resistance line touching 3+ swing highs on ${share(res3 / N)}, ` +
    `and at least one of them on ${share(any3 / N)}. Average touches per line: ${(touches / Math.max(1, lines)).toFixed(1)}. ` +
    `${share(broke / Math.max(1, lines))} of the lines were broken within the next 50 candles.`;
}

// ---------------------------------------------------------------------------------------------------------------
// 4. The strategy lie detector

const S4_SESSIONS = 1000;
let strategy: StrategyId = 'ema';
let running = false;

function s4Rule(): void {
  $('s4Rule').textContent = STRATEGIES[strategy].rule;
}

async function s4Run(): Promise<void> {
  if (running) return;
  running = true;
  const btn = $<HTMLButtonElement>('s4Run');
  btn.disabled = true;
  document.querySelectorAll<HTMLInputElement>('input[name="strat"]').forEach(r => { r.disabled = true; });
  $('s4Progress').hidden = false;
  const acc = startMany(strategy);
  const src = source('s4');
  try {
    while (acc.rule.pnls.length < S4_SESSIONS) {
      const t = performance.now();
      while (acc.rule.pnls.length < S4_SESSIONS && performance.now() - t < 30) stepMany(acc, src, CFG);
      const done = acc.rule.pnls.length;
      $('s4Bar').style.width = `${(done / S4_SESSIONS) * 100}%`;
      $('s4Count').textContent = `${done.toLocaleString('en-US')} / ${S4_SESSIONS.toLocaleString('en-US')} sessions`;
      await new Promise(r => setTimeout(r, 0));
    }
    s4Show(finishMany(acc));
  } finally {
    running = false;
    btn.disabled = false;
    btn.textContent = 'Run 1,000 more';
    document.querySelectorAll<HTMLInputElement>('input[name="strat"]').forEach(r => { r.disabled = false; });
    $('s4Progress').hidden = true;
  }
}

function s4Show(r: ManyResult): void {
  $('s4Out').hidden = false;
  const tile = (k: string, v: string, s: string): string => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const losing = r.rule.pnls.filter(x => x < 0).length;
  $('s4Tiles').innerHTML = [
    tile('Sessions that made money', share(r.rule.sessionWinRate), `coin-flip trader: ${share(r.coin.sessionWinRate)}`),
    tile('Trades that made money', share(r.rule.tradeWinRate), `coin-flip trader: ${share(r.coin.tradeWinRate)}`),
    tile('Average result per session', usd(r.rule.meanPnl), `coin-flip trader: ${usd(r.coin.meanPnl)}`),
    tile('Best session (1 of 1,000)', usd(r.best.pnl), `worst: ${usd(r.worst.pnl)}`),
  ].join('');

  // histogram of the central 98%: the most extreme 1% at each end is left off so one wild session does not
  // squash the picture (the legend says so; the tiles above still include every session)
  const all = [...r.rule.pnls, ...r.coin.pnls];
  let lo = quantile(all, 0.01), hi = quantile(all, 0.99);
  const span = Math.max(1, hi - lo);
  lo = Math.min(lo, -0.05 * span); hi = Math.max(hi, 0.05 * span);
  const ruleBins = histogram(r.rule.pnls, 36, { min: lo, max: hi });
  const coinBins = histogram(r.coin.pnls, 36, { min: lo, max: hi });
  mount($<HTMLCanvasElement>('s4Hist'), () => drawHistogram($<HTMLCanvasElement>('s4Hist'), ruleBins, coinBins, v => `${v < 0 ? '−' : v > 0 ? '+' : ''}$${Math.abs(v).toFixed(0)}`));

  // verdict, chosen from the numbers (never hard-coded)
  const t = r.edgeT;
  const name = STRATEGIES[r.strategy].name;
  const v: string[] = [];
  if (t >= 2.5) {
    v.push(`Verdict: on this tape the ${name} beat the coin, and not by luck (the gap is ${t.toFixed(1)} standard errors wide).`);
    v.push('Why? Not because of chart patterns. Remember the two hidden moods from section 1: each lasts a few hundred steps on average, expansion drifts up and recession drifts down. A trend-following rule climbs aboard whichever drift is running. Each single step is still a fresh coin flip; the mood is the only thing with memory.');
    v.push(`So the lie detector did its job: it found a real property of how this tape is built, not a magic shape. Even so, ${share(losing / r.sessions)} of sessions lost money, so one chart could easily have told you the opposite. Real markets promise no steady moods like these, and real trades pay costs (the spread here is ${CFG.spread}).`);
  } else if (t <= -2.5) {
    v.push(`Verdict: the ${name} did worse than a coin flip here (${t.toFixed(1)} standard errors).`);
    v.push('It kept betting against the drift of the hidden mood. A rule can lose to a coin just as reliably as it can beat one.');
  } else {
    v.push(`Verdict: no real edge. The ${name} did about as well as a coin flip (${share(r.rule.sessionWinRate)} vs ${share(r.coin.sessionWinRate)} of sessions made money).`);
    if (r.rule.tradeWinRate < 0.45) v.push(`Notice the rule won only ${share(r.rule.tradeWinRate)} of its trades: trend rules take many small losses and a few bigger wins. On noise it all nets out to about zero.`);
    v.push(`The spread here is ${CFG.spread}. With real trading costs, both would land below break-even.`);
  }
  $('s4Verdict').innerHTML = v.map(p => `<p>${esc(p)}</p>`).join('');

  // the lucky one
  const best = r.best;
  $('s4LuckyText').textContent =
    `Best of ${r.sessions.toLocaleString('en-US')}: session #${best.index + 1} made ${usd(best.result.pnl)} ` +
    `with ${best.result.trades} trade${best.result.trades === 1 ? '' : 's'}. Shown alone, it looks like a money machine. It came out of the same process as the ${losing.toLocaleString('en-US')} sessions that lost money.`;
  mount($<HTMLCanvasElement>('s4Lucky'), () => drawCandles($<HTMLCanvasElement>('s4Lucky'), best.session.candles, { axis: true }));
  mount($<HTMLCanvasElement>('s4Equity'), () => drawLine($<HTMLCanvasElement>('s4Equity'), best.result.equity, CFG.start_balance,
    x => usd(x - CFG.start_balance)));
}

// ---------------------------------------------------------------------------------------------------------------
// 5. Software replays, hardware does not

function s5Again(): void {
  const soft = seededPackets(seed);
  $('s5Seed').textContent = String(seed);
  $('s5Soft').innerHTML = Array.from({ length: 6 }, () => `<li>${hex(soft().a)}</li>`).join('');
  const words = new Uint32Array(6);
  crypto.getRandomValues(words);
  $('s5Crypto').innerHTML = Array.from(words, w => `<li class="fresh">${hex(w)}</li>`).join('');
}

// ---------------------------------------------------------------------------------------------------------------
// Wiring

function readSeedInput(): number {
  const v = Number($<HTMLInputElement>('seed').value);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) % 4294967296 : 42;
}

function setMode(next: Mode, newSeed = seed): void {
  mode = next;
  seed = newSeed;
  counters.clear();
  $<HTMLInputElement>('seed').value = String(seed);
  document.querySelectorAll<HTMLInputElement>('input[name="src"]').forEach(r => { r.checked = r.value === mode; });
  const url = new URL(location.href);
  if (mode === 'seed') url.searchParams.set('seed', String(seed)); else url.searchParams.delete('seed');
  history.replaceState(null, '', url);
  regenerateAll();
}

function regenerateAll(): void {
  s1New();
  s2New();
  s3New();
  $('s3Many_out').textContent = '';
  $('s4Out').hidden = true;
  $('s4Count').textContent = '';
  $<HTMLButtonElement>('s4Run').textContent = 'Run 1,000 sessions';
  s5Again();
}

function init(): void {
  $('s1New').addEventListener('click', s1New);
  $('s1Shade').addEventListener('change', s1Draw);
  $('s2New').addEventListener('click', s2New);
  $('s2Reveal').addEventListener('click', s2Reveal);
  $('s3New').addEventListener('click', s3New);
  $('s3Many').addEventListener('click', s3Many);
  $('s4Run').addEventListener('click', () => { void s4Run(); });
  $('s5Again').addEventListener('click', s5Again);
  document.querySelectorAll<HTMLInputElement>('input[name="strat"]').forEach(r => r.addEventListener('change', () => {
    if (!r.checked || running) return;
    strategy = r.value as StrategyId;
    s4Rule();
    $('s4Out').hidden = true;
    $('s4Count').textContent = '';
    $<HTMLButtonElement>('s4Run').textContent = 'Run 1,000 sessions';
  }));
  document.querySelectorAll<HTMLInputElement>('input[name="src"]').forEach(r => r.addEventListener('change', () => {
    if (r.checked) setMode(r.value as Mode, readSeedInput());
  }));
  $('applySeed').addEventListener('click', () => setMode('seed', readSeedInput()));
  $('seed').addEventListener('keydown', e => { if (e.key === 'Enter') setMode('seed', readSeedInput()); });

  s4Rule();
  const q = new URL(location.href).searchParams.get('seed');
  if (q !== null && /^\d{1,10}$/.test(q)) setMode('seed', Number(q) % 4294967296);
  else regenerateAll();
}

// Fonts change text metrics on the canvases; redraw once they are ready.
init();
document.fonts?.ready.then(redrawAll).catch(() => undefined);
