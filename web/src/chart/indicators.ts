// Custom indicators not built into KLineChart: ATR (Wilder RMA, as in the TradingView screen recording) and
// EMA bands (Keltner channel: EMA ± k x ATR). Built-ins used as-is: EMA, BOLL, SAR, VOL, RSI, MACD, KDJ.
import { registerIndicator, type KLineData } from 'klinecharts';

/** True range series (first bar uses high - low). */
export function trueRange(d: Pick<KLineData, 'high' | 'low' | 'close'>[]): number[] {
  return d.map((k, i) => (i === 0 ? k.high - k.low : Math.max(k.high - k.low, Math.abs(k.high - d[i - 1].close), Math.abs(k.low - d[i - 1].close))));
}

/** Wilder's RMA: seeded with the SMA of the first n values, then rma = (prev x (n-1) + v) / n. */
export function rma(values: number[], n: number): (number | undefined)[] {
  const out: (number | undefined)[] = [];
  let acc = 0;
  let prev: number | undefined;
  values.forEach((v, i) => {
    if (i < n) {
      acc += v;
      if (i === n - 1) prev = acc / n;
      out.push(prev);
      return;
    }
    prev = (prev! * (n - 1) + v) / n;
    out.push(prev);
  });
  return out;
}

export function ema(values: number[], n: number): (number | undefined)[] {
  const out: (number | undefined)[] = [];
  const k = 2 / (n + 1);
  let prev: number | undefined;
  let acc = 0;
  values.forEach((v, i) => {
    if (i < n) {
      acc += v;
      if (i === n - 1) prev = acc / n;
      out.push(prev);
      return;
    }
    prev = v * k + prev! * (1 - k);
    out.push(prev);
  });
  return out;
}

let registered = false;

export function registerCustomIndicators(): void {
  if (registered) return;
  registered = true;

  registerIndicator<{ atr?: number }, number>({
    name: 'ATR',
    shortName: 'ATR',
    calcParams: [14],
    precision: 4,
    figures: [{ key: 'atr', title: 'ATR: ', type: 'line' }],
    calc: (dataList, indicator) => {
      const n = indicator.calcParams[0];
      return rma(trueRange(dataList), n).map(atr => ({ atr }));
    },
  });

  registerIndicator<{ up?: number; mid?: number; dn?: number }, number>({
    name: 'EMABANDS',
    shortName: 'EMA bands',
    series: 'price',
    calcParams: [20, 2, 10],
    precision: 2,
    figures: [
      { key: 'up', title: 'Upper: ', type: 'line' },
      { key: 'mid', title: 'EMA: ', type: 'line' },
      { key: 'dn', title: 'Lower: ', type: 'line' },
    ],
    calc: (dataList, indicator) => {
      const [n, mult, atrN] = indicator.calcParams;
      const mids = ema(dataList.map(d => d.close), n);
      const atr = rma(trueRange(dataList), atrN);
      return mids.map((mid, i) => (mid === undefined || atr[i] === undefined
        ? {}
        : { mid, up: mid + mult * atr[i]!, dn: mid - mult * atr[i]! }));
    },
  });
}

export interface IndicatorChoice {
  name: string;
  label: string;
  /** one-line plain description shown in the Indicators dialog */
  about: string;
  group: 'Trend' | 'Volatility' | 'Momentum' | 'Volume';
  pane: 'main' | 'sub';
  calcParams?: number[];
}

/** Every KLineChart built-in indicator plus our ATR and EMA bands (TradingView-style catalogue). */
export const INDICATOR_CHOICES: IndicatorChoice[] = [
  { name: 'EMA', label: 'Exponential Moving Average (20, 50)', about: 'Two smoothed price averages; recent bars count more.', group: 'Trend', pane: 'main', calcParams: [20, 50] },
  { name: 'MA', label: 'Moving Average (5, 10, 30, 60)', about: 'Simple averages of the last N closes.', group: 'Trend', pane: 'main' },
  { name: 'SMA', label: 'Smoothed Moving Average', about: 'A slower, smoothed average of price.', group: 'Trend', pane: 'main' },
  { name: 'EMABANDS', label: 'EMA Bands (Keltner 20, 2×ATR)', about: 'EMA 20 with bands two ATRs above and below.', group: 'Volatility', pane: 'main' },
  { name: 'BOLL', label: 'Bollinger Bands (20, 2)', about: 'Average with bands two standard deviations wide.', group: 'Volatility', pane: 'main' },
  { name: 'SAR', label: 'Parabolic SAR', about: 'Trailing dots that flip side when price reverses.', group: 'Trend', pane: 'main' },
  { name: 'BBI', label: 'Bull and Bear Index', about: 'Average of four moving averages.', group: 'Trend', pane: 'main' },
  { name: 'AVP', label: 'Average Price', about: 'Running average traded price of the session.', group: 'Trend', pane: 'main' },
  { name: 'VOL', label: 'Volume (synthetic)', about: 'Synthetic volume: bigger candles get bigger bars.', group: 'Volume', pane: 'sub' },
  { name: 'ATR', label: 'Average True Range (5, RMA)', about: 'Average candle range: how much price is moving.', group: 'Volatility', pane: 'sub', calcParams: [5] },
  { name: 'RSI', label: 'Relative Strength Index (14)', about: 'Speed of recent up vs down moves, 0 to 100.', group: 'Momentum', pane: 'sub', calcParams: [14] },
  { name: 'MACD', label: 'MACD (12, 26, 9)', about: 'Gap between two EMAs, with a signal line.', group: 'Momentum', pane: 'sub' },
  { name: 'KDJ', label: 'Stochastic (KDJ 9, 3, 3)', about: 'Where the close sits inside the recent range.', group: 'Momentum', pane: 'sub' },
  { name: 'CCI', label: 'Commodity Channel Index', about: 'How far price is from its average, in typical deviations.', group: 'Momentum', pane: 'sub' },
  { name: 'DMI', label: 'Directional Movement (DMI / ADX)', about: 'Strength and direction of a trend.', group: 'Trend', pane: 'sub' },
  { name: 'WR', label: 'Williams %R', about: 'Close relative to the recent high-low range.', group: 'Momentum', pane: 'sub' },
  { name: 'ROC', label: 'Rate of Change', about: 'Percent change over the last N bars.', group: 'Momentum', pane: 'sub' },
  { name: 'MTM', label: 'Momentum', about: 'Price now minus price N bars ago.', group: 'Momentum', pane: 'sub' },
  { name: 'TRIX', label: 'TRIX', about: 'Rate of change of a triple-smoothed average.', group: 'Momentum', pane: 'sub' },
  { name: 'AO', label: 'Awesome Oscillator', about: 'Fast vs slow average of the bar midpoints.', group: 'Momentum', pane: 'sub' },
  { name: 'BIAS', label: 'Bias Ratio', about: 'Percent distance of price from its averages.', group: 'Momentum', pane: 'sub' },
  { name: 'PSY', label: 'Psychological Line', about: 'Share of up bars in the last N.', group: 'Momentum', pane: 'sub' },
  { name: 'DMA', label: 'Different of Moving Average', about: 'Gap between a short and a long average.', group: 'Trend', pane: 'sub' },
  { name: 'BRAR', label: 'BRAR (sentiment)', about: 'Buying vs selling pressure from opens and closes.', group: 'Momentum', pane: 'sub' },
  { name: 'CR', label: 'Energy Index (CR)', about: 'Pressure measured from the previous midpoint.', group: 'Momentum', pane: 'sub' },
  { name: 'OBV', label: 'On Balance Volume', about: 'Running total of volume on up minus down bars.', group: 'Volume', pane: 'sub' },
  { name: 'VR', label: 'Volume Ratio', about: 'Volume on up bars vs down bars.', group: 'Volume', pane: 'sub' },
  { name: 'PVT', label: 'Price Volume Trend', about: 'Volume weighted by percent price change.', group: 'Volume', pane: 'sub' },
  { name: 'EMV', label: 'Ease of Movement', about: 'How easily price moves per unit of volume.', group: 'Volume', pane: 'sub' },
];

export const DEFAULT_INDICATORS = ['EMA', 'VOL', 'ATR'];
