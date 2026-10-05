// Small hand-made canvas renderers for the learn page (no chart library on purpose). Colours come from the
// CSS custom properties in learn.css, so the page has one source of truth for its palette.

import type { Candle } from '../model/aggregator';
import type { Bin } from './analysis';

export interface Theme {
  bg: string; grid: string; ink: string; muted: string; up: string; down: string; accent: string;
  shade: string; future: string; coin: string;
}

export function theme(): Theme {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string): string => cs.getPropertyValue(n).trim();
  return {
    bg: v('--bg'), grid: v('--grid'), ink: v('--ink'), muted: v('--muted'), up: v('--up'), down: v('--down'),
    accent: v('--accent'), shade: v('--shade-recession'), future: v('--future'), coin: v('--coin'),
  };
}

const MONO = '"Roboto Mono", ui-monospace, Consolas, monospace';

/** Sizes the backing store to the element's CSS width x the height given in its `height` attribute (once). */
function prepare(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } {
  if (!canvas.dataset.h) canvas.dataset.h = String(canvas.getAttribute('height') ?? 200);
  const h = Number(canvas.dataset.h);
  const w = Math.max(10, canvas.clientWidth || canvas.parentElement?.clientWidth || 300);
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  canvas.style.height = `${h}px`;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

// One ResizeObserver redraws every mounted canvas when its width changes (phone rotation, window resize).
const drawers = new WeakMap<Element, () => void>();
const mounted = new Set<HTMLCanvasElement>();
const widths = new WeakMap<Element, number>();
const ro = typeof ResizeObserver !== 'undefined'
  ? new ResizeObserver(entries => {
    for (const e of entries) {
      const w = Math.round(e.contentRect.width);
      if (widths.get(e.target) === w) continue;
      widths.set(e.target, w);
      drawers.get(e.target)?.();
    }
  })
  : null;

/** Draws now and again on every width change. */
export function mount(canvas: HTMLCanvasElement, draw: () => void): void {
  const first = !drawers.has(canvas);
  drawers.set(canvas, draw);
  if (first) ro?.observe(canvas);
  mounted.add(canvas);
  widths.set(canvas, Math.round(canvas.clientWidth));
  draw();
}

/** Redraws every mounted canvas that is still in the page (e.g. once web fonts have loaded). */
export function redrawAll(): void {
  for (const c of [...mounted]) {
    if (!c.isConnected) { mounted.delete(c); continue; }
    drawers.get(c)?.();
  }
}

/** Decimals needed to print every tick distinctly (190.005 needs 3, 200 needs 0). */
function decimalsFor(ts: number[]): number {
  for (let d = 0; d <= 6; d++) if (ts.every(t => Math.abs(+t.toFixed(d) - t) < 1e-9)) return d;
  return 6;
}

/** Nice round tick values between lo and hi. */
function ticks(lo: number, hi: number, count: number): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

export interface LineOverlay {
  /** candle index and price at each end; the line is extended to `extendTo` (candle index) if given */
  x1: number; y1: number; x2: number; y2: number;
  extendTo?: number;
  color: string;
  width?: number;
  dash?: number[];
}

export interface CandleOptions {
  /** per-candle flag: shade this candle's column (recession) */
  shade?: boolean[];
  /** candles at index >= splitAt are drawn faded ("what came next") behind a dashed divider */
  splitAt?: number;
  /** hide candles at index >= splitAt entirely (still reserves their room so the reveal does not jump) */
  hideAfterSplit?: boolean;
  lines?: LineOverlay[];
  /** dots on specific candles, e.g. trendline touches */
  dots?: { index: number; price: number; color: string }[];
  axis?: boolean;
  /** pixels of padding; small charts use less */
  pad?: number;
}

export function drawCandles(canvas: HTMLCanvasElement, candles: readonly Candle[], o: CandleOptions = {}): void {
  const { ctx, w, h } = prepare(canvas);
  const th = theme();
  const pad = o.pad ?? 8;
  const axisW = o.axis ? 62 : 0;
  const plotW = w - pad * 2 - axisW;
  const top = pad, bottom = h - pad;
  const n = candles.length;
  if (n === 0) return;
  const visible = o.hideAfterSplit && o.splitAt !== undefined ? candles.slice(0, o.splitAt) : candles;
  let lo = Infinity, hi = -Infinity;
  for (const c of visible) { if (c.low < lo) lo = c.low; if (c.high > hi) hi = c.high; }
  const m = (hi - lo) * 0.06 || 1;
  lo -= m; hi += m;
  const slot = plotW / n;
  const X = (i: number): number => pad + (i + 0.5) * slot;
  const Y = (p: number): number => top + ((hi - p) / (hi - lo)) * (bottom - top);

  ctx.fillStyle = th.bg;
  ctx.fillRect(0, 0, w, h);

  // regime shading
  if (o.shade) {
    ctx.fillStyle = th.shade;
    for (let i = 0; i < n; i++) if (o.shade[i] && !(o.hideAfterSplit && o.splitAt !== undefined && i >= o.splitAt)) ctx.fillRect(pad + i * slot, top, Math.ceil(slot), bottom - top);
  }

  // grid + axis
  if (o.axis) {
    ctx.font = `11px ${MONO}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const ts = ticks(lo, hi, Math.max(3, Math.floor(h / 55)));
    const dec = decimalsFor(ts);
    for (const t of ts) {
      const y = Math.round(Y(t)) + 0.5;
      ctx.strokeStyle = th.grid;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(pad + plotW, y); ctx.stroke();
      ctx.fillStyle = th.muted;
      ctx.fillText(t.toFixed(dec), pad + plotW + 6, y);
    }
  }

  // divider
  if (o.splitAt !== undefined && o.splitAt < n && !o.hideAfterSplit) {
    const x = Math.round(pad + o.splitAt * slot) + 0.5;
    ctx.save();
    ctx.strokeStyle = th.muted;
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
    ctx.restore();
  }

  // candles
  const bodyW = Math.max(1, Math.min(9, slot * 0.7));
  for (let i = 0; i < n; i++) {
    const after = o.splitAt !== undefined && i >= o.splitAt;
    if (after && o.hideAfterSplit) continue;
    const c = candles[i];
    const up = c.close >= c.open;
    const col = after ? th.future : up ? th.up : th.down;
    const x = X(i);
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, Y(c.high)); ctx.lineTo(Math.round(x) + 0.5, Y(c.low)); ctx.stroke();
    const y1 = Y(Math.max(c.open, c.close)), y2 = Y(Math.min(c.open, c.close));
    ctx.fillRect(x - bodyW / 2, y1, bodyW, Math.max(1, y2 - y1));
  }

  // trendlines (clipped to the plot)
  if (o.lines?.length) {
    ctx.save();
    ctx.beginPath(); ctx.rect(pad, top, plotW, bottom - top); ctx.clip();
    for (const l of o.lines) {
      const slope = (l.y2 - l.y1) / (l.x2 - l.x1 || 1);
      const xe = l.extendTo ?? l.x2;
      ctx.strokeStyle = l.color;
      ctx.lineWidth = l.width ?? 2;
      ctx.setLineDash(l.dash ?? []);
      ctx.beginPath();
      ctx.moveTo(X(l.x1), Y(l.y1));
      ctx.lineTo(X(xe), Y(l.y1 + slope * (xe - l.x1)));
      ctx.stroke();
    }
    ctx.restore();
  }
  for (const d of o.dots ?? []) {
    ctx.fillStyle = th.bg;
    ctx.strokeStyle = d.color;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(X(d.index), Y(d.price), 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
}

/** Two overlaid histograms over the same bins: rule as filled bars, coin as an outline. */
export function drawHistogram(canvas: HTMLCanvasElement, rule: Bin[], coin: Bin[], fmtX: (v: number) => string): void {
  const { ctx, w, h } = prepare(canvas);
  const th = theme();
  const padL = 8, padR = 8, padT = 10, padB = 24;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const maxC = Math.max(1, ...rule.map(b => b.count), ...coin.map(b => b.count));
  const lo = rule[0].lo, hi = rule[rule.length - 1].hi;
  const X = (v: number): number => padL + ((v - lo) / (hi - lo)) * plotW;
  const Y = (c: number): number => padT + plotH - (c / maxC) * plotH;
  ctx.fillStyle = th.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = th.grid;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, padT + plotH + 0.5); ctx.lineTo(padL + plotW, padT + plotH + 0.5); ctx.stroke();

  ctx.globalAlpha = 0.75;
  ctx.fillStyle = th.accent;
  for (const b of rule) {
    if (!b.count) continue;
    const x1 = X(b.lo), x2 = X(b.hi);
    ctx.fillRect(x1 + 0.5, Y(b.count), Math.max(1, x2 - x1 - 1), padT + plotH - Y(b.count));
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = th.coin;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(X(coin[0].lo), Y(0));
  for (const b of coin) { ctx.lineTo(X(b.lo), Y(b.count)); ctx.lineTo(X(b.hi), Y(b.count)); }
  ctx.lineTo(X(coin[coin.length - 1].hi), Y(0));
  ctx.stroke();

  // zero line + labels
  if (lo < 0 && hi > 0) {
    ctx.strokeStyle = th.ink;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(Math.round(X(0)) + 0.5, padT); ctx.lineTo(Math.round(X(0)) + 0.5, padT + plotH); ctx.stroke();
  }
  ctx.fillStyle = th.muted;
  ctx.font = `11px ${MONO}`;
  ctx.textBaseline = 'top';
  const labels = ticks(lo, hi, Math.max(3, Math.floor(plotW / 90)));
  for (const t of labels) {
    const x = X(t);
    ctx.textAlign = x < 30 ? 'left' : x > w - 30 ? 'right' : 'center';
    ctx.fillText(fmtX(t), x, padT + plotH + 6);
  }
}

/** A simple line (equity curve) with a dashed baseline. */
export function drawLine(canvas: HTMLCanvasElement, values: readonly number[], baseline: number, fmt: (v: number) => string): void {
  const { ctx, w, h } = prepare(canvas);
  const th = theme();
  const pad = 8, axisW = 70;
  const plotW = w - pad * 2 - axisW;
  let lo = Math.min(baseline, ...values), hi = Math.max(baseline, ...values);
  const m = (hi - lo) * 0.08 || 1;
  lo -= m; hi += m;
  const X = (i: number): number => pad + (i / Math.max(1, values.length - 1)) * plotW;
  const Y = (v: number): number => pad + ((hi - v) / (hi - lo)) * (h - pad * 2);
  ctx.fillStyle = th.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.strokeStyle = th.muted;
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad, Math.round(Y(baseline)) + 0.5); ctx.lineTo(pad + plotW, Math.round(Y(baseline)) + 0.5); ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = th.accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  values.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.stroke();
  ctx.fillStyle = th.muted;
  ctx.font = `11px ${MONO}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(fmt(hi - m), pad + plotW + 6, Y(hi - m));
  ctx.fillText(fmt(lo + m), pad + plotW + 6, Y(lo + m));
}
