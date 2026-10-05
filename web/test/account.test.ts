import { describe, expect, it } from 'vitest';
import { Account, type AccountConfig } from '../src/model/account';
import { LIMITS } from '../src/config';

const CFG: AccountConfig = { ...LIMITS.trading, spread: 0 };
const withSpread = (spread: number): AccountConfig => ({ ...CFG, spread });
const none = { sl: null, tp: null };

describe('SPEC sanity examples', () => {
  it('0.10 lot at 100.00 needs $10.00 margin', () => {
    const a = new Account(CFG);
    expect(a.requiredMargin('buy', 0.1, 100)).toBeCloseTo(10, 10);
    const r = a.open('buy', 0.1, none, 100, 0);
    expect(r.ok && a.marginOf(r.value)).toBeCloseTo(10, 10);
  });
  it('0.10 lot moving 1.00 in price is $10.00 P&L', () => {
    const a = new Account(CFG);
    const r = a.open('buy', 0.1, none, 100, 0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(a.pnl(r.value, 101)).toBeCloseTo(10, 10);
  });
  it('1.00 lot BUY at ask 100.01 instantly closed at bid 99.99 is -$2.00 (spread 0.02)', () => {
    const a = new Account(withSpread(0.02));
    const r = a.open('buy', 1, none, 100, 0);
    expect(r.ok && r.value.openPrice).toBeCloseTo(100.01, 10);
    const d = a.close(1000001, 100, 1);
    expect(d.ok && d.value.closePrice).toBeCloseTo(99.99, 10);
    expect(d.ok && d.value.pnl).toBeCloseTo(-2, 10);
    expect(a.balance).toBeCloseTo(9998, 10);
  });
  it('spread 0 (owner default): BUY and SELL fill at the same price', () => {
    const a = new Account(CFG);
    const b = a.open('buy', 0.1, none, 100.42, 0), s = a.open('sell', 0.1, none, 100.42, 0);
    expect(b.ok && s.ok && b.value.openPrice === s.value.openPrice).toBe(true);
  });
});

describe('orders', () => {
  it('tickets start at 1000001 and increase; hedging allows several positions', () => {
    const a = new Account(CFG);
    a.open('buy', 0.1, none, 100, 0);
    a.open('sell', 0.2, none, 100, 0);
    expect(a.positions.map(p => p.ticket)).toEqual([1000001, 1000002]);
  });
  it('rejects SL/TP on the wrong side with a message (never silently)', () => {
    const a = new Account(CFG);
    for (const [side, stops] of [['buy', { sl: 101, tp: null }], ['buy', { sl: null, tp: 99 }], ['sell', { sl: 99, tp: null }], ['sell', { sl: null, tp: 101 }]] as const) {
      const r = a.open(side, 0.1, stops, 100, 0);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/must be (below|above) the current (bid|ask)/);
    }
    expect(a.positions).toHaveLength(0);
    expect(a.journal.filter(j => j.kind === 'reject')).toHaveLength(4);
  });
  it('validates volume: min, max, 0.01 steps', () => {
    const a = new Account(CFG);
    expect(a.validateLots(0)).toMatch(/Minimum/);
    expect(a.validateLots(0.005)).toMatch(/steps/);
    expect(a.validateLots(5.01)).toMatch(/Maximum/);
    expect(a.validateLots(0.015)).toMatch(/steps/);
    expect(a.validateLots(0.07)).toBeNull();
  });
  it('rejects an order without enough free margin', () => {
    const a = new Account({ ...CFG, max_lots: 1000 });
    const r = a.open('buy', 101, none, 100, 0); // needs $10,100 margin
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Not enough free margin/);
  });
  it('modify validates like open', () => {
    const a = new Account(CFG);
    a.open('buy', 0.1, none, 100, 0);
    expect(a.modify(1000001, { sl: 99, tp: 102 }, 100, 1).ok).toBe(true);
    expect(a.modify(1000001, { sl: 100.5, tp: 102 }, 100, 1).ok).toBe(false);
    expect(a.positions[0].sl).toBe(99);
  });
});

describe('SL/TP per tick with gap slippage (SPEC acceptance)', () => {
  it('a tick that gaps past the SL fills at the gap price, and the journal shows the slippage', () => {
    const a = new Account(CFG);
    a.open('buy', 1, { sl: 99.8, tp: null }, 100, 0);
    expect(a.onPrice(99.9, 1)).toHaveLength(0);
    const [d] = a.onPrice(99.5, 2); // gap straight through 99.80
    expect(d.reason).toBe('sl');
    expect(d.closePrice).toBe(99.5);
    expect(d.level).toBe(99.8);
    expect(d.slippage).toBeCloseTo(-0.3, 10);
    expect(d.pnl).toBeCloseTo(-50, 10);
    expect(a.journal[0].text).toMatch(/SL HIT #1000001 .*level 99\.80, slippage -0\.3000/);
  });
  it('TP for a SELL fills at the first crossing tick (positive slippage possible)', () => {
    const a = new Account(CFG);
    a.open('sell', 0.5, { sl: null, tp: 99 }, 100, 0);
    const [d] = a.onPrice(98.7, 1);
    expect([d.reason, d.closePrice]).toEqual(['tp', 98.7]);
    expect(d.slippage).toBeCloseTo(0.3, 10);
  });
  it('closes on the exact tick it crosses, never on prices from before the entry', () => {
    const a = new Account(CFG);
    a.onPrice(95, 0); // old low before the trade
    a.open('buy', 0.1, { sl: 99, tp: null }, 100, 1);
    expect(a.onPrice(99.5, 2)).toHaveLength(0);
    expect(a.positions).toHaveLength(1);
  });
});

describe('margin call and stop-out (SPEC acceptance)', () => {
  it('margin call below 100%, stop-out below 50% closes the largest loser first', () => {
    const a = new Account(CFG);
    // margin: 9 lots x 100 x 100 / 100 = $900 each side-ish; use buys so a drop hurts all
    a.open('buy', 5, none, 100, 0);   // margin $500
    a.open('buy', 4, none, 100, 0);   // margin $400 -> total $900
    a.open('sell', 1, none, 100, 0);  // margin $100 -> total $1000, profits on the drop
    // equity = 10000 + (p-100)*(500+400-100) = 10000 + 800(p-100); margin 1000
    a.onPrice(89, 1); // equity 1200 -> 120%: fine
    expect(a.snapshot(89).marginCall).toBe(false);
    a.onPrice(88.5, 2); // equity 800 -> 80%: margin call
    expect(a.snapshot(88.5).marginCall).toBe(true);
    expect(a.journal[0].kind).toBe('margincall');
    const closed = a.onPrice(87.9, 3); // equity 320 -> 32%: stop out
    expect(closed[0].ticket).toBe(1000001); // 5-lot buy = largest loss
    expect(closed.every(d => d.reason === 'stopout')).toBe(true);
    const s = a.snapshot(87.9);
    expect(s.marginLevel === null || s.marginLevel >= 50).toBe(true);
  });
  it('margin level is null with no positions (shown as "—")', () => {
    expect(new Account(CFG).snapshot(100).marginLevel).toBeNull();
  });
});

describe('persistence', () => {
  it('state round-trips through JSON (localStorage)', () => {
    const a = new Account(CFG);
    a.open('buy', 0.3, { sl: 99, tp: 101 }, 100, 0);
    a.onPrice(101.2, 1);
    const b = new Account(CFG, JSON.parse(JSON.stringify(a.state())));
    expect(b.state()).toEqual(a.state());
    expect(b.nextTicket).toBe(1000002);
  });
});
