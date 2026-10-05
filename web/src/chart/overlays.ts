// Custom drawings:
//  - longPosition / shortPosition: TradingView-style risk/reward boxes. Points: [0] entry, [1] target, [2] stop
//    (points 1 and 2 share the right edge). Drag a corner to stretch, the body to move. A planned box can be
//    turned into a real demo order; a live box tracks the position and dragging its stop/target modifies SL/TP.
//  - gtPriceLine: entry / SL / TP lines of positions opened from the order panel; SL/TP lines are draggable.
import { registerOverlay, type Overlay, type OverlayFigure, type Point } from 'klinecharts';

export type PositionKind = 'longPosition' | 'shortPosition';
export interface PosExt {
  state: 'plan' | 'live' | 'closed';
  ticket?: number;
  lots: number;
  result?: string;
}
export interface LineExt {
  ticket: number;
  kind: 'entry' | 'sl' | 'tp';
  side: 'buy' | 'sell';
}

export interface OverlayHooks {
  mid: () => number | null;
  contract: () => number;
  onPositionDrawn: (o: Overlay<PosExt>) => void;
  onPositionSelected: (o: Overlay<PosExt> | null) => void;
  onPositionMoved: (o: Overlay<PosExt>) => void;
  onLineMoved: (o: Overlay<LineExt>) => void;
}

export const hooks: OverlayHooks = {
  mid: () => null,
  contract: () => 100,
  onPositionDrawn: () => {},
  onPositionSelected: () => {},
  onPositionMoved: () => {},
  onLineMoved: () => {},
};

const C = {
  up: '#089981', down: '#f23645', upFill: 'rgba(8,153,129,0.16)', downFill: 'rgba(242,54,69,0.16)',
  ink: '#131722', muted: '#787b86', accent: '#2962ff',
};

// TradingView-style tags: solid colour, white 12px sans text, small radius.
const TAG_FONT = '-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif';
const label = (x: number, y: number, text: string, bg: string, baseline: CanvasTextBaseline): OverlayFigure => ({
  type: 'text',
  ignoreEvent: true,
  attrs: { x, y, text, align: 'center', baseline },
  styles: { color: '#ffffff', backgroundColor: bg, size: 12, family: TAG_FONT, weight: 'normal', borderRadius: 2, paddingLeft: 6, paddingRight: 6, paddingTop: 3, paddingBottom: 3 },
});

const num = (v: number): string => (v < 0 ? '-' : '') + Math.abs(v).toFixed(2);
const TICK = 0.01; // price shown to 2 decimals, so 1 tick = 0.01

function positionFigures(kind: PositionKind, o: Overlay<PosExt>, cs: { x: number; y: number }[]): OverlayFigure[] {
  if (cs.length < 3 || o.points.length < 3) return [];
  const dir = kind === 'longPosition' ? 1 : -1;
  const entry = o.points[0].value!, target = o.points[1].value!, stop = o.points[2].value!;
  const ext = o.extendData;
  const qty = ext.lots * hooks.contract();
  const closed = ext.state === 'closed';
  const x0 = cs[0].x;
  const x1 = Math.max(cs[1].x, x0 + 30);
  const w = x1 - x0, xm = x0 + w / 2;
  const yE = cs[0].y, yT = cs[1].y, yS = cs[2].y;
  const reward = (target - entry) * dir, risk = (entry - stop) * dir;
  const rr = risk > 0 ? reward / risk : 0;
  const a = closed ? 0.08 : 0.2;
  const figs: OverlayFigure[] = [
    { type: 'rect', attrs: { x: x0, y: Math.min(yE, yT), width: w, height: Math.abs(yT - yE) }, styles: { style: 'fill', color: `rgba(8,153,129,${a})` } },
    { type: 'rect', attrs: { x: x0, y: Math.min(yE, yS), width: w, height: Math.abs(yS - yE) }, styles: { style: 'fill', color: `rgba(242,54,69,${a})` } },
  ];
  // Darker band from the entry to the current price = open P&L, clipped to the box (as on TradingView).
  const m = hooks.mid();
  const yM = o.points.length && m !== null ? pricePixel(cs, o, m) : null;
  if (!closed && yM !== null) {
    const top = Math.max(Math.min(yE, yM), Math.min(yT, yS)), bot = Math.min(Math.max(yE, yM), Math.max(yT, yS));
    if (bot > top) figs.push({ type: 'rect', ignoreEvent: true, attrs: { x: x0, y: top, width: w, height: bot - top }, styles: { style: 'fill', color: (m! - entry) * dir >= 0 ? 'rgba(8,153,129,0.28)' : 'rgba(242,54,69,0.28)' } });
  }
  figs.push({ type: 'line', attrs: { coordinates: [{ x: x0, y: yE }, { x: x1, y: yE }] }, styles: { style: 'solid', color: ext.state === 'live' ? C.accent : '#9598a1', size: ext.state === 'live' ? 2 : 1 } });

  const tgtText = `Target: ${num(reward)} (${((reward / entry) * 100).toFixed(2)}%) ${Math.round(reward / TICK)}, Amount: ${num(reward * qty)}`;
  const stpText = `Stop: ${num(risk)} (${((risk / entry) * 100).toFixed(2)}%) ${Math.round(risk / TICK)}, Amount: ${num(risk * qty)}`;
  const tAbove = yT < yE;
  figs.push(label(xm, yT + (tAbove ? -3 : 3), tgtText, closed ? C.muted : C.up, tAbove ? 'bottom' : 'top'));
  figs.push(label(xm, yS + (tAbove ? 3 : -3), stpText, closed ? C.muted : C.down, tAbove ? 'top' : 'bottom'));

  const pnl = m === null ? 0 : (m - entry) * dir * qty;
  const line1 = closed ? (ext.result ?? 'Closed') : `${ext.state === 'live' ? `#${ext.ticket} · ` : ''}Open P&L: ${num(pnl)}, Qty: ${ext.lots.toFixed(2)} lots`;
  const line2 = closed ? `Risk/reward ratio: ${rr.toFixed(2)}` : `Risk/reward ratio: ${rr.toFixed(2)}${ext.state === 'plan' ? ' · not placed' : ''}`;
  const bg = closed ? C.muted : pnl >= 0 ? C.up : C.down;
  // two-line centre tag on the entry line, on the stop side so it doesn't cover the target tag
  const sgn = tAbove ? 1 : -1;
  figs.push(label(xm, yE + sgn * 3, tAbove ? line1 : line2, bg, tAbove ? 'top' : 'bottom'));
  figs.push(label(xm, yE + sgn * 22, tAbove ? line2 : line1, bg, tAbove ? 'top' : 'bottom'));
  return figs;
}

/** Pixel y of a price, interpolated from the overlay's own points (no chart access needed inside figures). */
function pricePixel(cs: { y: number }[], o: Overlay<PosExt>, price: number): number | null {
  const v0 = o.points[0].value!, v1 = o.points[1].value!;
  if (v1 === v0) return null;
  return cs[0].y + ((price - v0) / (v1 - v0)) * (cs[1].y - cs[0].y);
}

/** Keep the right edge shared and the target/stop on their correct sides of the entry. */
function syncPoints(kind: PositionKind, points: Array<Partial<Point>>, moved: number): void {
  if (points.length < 3) return;
  const src = moved === 2 ? points[2] : points[1];
  const dst = moved === 2 ? points[1] : points[2];
  if (moved !== 0) { dst.timestamp = src.timestamp; dst.dataIndex = src.dataIndex; }
  const entry = points[0].value!, gap = Math.max(0.01, entry * 0.0005);
  if (kind === 'longPosition') {
    points[1].value = Math.max(points[1].value!, entry + gap);
    points[2].value = Math.min(points[2].value!, entry - gap);
  } else {
    points[1].value = Math.min(points[1].value!, entry - gap);
    points[2].value = Math.max(points[2].value!, entry + gap);
  }
}

let registered = false;

export function registerCustomOverlays(): void {
  if (registered) return;
  registered = true;
  for (const kind of ['longPosition', 'shortPosition'] as const) {
    registerOverlay<PosExt>({
      name: kind,
      totalStep: 2, // one click places the entry; the app then sizes the box
      needDefaultPointFigure: true,
      needDefaultXAxisFigure: false,
      needDefaultYAxisFigure: true,
      createPointFigures: ({ overlay, coordinates }) => positionFigures(kind, overlay, coordinates),
      performEventPressedMove: ({ points, performPointIndex }) => syncPoints(kind, points, performPointIndex),
      onDrawEnd: e => hooks.onPositionDrawn(e.overlay),
      onSelected: e => hooks.onPositionSelected(e.overlay),
      onDeselected: () => hooks.onPositionSelected(null),
      onPressedMoveEnd: e => hooks.onPositionMoved(e.overlay),
    });
  }

  registerOverlay<LineExt>({
    name: 'gtPriceLine',
    totalStep: 2,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: true,
    createPointFigures: ({ overlay, coordinates, bounding }) => {
      const c = coordinates[0];
      if (!c) return [];
      const e = overlay.extendData;
      const color = e.kind === 'entry' ? C.muted : e.kind === 'sl' ? C.down : C.up;
      const value = overlay.points[0].value ?? 0;
      return [
        { type: 'line', attrs: { coordinates: [{ x: 0, y: c.y }, { x: bounding.width, y: c.y }] }, styles: { style: e.kind === 'entry' ? 'dashed' : 'solid', color, size: 1, dashedValue: [4, 3] } },
        { type: 'text', ignoreEvent: true, attrs: { x: bounding.width - 70, y: c.y - 3, text: `#${e.ticket} ${e.kind === 'entry' ? e.side.toUpperCase() : e.kind.toUpperCase()} ${value.toFixed(2)}${e.kind === 'entry' ? '' : ' ⇕'}`, align: 'right', baseline: 'bottom' },
          styles: { color: '#ffffff', backgroundColor: color, size: 11, family: 'Roboto Mono, monospace', borderRadius: 2, paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2 } },
      ];
    },
    onPressedMoveEnd: e => hooks.onLineMoved(e.overlay),
  });
}
