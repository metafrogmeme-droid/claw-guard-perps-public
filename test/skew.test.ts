import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { replay, type Candle } from '../src/backtest/replay.js';
import { parseSkewConfig } from '../src/engine/profit-rules.js';
import {
  DEFAULT_SKEW,
  recordMark,
  SkewState,
  skewMaker,
  type SkewMakerConfig,
} from '../src/engine/skew-maker.js';
import { parsePolicy, SESSION_POLICY } from '../src/gate/policy.js';
import { usd } from '../src/gate/units.js';
import { simMarkets } from '../src/venue/index.js';
import { NOW } from './fixtures.js';

// anvil test key 0 (public, allowlisted in .gitleaks.toml)
const signer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const markets = Object.fromEntries(simMarkets(NOW).map((m) => [m.market, m]));
const cfg: SkewMakerConfig = {
  ...DEFAULT_SKEW,
  markets: ['BTC-PERP'],
  quoteNotional: usd('10.5'),
  maxInventoryNotional: usd('29.5'),
  agent: 'skew-maker',
};
const btc = markets['BTC-PERP'];
if (btc === undefined) throw new Error('fixture');

describe('skew maker', () => {
  it('quotes post-only on both sides around the mark when flat', () => {
    const s = skewMaker(cfg, new SkewState(), markets, {}, [], NOW);
    expect(s.intents).toHaveLength(2);
    for (const i of s.intents) {
      expect(i.orderType).toBe('post_only');
      expect(i.reduceOnly).toBe(false);
    }
    const bid = s.intents.find((i) => i.side === 'long');
    const ask = s.intents.find((i) => i.side === 'short');
    expect((bid?.price ?? 0n) < btc.markPrice).toBe(true);
    expect((ask?.price ?? 0n) > btc.markPrice).toBe(true);
  });

  it('never places a taker order type', () => {
    const st = new SkewState();
    const pos = { 'BTC-PERP': 400_000n };
    for (const t of [0, 600, 1200, 1900, 4000]) {
      const s = skewMaker(cfg, st, markets, pos, [], NOW + t);
      for (const i of s.intents) expect(i.orderType).toBe('post_only');
    }
  });

  it('at the inventory cap quotes only the reducing side', () => {
    const s = skewMaker(cfg, new SkewState(), markets, { 'BTC-PERP': 4_000_000n }, [], NOW);
    expect(s.intents.length).toBeGreaterThan(0);
    for (const i of s.intents) expect(i.side).toBe('short');
  });

  it('exits on time with a reduce-only post-only order', () => {
    const st = new SkewState();
    const pos = { 'BTC-PERP': 200_000n };
    skewMaker(cfg, st, markets, pos, [], NOW);
    const s = skewMaker(cfg, st, markets, pos, [], NOW + cfg.maxHoldSec + 1);
    expect(s.exits.join(' ')).toContain('time');
    expect(s.intents).toHaveLength(1);
    expect(s.intents[0]?.reduceOnly).toBe(true);
    expect(s.intents[0]?.orderType).toBe('post_only');
  });

  it('exits on a stop when the mark moves against the position', () => {
    const st = new SkewState();
    const pos = { 'BTC-PERP': 200_000n };
    skewMaker(cfg, st, markets, pos, [], NOW);
    const down = { ...markets, 'BTC-PERP': { ...btc, markPrice: (btc.markPrice * 9_900n) / 10_000n } };
    const s = skewMaker(cfg, st, down, pos, [], NOW + 60);
    expect(s.exits.join(' ')).toContain('stop');
    expect(s.intents.every((i) => i.reduceOnly)).toBe(true);
  });

  it('does not ask for opening quotes the daily budget cannot fit', () => {
    const s = skewMaker(cfg, new SkewState(), markets, {}, [], NOW, usd('5'));
    expect(s.intents).toHaveLength(0);
  });
});

// Tweaks from the 4 Nov sessions (docs/STRATEGY_RULES.md, "Skew quoting defaults"). Quoting only; guard and caps unchanged.
describe('skew maker: 4 Nov tweaks', () => {
  const eth = markets['ETH-PERP'];
  if (eth === undefined) throw new Error('fixture');
  const two: SkewMakerConfig = { ...cfg, markets: ['BTC-PERP', 'ETH-PERP'] };
  const moved = (bpsMove: bigint) => ({
    ...markets,
    'BTC-PERP': { ...btc, markPrice: (btc.markPrice * (10_000n + bpsMove)) / 10_000n },
  });
  const tracked = (side: 'long' | 'short', price: bigint, orderId = 1n) => ({
    market: 'BTC-PERP',
    orderId,
    side,
    price,
  });

  it('new defaults: hold 1200 s, skew 35, requote 35, half-spread 25 calm / 35 jumpy, focus heavy on', () => {
    expect(DEFAULT_SKEW).toMatchObject({
      halfSpreadBps: 25,
      volHalfSpreadBps: 35,
      volJumpBps: 15,
      volWindow: 5,
      requoteBps: 35,
      skewBps: 35,
      maxHoldSec: 1200,
      exitRequoteBps: 10,
      focusHeavy: true,
      stopBps: 60,
      takeProfitBps: 50,
    });
    expect(parseSkewConfig({})).toMatchObject({ maxHoldSec: 1200, skewBps: 35, requoteBps: 35 });
    expect(parseSkewConfig({ volJumpBps: 0, focusHeavy: false, exitRequoteBps: 0 }).focusHeavy).toBe(false);
    expect(() => parseSkewConfig({ volWindow: 1 })).toThrow();
    expect(() => parseSkewConfig({ volHalfSpreadBps: 0 })).toThrow();
  });

  it('recordMark keeps the window and returns the largest step move in bps', () => {
    const st = new SkewState();
    expect(recordMark(st, 'X', 10_000n, 3)).toBe(0);
    expect(recordMark(st, 'X', 10_020n, 3)).toBe(20);
    expect(recordMark(st, 'X', 10_021n, 3)).toBe(20);
    expect(recordMark(st, 'X', 10_022n, 3)).toBe(0); // the 20 bps step left the 3-mark window
    expect(st.marks.get('X')).toHaveLength(3);
  });

  it('widens the half-spread to 35 bps after a jumpy mark, 25 bps when calm', () => {
    const st = new SkewState();
    const calm = skewMaker(cfg, st, markets, {}, [], NOW);
    expect(calm.intents.every((i) => (i.reason ?? '').includes('half-spread 25 bps'))).toBe(true);
    const jumpy = skewMaker(cfg, st, moved(20n), {}, [], NOW + 120);
    expect(jumpy.intents).toHaveLength(2);
    for (const i of jumpy.intents) expect(i.reason).toMatch(/half-spread 35 bps \(jumpy: (19|20) bps move\)/);
    const m = moved(20n)['BTC-PERP'].markPrice;
    const bid = jumpy.intents.find((i) => i.side === 'long');
    expect(Number(((m - (bid?.price ?? 0n)) * 10_000n) / m)).toBeGreaterThanOrEqual(34);
    // off: same move, no widening
    const off = skewMaker({ ...cfg, volJumpBps: 0 }, new SkewState(), moved(20n), {}, [], NOW);
    expect(off.intents.every((i) => (i.reason ?? '').includes('half-spread 25 bps'))).toBe(true);
  });

  it('keeps a resting quote up to requoteBps (35) away from its target', () => {
    const first = skewMaker(cfg, new SkewState(), markets, {}, [], NOW);
    const bid = first.intents.find((i) => i.side === 'long');
    if (bid === undefined) throw new Error('no bid');
    const near = (bid.price * 9_970n) / 10_000n; // 30 bps off
    const far = (bid.price * 9_960n) / 10_000n; // 40 bps off
    const keep = skewMaker(cfg, new SkewState(), markets, {}, [tracked('long', near)], NOW);
    expect(keep.cancels).toHaveLength(0);
    expect(keep.intents.filter((i) => i.side === 'long')).toHaveLength(0);
    const swap = skewMaker(cfg, new SkewState(), markets, {}, [tracked('long', far)], NOW);
    expect(swap.cancels).toHaveLength(1);
    // the mark fell 30 bps: the old bid is inside requoteBps of the new target but now sits above the mark
    // (or without the edge an opening needs), so it is replaced rather than left as a stale quote
    const stale = skewMaker(cfg, new SkewState(), moved(-30n), {}, [tracked('long', bid.price)], NOW);
    expect(stale.cancels).toHaveLength(1);
    expect(stale.intents.some((i) => i.side === 'long')).toBe(true);
  });

  it('an exit quote stays resting within exitRequoteBps instead of cancel+replace every tick', () => {
    const st = new SkewState();
    const pos = { 'BTC-PERP': 28_000n };
    skewMaker(cfg, st, markets, pos, [], NOW);
    const ex = skewMaker(cfg, st, markets, pos, [], NOW + cfg.maxHoldSec + 1);
    const px = ex.intents[0]?.price ?? 0n;
    expect(ex.intents[0]?.reason).toMatch(/^exit \(time/);
    // mark moves 3 bps: the resting exit is kept
    const kept = skewMaker(cfg, st, moved(3n), pos, [tracked('short', px)], NOW + cfg.maxHoldSec + 121);
    expect(kept.cancels).toHaveLength(0);
    expect(kept.intents).toHaveLength(0);
    // mark moves 30 bps: replaced
    const moved30 = skewMaker(cfg, st, moved(30n), pos, [tracked('short', px)], NOW + cfg.maxHoldSec + 241);
    expect(moved30.cancels).toHaveLength(1);
    expect(moved30.intents).toHaveLength(1);
    // exitRequoteBps 0: the old exact-price behaviour
    const st0 = new SkewState();
    const c0 = { ...cfg, exitRequoteBps: 0 };
    skewMaker(c0, st0, markets, pos, [], NOW);
    skewMaker(c0, st0, markets, pos, [], NOW + cfg.maxHoldSec + 1);
    expect(
      skewMaker(c0, st0, moved(3n), pos, [tracked('short', px)], NOW + cfg.maxHoldSec + 121).cancels,
    ).toHaveLength(1);
  });

  it('a strong skew keeps the reducing quote one tick inside the mark instead of dropping it', () => {
    const s = skewMaker(cfg, new SkewState(), markets, { 'BTC-PERP': -42_000n }, [], NOW);
    const bid = s.intents.find((i) => i.side === 'long');
    expect(bid?.reduceOnly).toBe(true);
    expect(bid?.price).toBe(btc.markPrice - btc.tickSize);
    expect(s.intents.some((i) => i.side === 'short')).toBe(false); // at the cap: no opening ask
  });

  it('with inventory on two markets: reduce only, the heavy market gets the full skew', () => {
    const pos = { 'BTC-PERP': -28_000n, 'ETH-PERP': -(46n * 10n ** 14n) };
    const s = skewMaker(two, new SkewState(), markets, pos, [], NOW);
    expect(s.intents.length).toBeGreaterThan(0);
    expect(s.intents.every((i) => i.side === 'long')).toBe(true); // both short: only bids (reducing)
    const b = s.intents.find((i) => i.market === 'BTC-PERP');
    expect(b?.reason).toContain('skew 35 bps');
    expect(b?.reason).toContain('(heavy market first)');
    const e = s.intents.find((i) => i.market === 'ETH-PERP');
    expect(e?.reason).not.toContain('heavy');
    // off: openings come back on the lighter market
    const off = skewMaker({ ...two, focusHeavy: false }, new SkewState(), markets, pos, [], NOW);
    expect(off.intents.some((i) => i.market === 'ETH-PERP' && i.side === 'short')).toBe(true);
    // one market holding: the flat one still opens
    const one = skewMaker(two, new SkewState(), markets, { 'BTC-PERP': -14_000n }, [], NOW);
    expect(one.intents.filter((i) => i.market === 'ETH-PERP')).toHaveLength(2);
    expect(eth.markPrice > 0n).toBe(true);
  });
});

describe('replay harness', () => {
  const mk = (start: number, prices: number[]): Candle[] =>
    prices.map((p, i) => {
      const v = (BigInt(Math.round(p * 10)) * 10n ** 17n).toString();
      return { bucketStart: String(start + i * 60), openPrice: v, high: v, low: v, closePrice: v };
    });
  const wave = Array.from({ length: 600 }, (_, i) => 77_900 + 800 * Math.sin(i / 15));

  it('runs the real guard and counts its verdicts', async () => {
    const r = await replay({
      candles: { 'BTC-PERP': mk(NOW, wave) },
      policy: parsePolicy(SESSION_POLICY),
      strategy: { kind: 'band', bandBps: 60, quoteNotional: usd('10.5') },
      signer,
      penaltyTicks: 1,
      feeBps: 0,
    });
    expect(r.allowed).toBeGreaterThan(0);
    expect(r.allowed + r.blocked + r.needsOk).toBe(r.intents);
  });

  it('skew strategy stays inside the guard and charges fees when asked', async () => {
    const r = await replay({
      candles: { 'BTC-PERP': mk(NOW, wave) },
      policy: parsePolicy(SESSION_POLICY),
      strategy: {
        kind: 'skew',
        cfg: { ...DEFAULT_SKEW, quoteNotional: usd('10.5'), maxInventoryNotional: usd('29.5') },
      },
      signer,
      penaltyTicks: 1,
      feeBps: 2,
    });
    expect(r.fills).toBeGreaterThan(0);
    expect(r.feesUsd).toBeGreaterThan(0);
    expect(r.needsOk).toBe(0);
  });
});
