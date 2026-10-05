// Left drawing-tool rail + a draggable favourites bar (star a tool to add it), like TradingView.
import { getSupportedOverlays, type Chart, type OverlayMode } from 'klinecharts';

export interface ToolDef {
  id: string;
  label: string;
  /** inner SVG markup on a 28x28 grid; drawn in TradingView's style (1px strokes, hollow anchor circles).
   *  Our own drawings: TradingView's icon artwork is proprietary and is not copied. */
  icon: string;
}

// small hollow anchor circle, the TradingView convention for a draggable point
const dot = (x: number, y: number): string => `<circle cx="${x}" cy="${y}" r="2" fill="var(--bg,#fff)"/>`;

export const TOOLS: ToolDef[] = [
  { id: 'cursor', label: 'Cross', icon: '<path d="M14 4v8M14 16v8M4 14h8M16 14h8"/>' },
  { id: 'segment', label: 'Trend line', icon: `<path d="M8.5 19.5l11-11"/>${dot(7, 21)}${dot(21, 7)}` },
  { id: 'rayLine', label: 'Ray', icon: `<path d="M8.5 19.5L25 3"/>${dot(7, 21)}${dot(16, 12)}` },
  { id: 'straightLine', label: 'Extended line', icon: `<path d="M3 25l7.5-7.5M12.5 15.5l3-3M17.5 10.5L25 3"/>${dot(11.5, 16.5)}${dot(16.5, 11.5)}` },
  { id: 'horizontalStraightLine', label: 'Horizontal line', icon: `<path d="M3 14h9M16 14h9"/>${dot(14, 14)}` },
  { id: 'horizontalRayLine', label: 'Horizontal ray', icon: `<path d="M10 14h15"/>${dot(8, 14)}` },
  { id: 'verticalStraightLine', label: 'Vertical line', icon: `<path d="M14 3v9M14 16v9"/>${dot(14, 14)}` },
  { id: 'priceLine', label: 'Price line', icon: `<path d="M3 15h13"/>${dot(5, 15)}<path d="M16 11h9v8h-9z"/>` },
  { id: 'parallelStraightLine', label: 'Parallel channel', icon: `<path d="M4 15L15 4M13 24l11-11"/>${dot(4, 15)}${dot(15, 4)}${dot(24, 13)}<path d="M8 20l11-11" stroke-dasharray="2 2"/>` },
  { id: 'priceChannelLine', label: 'Price channel', icon: `<path d="M4 12l20-6M4 22l20-6"/>${dot(4, 12)}${dot(24, 6)}${dot(4, 22)}` },
  { id: 'fibonacciLine', label: 'Fib retracement', icon: `<path d="M3 5h22M3 11h22M3 17h22M3 23h22"/><path d="M6 23L22 5" stroke-dasharray="2 2"/>${dot(6, 23)}${dot(22, 5)}` },
  { id: 'longPosition', label: 'Long position', icon: '<path d="M4 6h20v16H4zM4 14h20"/><path d="M9 11.5l3-3 3 3M12 8.5v4" stroke-width="1.2"/>' },
  { id: 'shortPosition', label: 'Short position', icon: '<path d="M4 6h20v16H4zM4 14h20"/><path d="M9 16.5l3 3 3-3M12 19.5v-4" stroke-width="1.2"/>' },
];
const POSITION_TOOLS = new Set(['longPosition', 'shortPosition']);

const FAV_KEY = 'gt.favTools';
const FAVPOS_KEY = 'gt.favbarPos';
const load = <T>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d; } catch { return d; } };
const save = (k: string, v: unknown): void => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } };

const svg = (inner: string): string =>
  `<svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICON_MAGNET = '<path d="M8 5v9a6 6 0 0 0 12 0V5h-4v9a2 2 0 0 1-4 0V5zM8 9h4M16 9h4"/>';
const ICON_LOCK = '<rect x="7" y="13" width="14" height="10" rx="1.5"/><path d="M10 13V9.5a4 4 0 0 1 8 0V13"/>';
const ICON_EYE = '<path d="M3 14s4-7 11-7 11 7 11 7-4 7-11 7S3 14 3 14z"/><circle cx="14" cy="14" r="3"/>';
const ICON_TRASH = '<path d="M5 8h18M11 8V5h6v3M7.5 8l1 15h11l1-15M12 12v7M16 12v7"/>';

export class ToolRail {
  active = 'cursor';
  magnet = false;
  locked = false;
  hidden = false;
  private favs: string[];
  private readonly available: ToolDef[];

  constructor(
    private readonly rail: HTMLElement,
    private readonly favbar: HTMLElement,
    private readonly chart: Chart,
    private readonly onPositionTool: (kind: 'longPosition' | 'shortPosition') => void,
    private readonly onClear: () => void,
  ) {
    const supported = new Set(getSupportedOverlays());
    this.available = TOOLS.filter(t => t.id === 'cursor' || supported.has(t.id));
    this.favs = load<string[]>(FAV_KEY, ['segment', 'horizontalStraightLine', 'longPosition', 'shortPosition']).filter(id => this.available.some(t => t.id === id));
    this.render();
    this.initFavbarDrag();
  }

  /** Called when a drawing finishes, so the rail returns to the cursor like TradingView. */
  done(): void { this.select('cursor'); }

  select(id: string): void {
    this.active = id;
    for (const b of [...this.rail.querySelectorAll<HTMLButtonElement>('[data-tool]'), ...this.favbar.querySelectorAll<HTMLButtonElement>('[data-tool]')]) {
      b.classList.toggle('active', b.dataset.tool === id);
      b.setAttribute('aria-pressed', String(b.dataset.tool === id));
    }
    if (id === 'cursor') return;
    if (POSITION_TOOLS.has(id)) { this.onPositionTool(id as 'longPosition' | 'shortPosition'); return; }
    const mode: OverlayMode = this.magnet ? 'weak_magnet' : 'normal';
    this.chart.createOverlay({ name: id, mode, onDrawEnd: () => this.done() });
  }

  private toolButton(t: ToolDef, withStar: boolean): string {
    const fav = this.favs.includes(t.id);
    return `<button type="button" class="tool" data-tool="${t.id}" title="${t.label}" aria-label="${t.label}" aria-pressed="false">${svg(t.icon)}` +
      (withStar && t.id !== 'cursor' ? `<span class="star${fav ? ' on' : ''}" data-star="${t.id}" title="${fav ? 'Remove from' : 'Add to'} favourites" role="button" aria-label="Toggle favourite">★</span>` : '') + '</button>';
  }

  private render(): void {
    const extra =
      `<div class="rail-sep"></div>` +
      `<button type="button" class="tool${this.magnet ? ' active' : ''}" data-action="magnet" title="Magnet mode (snap to OHLC)" aria-label="Magnet mode" aria-pressed="${this.magnet}">${svg(ICON_MAGNET)}</button>` +
      `<button type="button" class="tool${this.locked ? ' active' : ''}" data-action="lock" title="Lock all drawings" aria-label="Lock all drawings" aria-pressed="${this.locked}">${svg(ICON_LOCK)}</button>` +
      `<button type="button" class="tool${this.hidden ? ' active' : ''}" data-action="hide" title="Hide all drawings" aria-label="Hide all drawings" aria-pressed="${this.hidden}">${svg(ICON_EYE)}</button>` +
      `<button type="button" class="tool" data-action="clear" title="Remove all drawings" aria-label="Remove all drawings">${svg(ICON_TRASH)}</button>`;
    this.rail.innerHTML = this.available.map(t => this.toolButton(t, true)).join('') + extra;
    this.rail.onclick = e => {
      const el = e.target as HTMLElement;
      const star = el.closest<HTMLElement>('[data-star]');
      if (star) { e.stopPropagation(); this.toggleFav(star.dataset.star!); return; }
      const btn = el.closest<HTMLButtonElement>('button');
      if (!btn) return;
      if (btn.dataset.action === 'magnet') {
        this.magnet = !this.magnet;
        btn.classList.toggle('active', this.magnet);
        btn.setAttribute('aria-pressed', String(this.magnet));
        return;
      }
      if (btn.dataset.action === 'lock' || btn.dataset.action === 'hide') {
        if (btn.dataset.action === 'lock') this.locked = !this.locked; else this.hidden = !this.hidden;
        const on = btn.dataset.action === 'lock' ? this.locked : this.hidden;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', String(on));
        // user drawings only: position lines/boxes of open trades stay visible and draggable
        for (const o of this.chart.getOverlays()) {
          if (o.name === 'gtPriceLine' || (o.name.endsWith('Position') && (o.extendData as { state?: string }).state === 'live')) continue;
          this.chart.overrideOverlay({ id: o.id, lock: this.locked, visible: !this.hidden });
        }
        return;
      }
      if (btn.dataset.action === 'clear') { this.onClear(); return; }
      if (btn.dataset.tool) this.select(btn.dataset.tool);
    };
    this.renderFavbar();
  }

  private renderFavbar(): void {
    const tools = this.favs.map(id => this.available.find(t => t.id === id)).filter((t): t is ToolDef => !!t);
    this.favbar.hidden = tools.length === 0;
    this.favbar.innerHTML = `<span class="grip" title="Drag to move" aria-hidden="true">⋮⋮</span>` + tools.map(t => this.toolButton(t, false)).join('');
    this.favbar.onclick = e => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-tool]');
      if (btn) this.select(btn.dataset.tool!);
    };
    const pos = load<{ left: number; top: number } | null>(FAVPOS_KEY, null);
    if (pos) Object.assign(this.favbar.style, { left: `${pos.left}px`, top: `${pos.top}px`, transform: 'none' });
  }

  private toggleFav(id: string): void {
    this.favs = this.favs.includes(id) ? this.favs.filter(f => f !== id) : [...this.favs, id];
    save(FAV_KEY, this.favs);
    this.render();
    this.select(this.active);
  }

  private initFavbarDrag(): void {
    let start: { x: number; y: number; left: number; top: number } | null = null;
    this.favbar.addEventListener('pointerdown', e => {
      if (!(e.target as HTMLElement).classList.contains('grip')) return;
      const r = this.favbar.getBoundingClientRect(), p = this.favbar.offsetParent!.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, left: r.left - p.left, top: r.top - p.top };
      this.favbar.setPointerCapture(e.pointerId);
    });
    this.favbar.addEventListener('pointermove', e => {
      if (!start) return;
      const p = this.favbar.offsetParent as HTMLElement;
      const left = Math.max(0, Math.min(p.clientWidth - this.favbar.offsetWidth, start.left + e.clientX - start.x));
      const top = Math.max(0, Math.min(p.clientHeight - this.favbar.offsetHeight, start.top + e.clientY - start.y));
      Object.assign(this.favbar.style, { left: `${left}px`, top: `${top}px`, transform: 'none' });
    });
    this.favbar.addEventListener('pointerup', () => {
      if (!start) return;
      start = null;
      save(FAVPOS_KEY, { left: this.favbar.offsetLeft, top: this.favbar.offsetTop });
    });
  }
}
