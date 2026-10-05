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
  pane: 'main' | 'sub';
  calcParams?: number[];
}

export const INDICATOR_CHOICES: IndicatorChoice[] = [
  { name: 'EMA', label: 'EMA 20 / 50', pane: 'main', calcParams: [20, 50] },
  { name: 'EMABANDS', label: 'EMA bands (Keltner 20, 2×ATR)', pane: 'main' },
  { name: 'BOLL', label: 'Bollinger Bands 20, 2', pane: 'main' },
  { name: 'SAR', label: 'Parabolic SAR', pane: 'main' },
  { name: 'VOL', label: 'Volume (synthetic)', pane: 'sub' },
  { name: 'ATR', label: 'ATR 5 (RMA)', pane: 'sub', calcParams: [5] },
  { name: 'RSI', label: 'RSI 14', pane: 'sub', calcParams: [14] },
  { name: 'MACD', label: 'MACD 12, 26, 9', pane: 'sub' },
  { name: 'KDJ', label: 'Stochastic KDJ 9, 3, 3', pane: 'sub' },
];

export const DEFAULT_INDICATORS = ['EMA', 'VOL', 'ATR'];
