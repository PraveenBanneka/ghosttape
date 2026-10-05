// KLineChart wrapper: light TradingView-like styles, wall-clock periods (1s..5m), live bars via the v10 data loader.
import { init, type Chart, type DeepPartial, type KLineData, type Period, type Styles } from 'klinecharts';
import type { Candle, Timeframe } from '../model/aggregator';
import { PRICE_DECIMALS } from '../model/engine';
import { INDICATOR_CHOICES, registerCustomIndicators } from './indicators';
import { registerCustomOverlays } from './overlays';

export const CANDLE_PANE = 'candle_pane';

const PERIODS: Record<Timeframe['id'], Period> = {
  '1s': { type: 'second', span: 1 },
  '10s': { type: 'second', span: 10 },
  '30s': { type: 'second', span: 30 },
  '1m': { type: 'minute', span: 1 },
  '5m': { type: 'minute', span: 5 },
};

const UP = '#089981', DOWN = '#f23645', FLAT = '#787b86', GRID = '#f0f3fa', TEXT = '#434651';

// TradingView's UI font stack (sans-serif); KLineChart otherwise falls back to a serif on some systems.
const FONT = '-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif';

// TradingView-style legend buttons on every indicator: eye (hide/show) and x (remove). 14 px paths.
const legendButton = (id: string, path: string) => ({
  id, position: 'middle' as const, type: 'path' as const, size: 14,
  marginLeft: 6, marginTop: 0, marginRight: 0, paddingLeft: 2, paddingTop: 2, paddingRight: 2, paddingBottom: 2,
  color: '#787b86', activeColor: '#131722', backgroundColor: 'transparent', activeBackgroundColor: '#e0e3eb', borderRadius: 3,
  content: { style: 'stroke' as const, lineWidth: 1.2, path },
});
const LEGEND_BUTTONS = [
  legendButton('visible', 'M1 7C2.8 3.8 4.8 2.6 7 2.6S11.2 3.8 13 7C11.2 10.2 9.2 11.4 7 11.4S2.8 10.2 1 7ZM7 5.1A1.9 1.9 0 1 0 7 8.9A1.9 1.9 0 1 0 7 5.1Z'),
  legendButton('remove', 'M3 3L11 11M11 3L3 11'),
];

const STYLES: DeepPartial<Styles> = {
  grid: { horizontal: { color: GRID }, vertical: { color: GRID } },
  candle: {
    bar: {
      upColor: UP, downColor: DOWN, noChangeColor: FLAT,
      upBorderColor: UP, downBorderColor: DOWN, noChangeBorderColor: FLAT,
      upWickColor: UP, downWickColor: DOWN, noChangeWickColor: FLAT,
    },
    priceMark: {
      high: { textFamily: FONT, color: TEXT }, low: { textFamily: FONT, color: TEXT },
      last: { upColor: UP, downColor: DOWN, noChangeColor: FLAT, text: { family: FONT } },
    },
    tooltip: { title: { family: FONT, color: '#131722' }, legend: { family: FONT, color: TEXT } },
  },
  indicator: {
    ohlc: { upColor: UP, downColor: DOWN, noChangeColor: FLAT },
    bars: [{ upColor: 'rgba(8,153,129,.55)', downColor: 'rgba(242,54,69,.55)', noChangeColor: FLAT }],
    lastValueMark: { text: { family: FONT } },
    tooltip: { title: { family: FONT, color: '#131722' }, legend: { family: FONT }, features: LEGEND_BUTTONS },
  },
  xAxis: { tickText: { color: TEXT, family: FONT } },
  yAxis: { tickText: { color: TEXT, family: FONT } },
  separator: { color: '#e0e3eb' },
  crosshair: {
    horizontal: { text: { backgroundColor: '#131722', family: FONT } },
    vertical: { text: { backgroundColor: '#131722', family: FONT } },
  },
  overlay: { text: { family: FONT } },
};

const toK = (c: Candle): KLineData => ({ timestamp: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });

export class TapeChart {
  readonly chart: Chart;
  tf: Timeframe['id'];
  private subscriber: ((k: KLineData) => void) | null = null;
  /** called when the user removes an indicator from its legend (x button) */
  onIndicatorRemoved: (name: string) => void = () => {};

  constructor(el: HTMLElement, private readonly barsFor: (tf: Timeframe['id']) => Candle[], tf: Timeframe['id']) {
    registerCustomIndicators();
    registerCustomOverlays();
    const chart = init(el, { styles: STYLES, locale: 'en-US' });
    if (!chart) throw new Error('Chart failed to initialise');
    this.chart = chart;
    this.tf = tf;
    chart.setSymbol({ ticker: 'GHOST/USD', pricePrecision: PRICE_DECIMALS, volumePrecision: 0 });
    chart.setOffsetRightDistance(180); // free space right of the last bar for position boxes and labels, like TradingView
    chart.setPeriod(PERIODS[tf]);
    chart.setDataLoader({
      getBars: ({ type, callback }) => callback(type === 'init' ? this.barsFor(this.tf).map(toK) : [], false),
      subscribeBar: ({ callback }) => { this.subscriber = callback; },
      unsubscribeBar: () => { this.subscriber = null; },
    });
    new ResizeObserver(() => chart.resize()).observe(el);
    chart.subscribeAction('onIndicatorTooltipFeatureClick', data => {
      const d = data as { paneId: string; feature: { id: string }; indicator?: { name: string; visible: boolean } };
      if (!d.indicator) return;
      if (d.feature.id === 'remove') {
        chart.removeIndicator({ paneId: d.paneId, name: d.indicator.name });
        this.onIndicatorRemoved(d.indicator.name);
      } else if (d.feature.id === 'visible') {
        chart.overrideIndicator({ name: d.indicator.name, paneId: d.paneId, visible: !d.indicator.visible });
      }
    });
  }

  setTimeframe(tf: Timeframe['id']): void {
    if (tf === this.tf) return;
    this.tf = tf;
    this.chart.setPeriod(PERIODS[tf]);
  }

  /** Live update of the forming (or a new) bar of the visible timeframe. */
  push(tf: Timeframe['id'], bar: Candle): void {
    if (tf === this.tf) this.subscriber?.(toK(bar));
  }

  /** Reload all bars (new session). */
  reload(): void {
    this.chart.resetData();
  }

  periodMs(): number {
    const p = PERIODS[this.tf];
    return p.span * (p.type === 'minute' ? 60000 : 1000);
  }

  setIndicator(name: string, on: boolean): void {
    const choice = INDICATOR_CHOICES.find(c => c.name === name);
    if (!choice) return;
    const paneId = choice.pane === 'main' ? CANDLE_PANE : `pane_${name}`;
    if (!on) { this.chart.removeIndicator({ paneId, name }); return; }
    this.chart.createIndicator({ name, paneId, ...(choice.calcParams ? { calcParams: choice.calcParams } : {}) }, choice.pane === 'main');
    if (choice.pane === 'sub') this.chart.setPaneOptions({ id: paneId, height: 90, minHeight: 50 });
  }
}
