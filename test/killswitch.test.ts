import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DEMO_POLICY,
  EMPTY_MEMORY,
  deviationBps,
  evaluate,
  onGrid,
  parsePolicy,
  utcDay,
} from '../src/gate/index.js';
import {
  INITIAL_KILL_SWITCH,
  drawdownBps,
  exitBandBps,
  exitPrice,
  onEquity,
  planFlatten,
  reset,
  tripManually,
} from '../src/killswitch/index.js';
import { BTC, NOW, account, policy } from './fixtures.js';

const E = (usd: number) => BigInt(usd) * 10n ** 18n;

describe('drawdown tracking', () => {
  it('raises the peak, trips once at the limit, stays tripped', () => {
    let s = INITIAL_KILL_SWITCH;
    let u = onEquity(s, E(1000), NOW, policy);
    expect(u).toMatchObject({ justTripped: false, drawdownBps: 0n });
    s = onEquity(u.state, E(1100), NOW, policy).state;
    expect(s.peakEquity).toBe(E(1100));
    u = onEquity(s, E(1046), NOW, policy); // 4.9 %
    expect(u.state.tripped).toBe(false);
    expect(u.drawdownBps).toBe(490n);
    u = onEquity(u.state, E(1045), NOW + 1, policy); // 5.0 %
    expect(u).toMatchObject({ justTripped: true, drawdownBps: 500n });
    expect(u.state).toMatchObject({ tripped: true, trippedAt: NOW + 1 });
    expect(u.state.reason).toContain('500 bps');
    const again = onEquity(u.state, E(2000), NOW + 2, policy);
    expect(again).toMatchObject({ justTripped: false });
    expect(again.state).toMatchObject({ tripped: true, peakEquity: E(2000) });
  });
  it('manual trip and operator reset', () => {
    const t = tripManually(INITIAL_KILL_SWITCH, NOW, 'operator');
    expect(t).toMatchObject({ tripped: true, reason: 'manual: operator' });
    expect(reset(E(900))).toEqual({ peakEquity: E(900), tripped: false });
  });
  it('drawdown is zero without a peak or above it', () => {
    expect(drawdownBps(0n, E(1))).toBe(0n);
    expect(drawdownBps(E(1), E(2))).toBe(0n);
  });
  it('property: trips exactly when drawdown reaches the limit', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 24n }),
        fc.bigInt({ min: 0n, max: 10n ** 24n }),
        (peak, eq) => {
          const u = onEquity({ peakEquity: peak, tripped: false }, eq, NOW, policy);
          const dd = drawdownBps(peak > eq ? peak : eq, eq);
          expect(u.justTripped).toBe(dd >= 500n);
        },
      ),
    );
  });
});

describe('flatten plan', () => {
  const ETH = {
    ...BTC,
    market: 'ETH-PERP',
    baseDecimals: 18,
    lotSize: 10n ** 14n,
    minQuantity: 10n ** 15n,
    markPrice: E(2400),
  };
  const markets = { 'BTC-PERP': BTC, 'ETH-PERP': ETH };

  it('cancels all orders and reduces every position through the gate', () => {
    const positions = { 'BTC-PERP': 26_500n, 'ETH-PERP': -(3n * 10n ** 15n), 'SOL-PERP': 0n };
    const plan = planFlatten(policy, positions, [{ market: 'BTC-PERP', orderId: 7n }], markets);
    expect(plan.cancels).toEqual([{ market: 'BTC-PERP', orderId: 7n }]);
    expect(plan.reduces.map((r) => [r.market, r.side, r.quantity])).toEqual([
      ['BTC-PERP', 'short', 26_000n],
      ['ETH-PERP', 'long', 3n * 10n ** 15n],
    ]);
    for (const r of plan.reduces) {
      const m = markets[r.market as keyof typeof markets];
      const d = evaluate({
        intent: r,
        policy,
        market: m,
        account: { ...account, positions },
        memory: { ...EMPTY_MEMORY, day: utcDay(NOW), killSwitch: true },
        sizing: undefined,
        now: NOW,
      });
      expect(d.verdict).toBe('allowed');
    }
  });

  it('skips dust, unknown marks, and coarse ticks; respects flattenPositions=false', () => {
    const plan = planFlatten(policy, { 'BTC-PERP': 5_000n, 'XYZ-PERP': 1n, 'ETH-PERP': 10n ** 16n }, [], {
      ...markets,
      'ETH-PERP': { ...ETH, tickSize: E(1000) },
    });
    expect(plan.reduces).toEqual([]);
    expect(plan.skipped.map((s) => s.why)).toEqual([
      'below the venue minimum order size',
      'tick is too coarse for the price band',
      'no mark price to price the exit',
    ]);
    const off = parsePolicy({ ...DEMO_POLICY, killSwitch: { maxDrawdownBps: 500, flattenPositions: false } });
    expect(planFlatten(off, { 'BTC-PERP': 26_000n }, [], markets).reduces).toEqual([]);
  });

  it('property: exit prices sit on the tick, on the crossing side, inside the band', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 10n ** 15n, max: 10n ** 25n }),
        fc.integer({ min: 10, max: 17 }),
        fc.boolean(),
        fc.integer({ min: 1, max: 999 }),
        (mark, tickExp, sell, band) => {
          const tick = 10n ** BigInt(tickExp);
          if (tick * 10_000n > mark * BigInt(band)) return; // tick coarser than the band: planner skips
          const p = exitPrice(mark, tick, sell, band);
          expect(onGrid(p, tick)).toBe(true);
          expect(deviationBps(p, mark) <= BigInt(band)).toBe(true);
          if (sell) expect(p <= mark).toBe(true);
          else expect(p >= mark - tick).toBe(true);
        },
      ),
    );
  });

  it('exit band stays one bps inside the gate limit, capped at 200', () => {
    expect(exitBandBps(policy)).toBe(200);
    expect(exitBandBps(parsePolicy({ ...DEMO_POLICY, maxPriceDeviationBps: 50 }))).toBe(49);
    expect(exitBandBps(parsePolicy({ ...DEMO_POLICY, maxPriceDeviationBps: 1 }))).toBe(1);
  });
});
