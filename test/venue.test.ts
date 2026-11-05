import { describe, expect, it } from 'vitest';

import {
  BENIGN_ERRORS,
  ORDER_TYPE_CODE,
  REFUSED_CHAIN_IDS,
  SimVenue,
  TOKYO_TESTNET,
  assertTestnetChainId,
  chainOf,
  displayName,
  errorName,
  errorText,
  farFutureNs,
  resolveNetwork,
  toVenueMarket,
  txUrl,
  type MarketRow,
  type VenueMarket,
} from '../src/venue/index.js';
import { BTC, NOW, intent } from './fixtures.js';

const USD = 10n ** 18n;
const row: MarketRow = {
  poolAddress: '0xABCDEF0000000000000000000000000000000001',
  marginBank: '0xABCDEF0000000000000000000000000000000002',
  baseDecimals: '8',
  tickSize: '100000000000000000',
  lotSize: '1000',
  minQuantity: '13000',
  markPrice: '77000000000000000000000',
  markPriceUpdatedAt: String(NOW - 30),
  initialMarginBps: '500',
};

describe('map', () => {
  it('names and order codes', () => {
    expect(displayName('BTC/USDso:USDso')).toBe('BTC-PERP');
    expect(ORDER_TYPE_CODE).toEqual({ limit: 0, ioc: 2, post_only: 3 });
    expect(farFutureNs(0)).toBe(BigInt(50 * 365 * 24 * 3600) * 1_000_000_000n);
  });
  it('uses the live mark stamped now when priceable', () => {
    const m = toVenueMarket('BTC-PERP', row, { priceable: true, markPrice: 77_890n * USD }, NOW);
    expect(m.markPrice).toBe(77_890n * USD);
    expect(m.markUpdatedAt).toBe(NOW);
    expect(m.pool).toBe(row.poolAddress.toLowerCase());
    expect(m.initialMarginBps).toBe(500);
    expect(m.baseDecimals).toBe(8);
  });
  it('falls back to the row mark and its timestamp', () => {
    for (const live of [undefined, { priceable: false }, { priceable: true, markPrice: 0n }]) {
      const m = toVenueMarket('BTC-PERP', row, live, NOW);
      expect(m.markPrice).toBe(77_000n * USD);
      expect(m.markUpdatedAt).toBe(NOW - 30);
    }
  });
  it('treats missing row marks as unknown', () => {
    const m = toVenueMarket(
      'X',
      { ...row, markPrice: null, markPriceUpdatedAt: null, initialMarginBps: null },
      undefined,
      NOW,
    );
    expect(m.markPrice).toBe(0n);
    expect(m.markUpdatedAt).toBe(0);
    expect(m.initialMarginBps).toBe(0);
  });
});

describe('errors', () => {
  it('reads errorName through causes', () => {
    expect(errorName({ cause: { cause: { errorName: 'PostOnlyWouldCross' } } })).toBe('PostOnlyWouldCross');
  });
  it('maps known selectors and keeps unknown ones', () => {
    expect(errorName({ data: '0x3a23d825' })).toBe('InsufficientCollateral');
    expect(errorName({ data: '0x12345678deadbeef' })).toBe('0x12345678');
  });
  it('reads names out of messages', () => {
    expect(errorName(new Error('The contract function reverted with the following reason:\nFooBar'))).toBe(
      'FooBar',
    );
    expect(errorName({ shortMessage: 'error MaxThing(uint256)' })).toBe('MaxThing');
    expect(errorName({ message: 'x ImmediateOrCancelNoFill y' })).toBe('ImmediateOrCancelNoFill');
    expect(errorName({ message: 'nothing' })).toBeUndefined();
    expect(errorName('str')).toBeUndefined();
    const loop: { cause?: unknown } = {};
    loop.cause = loop;
    expect(errorName(loop)).toBeUndefined();
  });
  it('texts', () => {
    expect(errorText(new Error('m'))).toBe('m');
    expect(errorText(Object.assign(new Error('long'), { shortMessage: 'short' }))).toBe('short');
    expect(errorText(42)).toBe('42');
    expect(BENIGN_ERRORS.has('PostOnlyWouldCross')).toBe(true);
  });
});

describe('network', () => {
  it('is Tokyo testnet only', () => {
    expect(resolveNetwork({}).chainId).toBe(50383);
    expect(resolveNetwork({ NETWORK: 'hideki', RPC_URL: 'http://x' }).rpcUrl).toBe('http://x');
    expect(() => resolveNetwork({ NETWORK: 'mainnet' })).toThrow(/Tokyo testnet only/);
    expect(REFUSED_CHAIN_IDS.has(5031)).toBe(true);
    expect(() => {
      assertTestnetChainId(5031, TOKYO_TESTNET);
    }).toThrow(/mainnet/);
    expect(() => {
      assertTestnetChainId(1, TOKYO_TESTNET);
    }).toThrow(/expected Tokyo/);
    expect(() => {
      assertTestnetChainId(50383, TOKYO_TESTNET);
    }).not.toThrow();
    expect(chainOf(TOKYO_TESTNET).id).toBe(50383);
    expect(txUrl(TOKYO_TESTNET, '0xab')).toBe('https://explorer.testnet.somnia.network/tokyo/tx/0xab');
  });
});

const SIM_BTC: VenueMarket = {
  ...BTC,
  markUpdatedAt: NOW,
  pool: '0x0000000000000000000000000000000000000b7c',
  marginBank: '0x0000000000000000000000000000000000000ba7',
  initialMarginBps: 500,
};
const mk = (collateral = 100n * USD) => new SimVenue([SIM_BTC], { collateral, now: () => NOW, seed: 7 });
const MARK = BTC.markPrice;
const Q = 13000n; // ~10.1 USD

describe('SimVenue', () => {
  it('rests a passive post-only and fills it when the mark crosses', async () => {
    const v = mk();
    const r = await v.place(SIM_BTC, { ...intent, price: MARK - 100n * USD });
    expect(r.ok).toBe(true);
    expect(r.orderId).toBe(1n);
    expect((await v.snapshot(['BTC-PERP'])).orders).toEqual([{ market: 'BTC-PERP', orderId: 1n }]);
    v.setMark('BTC-PERP', MARK - 200n * USD);
    const s = await v.snapshot(['BTC-PERP', 'NOPE']);
    expect(s.orders).toHaveLength(0);
    expect(s.account.positions['BTC-PERP']).toBe(Q);
    expect(Object.keys(s.markets)).toEqual(['BTC-PERP']);
    expect(v.fills).toHaveLength(1);
  });
  it('rejects a crossing post-only and a non-crossing IOC as benign', async () => {
    const v = mk();
    const a = await v.place(SIM_BTC, { ...intent, price: MARK + 10n * USD });
    expect(a).toMatchObject({ ok: false, errorName: 'PostOnlyWouldCross', benign: true });
    const b = await v.place(SIM_BTC, { ...intent, orderType: 'ioc', price: MARK - 10n * USD });
    expect(b).toMatchObject({ ok: false, errorName: 'ImmediateOrCancelNoFill', benign: true });
  });
  it('fills a crossing IOC at the mark and books PnL on close', async () => {
    const v = mk();
    const r = await v.place(SIM_BTC, { ...intent, orderType: 'ioc', price: MARK + 50n * USD });
    expect(r).toMatchObject({ ok: true, filled: Q });
    expect(r.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    v.setMark('BTC-PERP', MARK + 1000n * USD);
    expect(v.equity()).toBeGreaterThan(100n * USD);
    const c = await v.place(SIM_BTC, {
      ...intent,
      side: 'short',
      orderType: 'ioc',
      price: MARK,
      reduceOnly: true,
    });
    expect(c.ok).toBe(true);
    const s = await v.snapshot(['BTC-PERP']);
    expect(s.account.positions['BTC-PERP']).toBeUndefined();
    expect(s.account.equity).toBe(100n * USD + (Q * 1000n * USD) / 10n ** 8n);
  });
  it('handles flips, adds and partial closes', async () => {
    const v = mk(1000n * USD);
    await v.place(SIM_BTC, { ...intent, orderType: 'limit', price: MARK + USD, quantity: 2n * Q });
    await v.place(SIM_BTC, { ...intent, orderType: 'limit', price: MARK + USD, quantity: Q });
    await v.place(SIM_BTC, { ...intent, side: 'short', orderType: 'limit', price: MARK - USD, quantity: Q });
    expect((await v.snapshot([])).account.positions['BTC-PERP']).toBe(2n * Q);
    await v.place(SIM_BTC, {
      ...intent,
      side: 'short',
      orderType: 'limit',
      price: MARK - USD,
      quantity: 3n * Q,
    });
    expect((await v.snapshot([])).account.positions['BTC-PERP']).toBe(-Q);
    // resting ask fills when the mark rises through it
    const ask = await v.place(SIM_BTC, { ...intent, side: 'short', price: MARK + 5n * USD });
    expect(ask.orderId).toBeDefined();
    v.setMark('BTC-PERP', MARK + 10n * USD);
    expect((await v.snapshot([])).account.positions['BTC-PERP']).toBe(-2n * Q);
  });
  it('checks grid and minimum size', async () => {
    const v = mk();
    expect((await v.place(SIM_BTC, { ...intent, price: MARK - 1n })).errorName).toBe('InvalidPrice');
    expect((await v.place(SIM_BTC, { ...intent, price: 0n })).errorName).toBe('InvalidPrice');
    expect((await v.place(SIM_BTC, { ...intent, quantity: Q + 1n })).errorName).toBe('InvalidQuantity');
    expect((await v.place(SIM_BTC, { ...intent, quantity: 1000n })).errorName).toBe('InvalidQuantity');
  });
  it('enforces initial margin and reports sizing', async () => {
    const v = mk(USD); // 1 USD at 5% imf supports ~20 USD notional
    const s = await v.sizing(SIM_BTC, intent);
    expect(s.priceable).toBe(true);
    expect(s.placeable).toBe(true);
    expect(s.maxQuantity % SIM_BTC.lotSize).toBe(0n);
    const big = await v.place(SIM_BTC, { ...intent, orderType: 'ioc', price: MARK, quantity: 100n * Q });
    expect(big.errorName).toBe('InsufficientCollateral');
    const tiny = mk(USD / 10n);
    const t = await tiny.sizing(SIM_BTC, { ...intent, price: 0n });
    expect(t).toMatchObject({ placeable: false, limitedBy: 'collateral' });
    const broke = mk(0n);
    expect((await broke.sizing(SIM_BTC, intent)).maxQuantity).toBe(0n);
  });
  it('is not priceable with a stale mark', async () => {
    const v = new SimVenue([{ ...SIM_BTC, markUpdatedAt: NOW - 600 }], { collateral: USD, now: () => NOW });
    expect(await v.sizing(SIM_BTC, intent)).toEqual({ priceable: false, placeable: false, maxQuantity: 0n });
    expect(v.mode).toBe('sim');
    expect(v.account).toBe(v.sender);
  });
  it('cancels', async () => {
    const v = mk();
    const r = await v.place(SIM_BTC, { ...intent, price: MARK - 100n * USD });
    const id = r.orderId ?? 0n;
    expect((await v.cancel(SIM_BTC, { market: 'BTC-PERP', orderId: id })).ok).toBe(true);
    expect((await v.cancel(SIM_BTC, { market: 'BTC-PERP', orderId: id })).ok).toBe(false);
    await v.close();
  });
  it('walks marks deterministically on the tick grid', () => {
    const a = mk();
    const b = mk();
    for (let i = 0; i < 20; i++) {
      a.step();
      b.step();
    }
    const ma = a.market('BTC-PERP').markPrice;
    expect(ma).toBe(b.market('BTC-PERP').markPrice);
    expect(ma % SIM_BTC.tickSize).toBe(0n);
    expect(() => a.market('NOPE')).toThrow(/unknown market/);
    const low = new SimVenue([{ ...SIM_BTC, markPrice: SIM_BTC.tickSize }], {
      collateral: 0n,
      now: () => NOW,
    });
    for (let i = 0; i < 30; i++) low.step(5000);
    expect(low.market('BTC-PERP').markPrice).toBeGreaterThan(0n);
  });
});
