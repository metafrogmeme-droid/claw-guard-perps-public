import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  deviationBps,
  floorToGrid,
  formatDecimal,
  notional,
  onGrid,
  parseDecimal,
  usd,
} from '../src/gate/units.js';

describe('parseDecimal / formatDecimal', () => {
  it('parses exactly, never rounds', () => {
    expect(parseDecimal('0.001', 8)).toBe(100000n);
    expect(parseDecimal('1', 0)).toBe(1n);
    expect(parseDecimal('0.10', 1)).toBe(1n);
    expect(parseDecimal('0.123', 2)).toBeUndefined();
    expect(parseDecimal('-1', 2)).toBeUndefined();
    expect(parseDecimal('1e5', 2)).toBeUndefined();
    expect(parseDecimal('1', -1)).toBeUndefined();
    expect(parseDecimal('1', 1.5)).toBeUndefined();
    expect(parseDecimal('', 2)).toBeUndefined();
  });
  it('the docs example: 0.1 SOL at 9 dp vs the 18 dp mistake differ by 1e9', () => {
    const right = parseDecimal('0.1', 9);
    const wrong = parseDecimal('0.1', 18);
    expect(right).toBe(100_000_000n);
    expect(wrong).toBe(100_000_000_000_000_000n);
    expect(formatDecimal(wrong ?? 0n, 9)).toBe('100000000');
  });
  it('formats negatives and whole numbers', () => {
    expect(formatDecimal(-150n, 2)).toBe('-1.5');
    expect(formatDecimal(300n, 2)).toBe('3');
  });
  it('round-trips for any value and decimals (property)', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 40n }), fc.integer({ min: 0, max: 30 }), (raw, d) => {
        expect(parseDecimal(formatDecimal(raw, d), d)).toBe(raw);
      }),
    );
  });
});

describe('grid', () => {
  it('onGrid and floorToGrid agree (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 30n }),
        fc.bigInt({ min: 1n, max: 10n ** 20n }),
        (v, step) => {
          const f = floorToGrid(v, step);
          expect(onGrid(f, step)).toBe(true);
          expect(f <= v && v - f < step).toBe(true);
          expect(onGrid(v, step)).toBe(f === v);
        },
      ),
    );
  });
  it('rejects non-positive steps', () => {
    expect(onGrid(10n, 0n)).toBe(false);
    expect(() => floorToGrid(10n, 0n)).toThrow(RangeError);
  });
});

describe('notional and deviation', () => {
  it('BTC: 0.001 BTC at 100,000 USD is 100 USD', () => {
    expect(notional(usd('100000'), 100000n, 8)).toBe(usd('100'));
  });
  it('NEAR (24 dp): 1 NEAR at 3 USD is 3 USD', () => {
    expect(notional(usd('3'), 10n ** 24n, 24)).toBe(usd('3'));
  });
  it('deviation is symmetric in magnitude and rounds up', () => {
    expect(deviationBps(101n, 100n)).toBe(100n);
    expect(deviationBps(99n, 100n)).toBe(100n);
    expect(deviationBps(1001n, 1000n)).toBe(10n);
    expect(deviationBps(10001n, 10000n)).toBe(1n);
    expect(() => deviationBps(1n, 0n)).toThrow(RangeError);
  });
  it('usd() rejects junk', () => {
    expect(usd(2.5)).toBe(25n * 10n ** 17n);
    expect(() => usd('abc')).toThrow(RangeError);
  });
});
