// Property / fuzz tests: random intents, markets, accounts and memories against the gate's invariants.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  BLOCK_CODES,
  EMPTY_MEMORY,
  evaluate,
  isReducing,
  notional,
  onGrid,
  utcDay,
  type GateInput,
} from '../src/gate/index.js';
import type { MarketSpec, OrderIntent } from '../src/gate/index.js';
import { BTC, NOW, account, policy, sizing } from './fixtures.js';

const DECIMALS = [6, 7, 8, 9, 18, 24];

const marketArb: fc.Arbitrary<MarketSpec> = fc
  .record({
    pick: fc.integer({ min: 0, max: 9 }),
    baseDecimals: fc.constantFrom(...DECIMALS),
    tickExp: fc.integer({ min: 12, max: 17 }),
    lotExp: fc.integer({ min: 0, max: 6 }),
    minLots: fc.integer({ min: 1, max: 20 }),
    markUsd: fc.integer({ min: 1, max: 200_000 }),
    markAge: fc.oneof(
      { arbitrary: fc.integer({ min: 0, max: 120 }), weight: 9 },
      { arbitrary: fc.integer({ min: 121, max: 400 }), weight: 1 },
    ),
  })
  .map((r) => {
    const tick = 10n ** BigInt(r.tickExp);
    const lot = 10n ** BigInt(r.lotExp);
    const market = (['BTC-PERP', 'ETH-PERP', 'SOL-PERP', 'DOGE-PERP'] as const)[r.pick % 4] ?? 'BTC-PERP';
    const pinned = policy.pinnedBaseDecimals[market];
    return {
      market,
      baseDecimals: r.pick < 8 && pinned !== undefined ? pinned : r.baseDecimals,
      tickSize: tick,
      lotSize: lot,
      minQuantity: lot * BigInt(r.minLots),
      markPrice: BigInt(r.markUsd) * 10n ** 18n,
      markUpdatedAt: NOW - r.markAge,
    };
  });

const inputArb: fc.Arbitrary<GateInput> = fc
  .record({
    market: marketArb,
    side: fc.constantFrom('long' as const, 'short' as const),
    orderType: fc.constantFrom('limit' as const, 'post_only' as const, 'ioc' as const),
    priceBps: fc.oneof(
      { arbitrary: fc.integer({ min: -300, max: 300 }), weight: 4 },
      { arbitrary: fc.integer({ min: -800, max: 800 }), weight: 1 },
    ),
    priceJitter: fc.oneof(
      { arbitrary: fc.constant(0n), weight: 9 },
      { arbitrary: fc.bigInt({ min: 1n, max: 10n ** 13n }), weight: 1 },
    ),
    qtyUsdMilli: fc.oneof(
      { arbitrary: fc.integer({ min: 0, max: 30_000 }), weight: 4 },
      { arbitrary: fc.integer({ min: 0, max: 400_000 }), weight: 1 },
    ),
    qtyNoise: fc.bigInt({ min: 0n, max: 10n ** 6n }),
    reduceOnly: fc.oneof(
      { arbitrary: fc.constant(false), weight: 4 },
      { arbitrary: fc.constant(true), weight: 1 },
    ),
    assumedMode: fc.integer({ min: 0, max: 9 }),
    assumedWrong: fc.constantFrom(...DECIMALS),
    position: fc.oneof(
      { arbitrary: fc.constant(0n), weight: 4 },
      { arbitrary: fc.bigInt({ min: -(10n ** 26n), max: 10n ** 26n }), weight: 1 },
    ),
    equityUsd: fc.integer({ min: 0, max: 2_000 }),
    grossUsd: fc.integer({ min: 0, max: 300 }),
    openOrders: fc.integer({ min: 0, max: 7 }),
    dailyUsd: fc.oneof(
      { arbitrary: fc.integer({ min: 0, max: 120 }), weight: 4 },
      { arbitrary: fc.integer({ min: 0, max: 200 }), weight: 1 },
    ),
    recent: fc.integer({ min: 0, max: 13 }),
    failures: fc.oneof(
      { arbitrary: fc.integer({ min: 0, max: 2 }), weight: 4 },
      { arbitrary: fc.integer({ min: 0, max: 5 }), weight: 1 },
    ),
    kill: fc.oneof({ arbitrary: fc.constant(false), weight: 9 }, { arbitrary: fc.constant(true), weight: 1 }),
    priceable: fc.oneof(
      { arbitrary: fc.constant(true), weight: 9 },
      { arbitrary: fc.constant(false), weight: 1 },
    ),
    maxQty: fc.oneof(
      { arbitrary: fc.constant(10n ** 40n), weight: 4 },
      { arbitrary: fc.bigInt({ min: 0n, max: 10n ** 30n }), weight: 1 },
    ),
  })
  .map((r) => {
    const raw = r.market.markPrice + (r.market.markPrice * BigInt(r.priceBps)) / 10_000n;
    const price = raw - (raw % r.market.tickSize) + (r.priceJitter % 3n === 0n ? r.priceJitter : 0n);
    const intent: OrderIntent = {
      market: r.market.market,
      side: r.side,
      orderType: r.orderType,
      price,
      quantity: qtyFor(r.market, r.qtyUsdMilli, price, r.qtyNoise),
      reduceOnly: r.reduceOnly,
      agent: 'fuzz',
      ...(r.assumedMode === 0
        ? { assumedBaseDecimals: r.assumedWrong }
        : r.assumedMode < 5
          ? { assumedBaseDecimals: r.market.baseDecimals }
          : {}),
    };
    return {
      intent,
      policy,
      market: r.market,
      account: {
        ...account,
        equity: BigInt(r.equityUsd) * 10n ** 18n,
        grossNotional: BigInt(r.grossUsd) * 10n ** 18n,
        positions: { [r.market.market]: r.position },
        openOrders: r.openOrders,
      },
      memory: {
        ...EMPTY_MEMORY,
        day: utcDay(NOW),
        dailyNotional: BigInt(r.dailyUsd) * 10n ** 18n,
        recentOrders: Array.from({ length: r.recent }, () => NOW - 5),
        consecutiveFailures: r.failures,
        killSwitch: r.kill,
      },
      sizing: { ...sizing, priceable: r.priceable, maxQuantity: r.maxQty },
      now: NOW,
    };
  });

// A quantity worth roughly qtyUsdMilli/1000 USD at `price`, mostly on the lot grid.
function qtyFor(m: MarketSpec, usdMilli: number, price: bigint, noise: bigint): bigint {
  if (price <= 0n) return BigInt(usdMilli);
  const q = (BigInt(usdMilli) * 10n ** 15n * 10n ** BigInt(m.baseDecimals)) / price;
  const gridded = (q / m.lotSize) * m.lotSize;
  return noise % 10n === 0n ? gridded + (noise % m.lotSize) : gridded;
}

const RUNS = { numRuns: 3000 };

describe('gate invariants (fuzz)', () => {
  it('anything not blocked respects every hard limit', () => {
    let passed = 0;
    const hist: Record<string, number> = {};
    fc.assert(
      fc.property(inputArb, (inp) => {
        const d = evaluate(inp);
        if (d.verdict === 'blocked') {
          for (const c of d.codes) hist[c] = (hist[c] ?? 0) + 1;
          return;
        }
        passed += 1;
        const { intent, market, account: acct, memory } = inp;
        if (!market) throw new Error('unreachable');
        const reducing = isReducing(acct.positions[intent.market] ?? 0n, intent);
        expect(policy.markets).toContain(intent.market);
        expect(onGrid(intent.price, market.tickSize)).toBe(true);
        expect(onGrid(intent.quantity, market.lotSize)).toBe(true);
        expect(intent.quantity >= market.minQuantity).toBe(true);
        expect(memory.consecutiveFailures < policy.maxConsecutiveFailures).toBe(true);
        expect(
          intent.assumedBaseDecimals === undefined || intent.assumedBaseDecimals === market.baseDecimals,
        ).toBe(true);
        expect(policy.pinnedBaseDecimals[intent.market] ?? market.baseDecimals).toBe(market.baseDecimals);
        if (intent.reduceOnly || memory.killSwitch) expect(reducing).toBe(true);
        if (!reducing) {
          const n = notional(intent.price, intent.quantity, market.baseDecimals);
          expect(n).toBe(d.notional);
          expect(n <= policy.maxOrderNotionalUsd).toBe(true);
          expect(memory.dailyNotional + n <= policy.maxDailyNotionalUsd).toBe(true);
          expect(
            (acct.grossNotional + n) * 10_000n <= acct.equity * BigInt(policy.maxLeverage * 10_000),
          ).toBe(true);
          expect(NOW - market.markUpdatedAt <= policy.maxMarkAgeSec).toBe(true);
          expect(intent.quantity <= (inp.sizing?.maxQuantity ?? 0n)).toBe(true);
        } else {
          expect(d.notional).toBe(0n);
        }
      }),
      RUNS,
    );
    // The generator must exercise both sides: plenty of passes, and every block rule it can reach
    // (MARK_UNKNOWN and PRICE_ZERO are covered by the unit tests).
    expect(passed).toBeGreaterThan(50);
    for (const c of BLOCK_CODES)
      if (c !== 'MARK_UNKNOWN' && c !== 'PRICE_ZERO') expect(hist[c], c).toBeGreaterThan(0);
  });

  it('is deterministic and the message always matches the verdict', () => {
    fc.assert(
      fc.property(inputArb, (inp) => {
        const a = evaluate(inp);
        expect(evaluate(inp)).toEqual(a);
        if (a.verdict === 'allowed') expect(a.message).toBe('Allowed: within your limits');
        if (a.verdict === 'blocked') expect(a.message).toBe(`Blocked by your rule: ${a.codes.join(', ')}`);
        if (a.verdict === 'needs_ok') expect(a.message).toBe(`Needs your OK: ${a.codes.join(', ')}`);
        expect(a.codes.length === 0).toBe(a.verdict === 'allowed');
      }),
      RUNS,
    );
  });

  it('a quantity scaled with the wrong decimals is always blocked', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DECIMALS.filter((d) => d !== 8)),
        fc.integer({ min: 1, max: 1000 }),
        (wrong, milli) => {
          // 0.001 * milli BTC, but scaled as if BTC had `wrong` decimals.
          const qty = (BigInt(milli) * 10n ** BigInt(wrong)) / 1000n;
          const d = evaluate({
            intent: {
              market: 'BTC-PERP',
              side: 'long',
              orderType: 'post_only',
              price: 77_800n * 10n ** 18n,
              quantity: qty,
              reduceOnly: false,
              agent: 'fuzz',
              assumedBaseDecimals: wrong,
            },
            policy,
            market: BTC,
            account,
            memory: { ...EMPTY_MEMORY, day: utcDay(NOW) },
            sizing,
            now: NOW,
          });
          expect(d.verdict).toBe('blocked');
          expect(d.codes).toContain('DECIMALS_MISMATCH');
        },
      ),
      RUNS,
    );
  });

  it('shrinking an opening order never adds a cap violation', () => {
    const capCodes = [
      'ORDER_NOTIONAL_CAP',
      'DAILY_NOTIONAL_CAP',
      'POSITION_CAP',
      'LEVERAGE_CAP',
      'VENUE_MAX_SIZE',
      'ABOVE_OK_THRESHOLD',
    ];
    fc.assert(
      fc.property(inputArb, fc.integer({ min: 1, max: 99 }), (inp, pct) => {
        const pos = inp.account.positions[inp.intent.market] ?? 0n;
        if (!inp.market || isReducing(pos, inp.intent)) return;
        const lot = inp.market.lotSize;
        const smaller = ((inp.intent.quantity * BigInt(pct)) / 100n / lot) * lot;
        if (smaller < inp.market.minQuantity) return;
        const flat = { ...inp.account, positions: {} };
        const big = evaluate({ ...inp, account: flat });
        const small = evaluate({ ...inp, account: flat, intent: { ...inp.intent, quantity: smaller } });
        for (const c of capCodes)
          if (small.codes.includes(c) || small.details[c]) expect(big.details[c]).toBeDefined();
      }),
      RUNS,
    );
  });
});
