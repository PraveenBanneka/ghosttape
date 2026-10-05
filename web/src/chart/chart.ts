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
    tooltip: { title: { family: FONT, color: '#131722' }, legend: { family: FONT } },
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
