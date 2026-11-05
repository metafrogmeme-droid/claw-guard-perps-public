import { describe, expect, it } from 'vitest';

import {
  ALLOWED_MESSAGE,
  BLOCK_CODES,
  EMPTY_MEMORY,
  OK_CODES,
  evaluate,
  isReducing,
  parsePolicy,
  policyHash,
  recordAllowed,
  recordVenueResult,
  utcDay,
  verdictMessage,
  DEMO_POLICY,
  canonicalJson,
} from '../src/gate/index.js';
import { BTC, NOW, account, input, intent, policy } from './fixtures.js';

const codes = (over: Parameters<typeof input>[0]) => evaluate(input(over)).codes;

describe('gate: allowed path', () => {
  it('a small on-grid post-only bid near the mark is allowed', () => {
    const d = evaluate(input());
    expect(d).toMatchObject({ verdict: 'allowed', codes: [], message: ALLOWED_MESSAGE });
    expect(d.notional).toBe(10_114_000_000_000_000_000n); // 77,800 x 0.00013 = 10.114 USD
  });
});

describe('gate: each block rule fires on its own', () => {
  const cases: [string, Parameters<typeof input>[0], string][] = [
    [
      'kill switch',
      { memory: { ...EMPTY_MEMORY, day: '2026-10-26', killSwitch: true } },
      'KILL_SWITCH_ACTIVE',
    ],
    [
      'revert loop',
      { memory: { ...EMPTY_MEMORY, day: '2026-10-26', consecutiveFailures: 3 } },
      'FAILURE_LOOP',
    ],
    [
      'market not allowed',
      { intent: { ...intent, market: 'DOGE-PERP' }, market: { ...BTC, market: 'DOGE-PERP' } },
      'MARKET_NOT_ALLOWED',
    ],
    ['pinned decimals changed', { market: { ...BTC, baseDecimals: 18 } }, 'MARKET_DECIMALS_CHANGED'],
    ['agent used 18 dp for BTC', { intent: { ...intent, assumedBaseDecimals: 18 } }, 'DECIMALS_MISMATCH'],
    ['zero quantity', { intent: { ...intent, quantity: 0n } }, 'QTY_ZERO'],
    ['zero price', { intent: { ...intent, price: 0n } }, 'PRICE_ZERO'],
    ['price off tick', { intent: { ...intent, price: intent.price + 1n } }, 'PRICE_OFF_TICK'],
    ['qty off lot', { intent: { ...intent, quantity: 13_001n } }, 'QTY_OFF_LOT'],
    ['qty below min', { intent: { ...intent, quantity: 12_000n } }, 'QTY_BELOW_MIN'],
    ['fake reduce-only', { intent: { ...intent, reduceOnly: true } }, 'NOT_REDUCING'],
    ['no mark', { market: { ...BTC, markPrice: 0n } }, 'MARK_UNKNOWN'],
    ['stale mark', { market: { ...BTC, markUpdatedAt: NOW - 600 } }, 'MARK_STALE'],
    [
      'venue unpriceable',
      { sizing: { priceable: false, placeable: false, maxQuantity: 0n } },
      'VENUE_UNPRICEABLE',
    ],
    ['no sizing read', { sizing: undefined }, 'VENUE_UNPRICEABLE'],
    ['far from mark', { intent: { ...intent, price: 70_000n * 10n ** 18n } }, 'PRICE_FAR_FROM_MARK'],
    ['order cap', { intent: { ...intent, quantity: 39_000n } }, 'ORDER_NOTIONAL_CAP'],
    [
      'daily cap',
      { memory: { ...EMPTY_MEMORY, day: '2026-10-26', dailyNotional: 145n * 10n ** 18n } },
      'DAILY_NOTIONAL_CAP',
    ],
    ['position cap', { account: { ...account, positions: { 'BTC-PERP': 70_000n } } }, 'POSITION_CAP'],
    ['leverage cap', { account: { ...account, equity: 3n * 10n ** 18n } }, 'LEVERAGE_CAP'],
    ['no equity', { account: { ...account, equity: 0n } }, 'NO_EQUITY'],
    ['open orders', { account: { ...account, openOrders: 6 } }, 'OPEN_ORDERS_CAP'],
    [
      'rate limit',
      {
        memory: {
          ...EMPTY_MEMORY,
          day: '2026-10-26',
          recentOrders: Array.from({ length: 12 }, () => NOW - 1),
        },
      },
      'RATE_LIMIT',
    ],
    [
      'venue max size',
      { sizing: { priceable: true, placeable: true, maxQuantity: 1000n, limitedBy: 'collateral' } },
      'VENUE_MAX_SIZE',
    ],
    [
      'venue not placeable',
      { sizing: { priceable: true, placeable: false, maxQuantity: 0n } },
      'VENUE_MAX_SIZE',
    ],
  ];
  it.each(cases)('%s', (_name, over, code) => {
    const d = evaluate(input(over));
    expect(d.verdict).toBe('blocked');
    expect(d.codes).toContain(code);
    expect(d.message).toBe(`Blocked by your rule: ${d.codes.join(', ')}`);
    expect(d.details[code]).toBeTypeOf('string');
  });

  it('a market the venue does not list stops early', () => {
    expect(codes({ market: undefined })).toEqual(['MARK_UNKNOWN']);
    expect(codes({ market: undefined, intent: { ...intent, market: 'XYZ-PERP' } })).toEqual([
      'MARKET_NOT_ALLOWED',
    ]);
  });

  it('reports every rule that fired, in the fixed order', () => {
    const c = codes({
      intent: { ...intent, market: 'DOGE-PERP', quantity: 12_001n, price: intent.price + 1n },
    });
    expect(c).toEqual(['MARKET_NOT_ALLOWED', 'PRICE_OFF_TICK', 'QTY_OFF_LOT', 'QTY_BELOW_MIN']);
  });
  it("yesterday's daily total does not count today", () => {
    expect(
      codes({ memory: { ...EMPTY_MEMORY, day: '2026-10-25', dailyNotional: 149n * 10n ** 18n } }),
    ).toEqual([]);
  });
  it('old orders fall out of the rate window', () => {
    expect(
      codes({
        memory: {
          ...EMPTY_MEMORY,
          day: '2026-10-26',
          recentOrders: Array.from({ length: 12 }, () => NOW - 61),
        },
      }),
    ).toEqual([]);
  });
});

describe('gate: needs-OK holds', () => {
  it('above the OK line', () => {
    const d = evaluate(input({ intent: { ...intent, quantity: 27_000n } })); // ~21 USD
    expect(d).toMatchObject({
      verdict: 'needs_ok',
      codes: ['ABOVE_OK_THRESHOLD'],
      message: 'Needs your OK: ABOVE_OK_THRESHOLD',
    });
  });
  it('taker order', () => {
    expect(evaluate(input({ intent: { ...intent, orderType: 'ioc' } })).codes).toEqual(['TAKER_ORDER']);
  });
  it('new market when the policy asks for it', () => {
    const p = parsePolicy({ ...DEMO_POLICY, needsOkOnNewMarket: true });
    expect(evaluate(input({ policy: p })).codes).toEqual(['NEW_MARKET']);
    expect(
      evaluate(
        input({ policy: p, memory: { ...EMPTY_MEMORY, day: '2026-10-26', seenMarkets: ['BTC-PERP'] } }),
      ).verdict,
    ).toBe('allowed');
  });
  it('a block always wins over a hold', () => {
    const d = evaluate(input({ intent: { ...intent, orderType: 'ioc', quantity: 13_001n } }));
    expect(d.verdict).toBe('blocked');
    expect(d.codes).toEqual(['QTY_OFF_LOT']);
    expect(d.details['TAKER_ORDER']).toBeDefined();
  });
});

describe('gate: reducing orders', () => {
  const long = { ...account, positions: { 'BTC-PERP': 26_000n }, grossNotional: 20n * 10n ** 18n };
  const sell = { ...intent, side: 'short' as const, reduceOnly: true, orderType: 'ioc' as const };
  it('pass the kill switch, stale marks, caps and the taker hold', () => {
    const d = evaluate(
      input({
        intent: sell,
        account: { ...long, equity: 1n },
        market: { ...BTC, markUpdatedAt: NOW - 3600 },
        sizing: undefined,
        memory: { ...EMPTY_MEMORY, day: '2026-10-26', killSwitch: true, dailyNotional: 10n ** 30n },
      }),
    );
    expect(d).toMatchObject({ verdict: 'allowed', notional: 0n });
  });
  it('isReducing: only toward zero, never through it', () => {
    expect(isReducing(26_000n, { side: 'short', quantity: 13_000n })).toBe(true);
    expect(isReducing(26_000n, { side: 'short', quantity: 26_000n })).toBe(true);
    expect(isReducing(26_000n, { side: 'short', quantity: 39_000n })).toBe(false);
    expect(isReducing(26_000n, { side: 'long', quantity: 13_000n })).toBe(false);
    expect(isReducing(-26_000n, { side: 'long', quantity: 13_000n })).toBe(true);
    expect(isReducing(0n, { side: 'long', quantity: 13_000n })).toBe(false);
    expect(isReducing(26_000n, { side: 'short', quantity: 0n })).toBe(false);
  });
});

describe('gate memory', () => {
  it('records allowed notional, rate and seen markets; resets the day', () => {
    const d = evaluate(input());
    const m1 = recordAllowed({ ...EMPTY_MEMORY, day: '2026-10-25', dailyNotional: 99n }, d, intent, NOW);
    expect(m1.day).toBe(utcDay(NOW));
    expect(m1.dailyNotional).toBe(d.notional);
    expect(m1.recentOrders).toEqual([NOW]);
    expect(m1.seenMarkets).toEqual(['BTC-PERP']);
    const m2 = recordAllowed(m1, d, intent, NOW + 70);
    expect(m2.dailyNotional).toBe(2n * d.notional);
    expect(m2.recentOrders).toEqual([NOW + 70]);
    expect(m2.seenMarkets).toEqual(['BTC-PERP']);
  });
  it('counts venue failures in a row and resets on success', () => {
    const f = recordVenueResult(recordVenueResult(EMPTY_MEMORY, false), false);
    expect(f.consecutiveFailures).toBe(2);
    expect(recordVenueResult(f, true).consecutiveFailures).toBe(0);
  });
});

describe('policy and wording', () => {
  it('rejects unknown keys, bad markets and bad amounts', () => {
    expect(() => parsePolicy({ ...DEMO_POLICY, extra: 1 })).toThrow();
    expect(() => parsePolicy({ ...DEMO_POLICY, markets: ['btc'] })).toThrow();
    expect(() => parsePolicy({ ...DEMO_POLICY, maxOrderNotionalUsd: '1e3' })).toThrow();
  });
  it('policy hash is stable and changes with any limit', () => {
    expect(policyHash(policy)).toBe(policyHash(parsePolicy(structuredClone(DEMO_POLICY))));
    expect(policyHash(parsePolicy({ ...DEMO_POLICY, maxLeverage: 2 }))).not.toBe(policyHash(policy));
    expect(policyHash(policy)).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it('canonicalJson sorts keys, drops undefined, prints bigints as strings', () => {
    expect(canonicalJson({ b: 1n, a: [undefined, null], c: undefined })).toBe('{"a":[null,null],"b":"1"}');
  });
  it('only three verdict wordings exist', () => {
    expect(verdictMessage('allowed', [])).toBe('Allowed: within your limits');
    expect(verdictMessage('blocked', ['A', 'B'])).toBe('Blocked by your rule: A, B');
    expect(verdictMessage('needs_ok', ['C'])).toBe('Needs your OK: C');
    expect(new Set([...BLOCK_CODES, ...OK_CODES]).size).toBe(BLOCK_CODES.length + OK_CODES.length);
  });
});
