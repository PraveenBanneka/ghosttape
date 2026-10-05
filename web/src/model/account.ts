// MT5-style demo account (SPEC section "Account" + addendum item 4). Hedging: several positions at once.
//   bid = mid - spread/2, ask = mid + spread/2 (spread is 0 for now, set in limits.jsonc)
//   BUY opens at ask, closes at bid. SELL opens at bid, closes at ask.
//   P&L    = (close - open) x dir x lots x contract        dir = +1 buy, -1 sell
//   Margin = lots x contract x openPrice / leverage
//   Equity = balance + floating P&L;  Free margin = equity - margin;  Margin level = equity / margin x 100
// SL/TP are checked on every tick at the closing-side price. A tick that gaps past a level fills at that tick's
// price, not at the level; the difference is reported as slippage. Below the stop-out level the position with
// the largest loss is closed first, then the account is re-checked.

import { PRICE_DECIMALS } from './engine';

export interface AccountConfig {
  spread: number;
  leverage: number;
  contract_size: number;
  start_balance: number;
  min_lots: number;
  max_lots: number;
  margin_call_level_pct: number;
  stop_out_level_pct: number;
}

export type Side = 'buy' | 'sell';
export type CloseReason = 'manual' | 'sl' | 'tp' | 'stopout';

export interface Position {
  ticket: number;
  side: Side;
  lots: number;
  openPrice: number;
  openTime: number;
  sl: number | null;
  tp: number | null;
}

export interface Deal extends Position {
  closePrice: number;
  closeTime: number;
  pnl: number;
  reason: CloseReason;
  /** price the SL/TP level asked for (null for manual / stop-out) */
  level: number | null;
  /** (fill - level) x dir: negative = filled worse than the level, positive = better */
  slippage: number;
}

export type JournalKind = 'open' | 'close' | 'sl' | 'tp' | 'stopout' | 'modify' | 'reject' | 'margincall' | 'info' | 'regime' | 'entropy' | 'entropy-bad';
export interface JournalEntry {
  time: number;
  kind: JournalKind;
  text: string;
}

export interface Snapshot {
  balance: number;
  equity: number;
  floating: number;
  margin: number;
  freeMargin: number;
  /** null when no positions are open (MT5 shows "—") */
  marginLevel: number | null;
  marginCall: boolean;
}

export interface AccountState {
  balance: number;
  positions: Position[];
  history: Deal[];
  journal: JournalEntry[];
  nextTicket: number;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface Stops {
  sl: number | null;
  tp: number | null;
}

const FIRST_TICKET = 1000001;
const JOURNAL_MAX = 500;
const fmt = (v: number): string => v.toFixed(PRICE_DECIMALS);
const usd = (v: number): string => (v < 0 ? '-$' : '+$') + Math.abs(v).toFixed(2);

export class Account {
  balance: number;
  positions: Position[] = [];
  history: Deal[] = [];
  journal: JournalEntry[] = [];
  nextTicket = FIRST_TICKET;
  private inMarginCall = false;

  constructor(readonly cfg: AccountConfig, state?: AccountState) {
    this.balance = cfg.start_balance;
    if (state) Object.assign(this, structuredClone(state));
  }

  bid(mid: number): number { return mid - this.cfg.spread / 2; }
  ask(mid: number): number { return mid + this.cfg.spread / 2; }
  entryPrice(side: Side, mid: number): number { return side === 'buy' ? this.ask(mid) : this.bid(mid); }
  exitPrice(side: Side, mid: number): number { return side === 'buy' ? this.bid(mid) : this.ask(mid); }
  static dir(side: Side): 1 | -1 { return side === 'buy' ? 1 : -1; }

  pnl(p: Position, mid: number): number {
    return (this.exitPrice(p.side, mid) - p.openPrice) * Account.dir(p.side) * p.lots * this.cfg.contract_size;
  }
  marginOf(p: Pick<Position, 'lots' | 'openPrice'>): number {
    return (p.lots * this.cfg.contract_size * p.openPrice) / this.cfg.leverage;
  }
  requiredMargin(side: Side, lots: number, mid: number): number {
    return this.marginOf({ lots, openPrice: this.entryPrice(side, mid) });
  }

  snapshot(mid: number): Snapshot {
    let floating = 0;
    let margin = 0;
    for (const p of this.positions) {
      floating += this.pnl(p, mid);
      margin += this.marginOf(p);
    }
    const equity = this.balance + floating;
    const marginLevel = margin > 0 ? (equity / margin) * 100 : null;
    return {
      balance: this.balance, equity, floating, margin, freeMargin: equity - margin, marginLevel,
      marginCall: marginLevel !== null && marginLevel < this.cfg.margin_call_level_pct,
    };
  }

  validateLots(lots: number): string | null {
    if (!Number.isFinite(lots)) return 'Volume must be a number.';
    if (Math.abs(lots * 100 - Math.round(lots * 100)) > 1e-9) return 'Volume must be in steps of 0.01 lots.';
    if (lots < this.cfg.min_lots - 1e-12) return `Minimum volume is ${this.cfg.min_lots.toFixed(2)} lots.`;
    if (lots > this.cfg.max_lots + 1e-12) return `Maximum volume is ${this.cfg.max_lots.toFixed(2)} lots.`;
    return null;
  }

  /** MT5 rule: a BUY's SL must be below and TP above the bid; a SELL's SL above and TP below the ask. */
  validateStops(side: Side, s: Stops, mid: number): string | null {
    for (const [name, v] of [['Stop loss', s.sl], ['Take profit', s.tp]] as const) {
      if (v !== null && !(Number.isFinite(v) && v > 0)) return `${name} must be a positive price.`;
    }
    const px = this.exitPrice(side, mid);
    const where = side === 'buy' ? `bid ${fmt(px)}` : `ask ${fmt(px)}`;
    if (side === 'buy') {
      if (s.sl !== null && s.sl >= px) return `Stop loss for a BUY must be below the current ${where}.`;
      if (s.tp !== null && s.tp <= px) return `Take profit for a BUY must be above the current ${where}.`;
    } else {
      if (s.sl !== null && s.sl <= px) return `Stop loss for a SELL must be above the current ${where}.`;
      if (s.tp !== null && s.tp >= px) return `Take profit for a SELL must be below the current ${where}.`;
    }
    return null;
  }

  open(side: Side, lots: number, stops: Stops, mid: number, time: number): Result<Position> {
    lots = Math.round(lots * 100) / 100;
    const err = this.validateLots(lots) ?? this.validateStops(side, stops, mid);
    if (err) return this.reject(err, time);
    const need = this.requiredMargin(side, lots, mid);
    const free = this.snapshot(mid).freeMargin;
    if (need > free) return this.reject(`Not enough free margin: need $${need.toFixed(2)}, have $${free.toFixed(2)}.`, time);
    const p: Position = { ticket: this.nextTicket++, side, lots, openPrice: this.entryPrice(side, mid), openTime: time, sl: stops.sl, tp: stops.tp };
    this.positions.push(p);
    this.log(time, 'open', `OPEN #${p.ticket} ${side.toUpperCase()} ${lots.toFixed(2)} @ ${fmt(p.openPrice)}` +
      (p.sl !== null ? ` SL ${fmt(p.sl)}` : '') + (p.tp !== null ? ` TP ${fmt(p.tp)}` : ''));
    return { ok: true, value: p };
  }

  modify(ticket: number, stops: Stops, mid: number, time: number): Result<Position> {
    const p = this.positions.find(x => x.ticket === ticket);
    if (!p) return this.reject(`Position #${ticket} is not open.`, time);
    const err = this.validateStops(p.side, stops, mid);
    if (err) return this.reject(err, time);
    p.sl = stops.sl;
    p.tp = stops.tp;
    this.log(time, 'modify', `MODIFY #${ticket} SL ${p.sl !== null ? fmt(p.sl) : '—'} TP ${p.tp !== null ? fmt(p.tp) : '—'}`);
    return { ok: true, value: p };
  }

  close(ticket: number, mid: number, time: number): Result<Deal> {
    const i = this.positions.findIndex(x => x.ticket === ticket);
    if (i < 0) return this.reject(`Position #${ticket} is not open.`, time);
    const p = this.positions[i];
    return { ok: true, value: this.settle(i, this.exitPrice(p.side, mid), time, 'manual', null) };
  }

  /** Call on every tick. Fills SL/TP (with gap slippage), then applies stop-out. Returns the deals closed. */
  onPrice(mid: number, time: number): Deal[] {
    const closed: Deal[] = [];
    for (let i = this.positions.length - 1; i >= 0; i--) {
      const p = this.positions[i];
      const px = this.exitPrice(p.side, mid);
      const hitSl = p.sl !== null && (p.side === 'buy' ? px <= p.sl : px >= p.sl);
      const hitTp = p.tp !== null && (p.side === 'buy' ? px >= p.tp : px <= p.tp);
      if (hitSl) closed.push(this.settle(i, px, time, 'sl', p.sl));
      else if (hitTp) closed.push(this.settle(i, px, time, 'tp', p.tp));
    }
    for (let guard = this.positions.length; guard > 0; guard--) {
      const s = this.snapshot(mid);
      if (s.marginLevel === null || s.marginLevel >= this.cfg.stop_out_level_pct) break;
      let worst = 0;
      for (let i = 1; i < this.positions.length; i++) if (this.pnl(this.positions[i], mid) < this.pnl(this.positions[worst], mid)) worst = i;
      closed.push(this.settle(worst, this.exitPrice(this.positions[worst].side, mid), time, 'stopout', null, s.marginLevel));
    }
    const s = this.snapshot(mid);
    if (s.marginCall && !this.inMarginCall) {
      this.log(time, 'margincall', `MARGIN CALL: margin level ${s.marginLevel!.toFixed(0)}%. Positions stop out below ${this.cfg.stop_out_level_pct}%.`);
    }
    this.inMarginCall = s.marginCall;
    return closed;
  }

  reset(time: number): void {
    this.balance = this.cfg.start_balance;
    this.positions = [];
    this.history = [];
    this.journal = [];
    this.nextTicket = FIRST_TICKET;
    this.inMarginCall = false;
    this.log(time, 'info', `Account reset to $${this.cfg.start_balance.toFixed(2)}`);
  }

  state(): AccountState {
    return structuredClone({ balance: this.balance, positions: this.positions, history: this.history, journal: this.journal, nextTicket: this.nextTicket });
  }

  private settle(i: number, price: number, time: number, reason: CloseReason, level: number | null, marginLevel?: number): Deal {
    const p = this.positions[i];
    const pnl = (price - p.openPrice) * Account.dir(p.side) * p.lots * this.cfg.contract_size;
    const slippage = level === null ? 0 : (price - level) * Account.dir(p.side);
    const deal: Deal = { ...p, closePrice: price, closeTime: time, pnl, reason, level, slippage };
    this.positions.splice(i, 1);
    this.balance += pnl;
    this.history.unshift(deal);
    const what = { manual: 'CLOSE', sl: 'SL HIT', tp: 'TP HIT', stopout: 'STOP OUT' }[reason];
    let text = `${what} #${p.ticket} ${p.side.toUpperCase()} ${p.lots.toFixed(2)} @ ${fmt(price)} → ${usd(pnl)}`;
    if (level !== null) text += ` (level ${fmt(level)}, slippage ${slippage >= 0 ? '+' : ''}${slippage.toFixed(4)})`;
    if (marginLevel !== undefined) text += ` (margin level ${marginLevel.toFixed(0)}%)`;
    this.log(time, reason === 'manual' ? 'close' : reason, text);
    return deal;
  }

  private reject<T>(error: string, time: number): Result<T> {
    this.log(time, 'reject', `REJECTED: ${error}`);
    return { ok: false, error };
  }

  log(time: number, kind: JournalKind, text: string): void {
    this.journal.unshift({ time, kind, text });
    if (this.journal.length > JOURNAL_MAX) this.journal.length = JOURNAL_MAX;
  }
}
