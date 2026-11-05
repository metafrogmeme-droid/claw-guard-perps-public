import { describe, expect, it } from 'vitest';

import { Engine } from '../src/engine/engine.js';
import { evaluate } from '../src/gate/gate.js';
import { SESSION_POLICY, parsePolicy, policyHash } from '../src/gate/policy.js';
import { checkShape, isWellFormed, rawIntentData } from '../src/gate/shape.js';
import type { OrderIntent } from '../src/gate/types.js';
import { usd } from '../src/gate/units.js';
import { isBidSide, orderTypeCode } from '../src/venue/map.js';
import { SimVenue, simMarkets } from '../src/venue/index.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { Journal, readJournal } from '../src/receipts/journal.js';
import { verifyChain } from '../src/receipts/receipt.js';
import { NOW, input, intent } from './fixtures.js';

// anvil test key 0 (public, allowlisted in .gitleaks.toml)
const KEY0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const bad = (over: Record<string, unknown>): OrderIntent => ({ ...intent, ...over });
const withoutKey = (k: keyof OrderIntent): OrderIntent => {
  const o: Record<string, unknown> = { ...intent };
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete o[k];
  return o as unknown as OrderIntent;
};

describe('intent shape check', () => {
  it('accepts a well-formed intent, with and without the optional fields', () => {
    expect(checkShape(intent)).toEqual({ fatal: [], values: [] });
    expect(checkShape({ ...intent, reason: 'x', assumedBaseDecimals: 8 })).toEqual({ fatal: [], values: [] });
    expect(isWellFormed(intent)).toBe(true);
  });

  it.each([
    ['side buy', { side: 'buy' }, /side must be/],
    ['side LONG', { side: 'LONG' }, /side must be/],
    ['side Short', { side: 'Short' }, /side must be/],
    ['side number', { side: 1 }, /side must be/],
    ['side null', { side: null }, /got null/],
    ['order type market', { orderType: 'market' }, /orderType must be/],
    ['order type IOC', { orderType: 'IOC' }, /orderType must be/],
    ['reduceOnly string', { reduceOnly: 'yes' }, /reduceOnly must be/],
    ['reduceOnly number', { reduceOnly: 1 }, /reduceOnly must be/],
    ['quantity number', { quantity: 13_000 }, /quantity must be a bigint/],
    ['quantity string', { quantity: '13000' }, /quantity must be a bigint/],
    ['price string', { price: '76000' }, /price must be a bigint/],
    ['price number', { price: 76_000 }, /price must be a bigint/],
    ['market number', { market: 7 }, /market must be a string/],
    ['agent object', { agent: {} }, /agent must be a string/],
    ['reason number', { reason: 5 }, /reason must be a string/],
    ['decimals string', { assumedBaseDecimals: '8' }, /assumedBaseDecimals must be a whole number/],
    ['decimals fraction', { assumedBaseDecimals: 8.5 }, /assumedBaseDecimals must be a whole number/],
    ['extra field', { leverage: 50 }, /unknown field "leverage"/],
  ])('%s is fatal', (_name, over, re) => {
    const s = checkShape(bad(over));
    expect(s.fatal.join('; ')).toMatch(re);
    expect(isWellFormed(bad(over))).toBe(false);
  });

  it.each(['market', 'side', 'orderType', 'price', 'quantity', 'reduceOnly', 'agent'] as const)(
    'missing %s is fatal',
    (k) => {
      expect(checkShape(withoutKey(k)).fatal.length).toBe(1);
    },
  );

  it('rejects anything that is not an object', () => {
    for (const x of [null, undefined, 5, 'long', [intent]]) expect(checkShape(x).fatal.length).toBe(1);
  });

  it('flags zero and negative values and negative decimals, without stopping later rules', () => {
    expect(checkShape(bad({ quantity: 0n })).values).toEqual(['quantity must be positive']);
    expect(checkShape(bad({ price: -1n })).values).toEqual(['price must be positive']);
    expect(checkShape(bad({ assumedBaseDecimals: -1 })).values).toEqual([
      'assumedBaseDecimals must not be negative',
    ]);
  });

  it('copies untyped data into a receipt-ready record', () => {
    expect(rawIntentData(null)).toEqual({ malformed: 'null' });
    expect(rawIntentData([1])).toEqual({ malformed: 'object' });
    const fn = (): number => 1;
    const r = rawIntentData({
      a: 1n,
      b: true,
      c: 'x'.repeat(300),
      d: 2,
      e: Infinity,
      f: fn,
      g: undefined,
      h: {},
    });
    expect(r).toEqual({
      a: 1n,
      b: true,
      c: 'x'.repeat(200),
      d: 2,
      e: 'Infinity',
      f: '<function>',
      h: '<object>',
    });
  });
});

describe('gate with malformed intents', () => {
  it('blocks a fatal shape problem first and alone, and never throws', () => {
    for (const over of [{ side: 'buy' }, { quantity: 13_000 }, { price: '1' }, { reduceOnly: 'yes' }]) {
      const d = evaluate(input({ intent: bad(over) }));
      expect(d.verdict).toBe('blocked');
      expect(d.codes).toEqual(['INTENT_MALFORMED']);
      expect(d.notional).toBe(0n);
    }
    expect(evaluate(input({ intent: null as unknown as OrderIntent })).codes).toEqual(['INTENT_MALFORMED']);
  });

  it('reports a value problem next to the specific rule', () => {
    const d = evaluate(input({ intent: bad({ quantity: 0n }) }));
    expect(d.codes).toContain('INTENT_MALFORMED');
    expect(d.codes).toContain('QTY_ZERO');
  });
});

describe('engine with malformed intents', () => {
  const policy = parsePolicy(SESSION_POLICY);
  it('writes a blocked receipt, never sizes or sends, and keeps the chain valid', async () => {
    const sim = new SimVenue(simMarkets(NOW), { collateral: usd('2000'), now: () => NOW, seed: 1 });
    let sized = 0;
    let placed = 0;
    const venue = new Proxy(sim, {
      get(t, k, r) {
        const v: unknown = Reflect.get(t, k, r);
        if (typeof v !== 'function') return v;
        const f = (v as (...a: unknown[]) => unknown).bind(t);
        if (k === 'sizing')
          return (...a: unknown[]) => {
            sized += 1;
            return f(...a);
          };
        if (k === 'place')
          return (...a: unknown[]) => {
            placed += 1;
            return f(...a);
          };
        return f;
      },
    });
    const path = join(await mkdtemp(join(tmpdir(), 'cgp-shape-')), 'j.jsonl');
    const journal = await Journal.open(path, privateKeyToAccount(KEY0), policyHash(policy));
    const engine = new Engine({ venue, policy, journal, now: () => NOW });
    const intents = [
      bad({ side: 'buy' }),
      bad({ market: 42 }),
      bad({ quantity: 13_000, extra: () => 1 }),
      null as unknown as OrderIntent,
    ];
    for (const i of intents) {
      const r = await engine.submit(i);
      expect(r.decision.codes).toEqual(['INTENT_MALFORMED']);
      expect(r.execution).toBeUndefined();
    }
    expect(sized).toBe(0);
    expect(placed).toBe(0);
    const disk = await readJournal(path);
    expect(disk.length).toBe(intents.length);
    expect((await verifyChain(disk)).ok).toBe(true);
    expect(disk[2]?.data).toMatchObject({ intent: { quantity: 13_000, extra: '<function>' } });
  });
});

describe('venue fails closed on side and order type', () => {
  it('maps only exact values', () => {
    expect(isBidSide('long')).toBe(true);
    expect(isBidSide('short')).toBe(false);
    for (const s of ['buy', 'LONG', 'Short', '', 1, null])
      expect(() => isBidSide(s)).toThrow(/refusing order/);
    expect(orderTypeCode('limit')).toBe(0);
    expect(orderTypeCode('ioc')).toBe(2);
    expect(orderTypeCode('post_only')).toBe(3);
    for (const t of ['market', 'IOC', 7]) expect(() => orderTypeCode(t)).toThrow(/refusing order/);
  });

  it('the sim refuses instead of sending a short', async () => {
    const sim = new SimVenue(simMarkets(NOW), { collateral: usd('2000'), now: () => NOW, seed: 1 });
    const s = await sim.snapshot(['BTC-PERP']);
    const m = s.markets['BTC-PERP'];
    if (m === undefined) throw new Error('no BTC');
    expect(() => sim.place(m, bad({ side: 'buy' }))).toThrow(/refusing order/);
    expect(() => sim.place(m, bad({ orderType: 'market' }))).toThrow(/refusing order/);
  });
});
