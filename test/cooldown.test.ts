import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { replay, type Candle } from '../src/backtest/replay.js';
import { runSession } from '../src/cli/session.js';
import {
  DEFAULT_COOLDOWN,
  LossCooldown,
  parseCooldown,
  TradeTracker,
  vanishedOrders,
  type ClosedTrade,
} from '../src/engine/cooldown.js';
import type { TrackedOrder } from '../src/engine/engine.js';
import { DEFAULT_SKEW } from '../src/engine/skew-maker.js';
import { DEFAULT_STRATEGY_RULES, parseStrategyRules } from '../src/engine/strategy-rules.js';
import { parsePolicy, SESSION_POLICY } from '../src/gate/policy.js';
import type { OrderIntent } from '../src/gate/types.js';
import { usd } from '../src/gate/units.js';
import { SimVenue, simMarkets } from '../src/venue/index.js';
import { NOW } from './fixtures.js';

// anvil test key 0 (public, allowlisted in .gitleaks.toml)
const signer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const markets = Object.fromEntries(simMarkets(NOW).map((m) => [m.market, m]));
const btc = markets['BTC-PERP'];
if (btc === undefined) throw new Error('fixture');
const scale = 10n ** BigInt(btc.baseDecimals);
const P = btc.markPrice;
const mk = (price: bigint) => ({ ...markets, 'BTC-PERP': { ...btc, markPrice: price } });
const order = (side: 'long' | 'short', price: bigint, id = 1n): TrackedOrder => ({
  market: 'BTC-PERP',
  orderId: id,
  side,
  price,
});
const trade = (pnl: bigint): ClosedTrade => ({
  market: 'BTC-PERP',
  side: 'long',
  pnl,
  openedAt: NOW,
  closedAt: NOW,
});

describe('cooldown config', () => {
  it('defaults to 2 losing trades -> 10 minutes, and is strict', () => {
    expect(DEFAULT_COOLDOWN).toEqual({
      enabled: true,
      lossStreak: 2,
      cooldownSec: 600,
      lossToleranceCents: 0,
    });
    expect(parseCooldown(undefined)).toEqual(DEFAULT_COOLDOWN);
    expect(() => parseCooldown({ streak: 2 })).toThrow();
    expect(() => parseCooldown({ lossStreak: 0 })).toThrow();
    expect(() => parseCooldown({ cooldownSec: -1 })).toThrow();
    expect(parseStrategyRules({ cooldown: { cooldownSec: 900 } }).cooldown.cooldownSec).toBe(900);
    expect(DEFAULT_STRATEGY_RULES.cooldown).toEqual(DEFAULT_COOLDOWN);
  });
});

describe('trade tracker (P&L estimated from snapshots)', () => {
  it('closes a winning long at the vanished order price', () => {
    const t = new TradeTracker(0);
    expect(t.observe({ 'BTC-PERP': scale }, markets, [order('long', P)], NOW)).toEqual([]);
    const c = t.observe({}, markets, [order('short', P + 100n * 10n ** 18n, 2n)], NOW + 60);
    expect(c).toHaveLength(1);
    expect(c[0]?.side).toBe('long');
    expect(c[0]?.pnl).toBe(100n * 10n ** 18n);
    expect(c[0]?.openedAt).toBe(NOW);
  });

  it('falls back to the mark and charges the fee estimate on both fills', () => {
    const t = new TradeTracker(2);
    t.observe({ 'BTC-PERP': -scale }, markets, [], NOW);
    const c = t.observe({ 'BTC-PERP': 0n }, mk(P), [], NOW + 60);
    // flat price, two fills at 2 bps each
    expect(c[0]?.side).toBe('short');
    expect(c[0]?.pnl).toBe(-((P * 4n) / 10_000n));
  });

  it('reduces in parts and closes once flat; a flip closes and opens the other way', () => {
    const t = new TradeTracker(0);
    t.observe({ 'BTC-PERP': 2n * scale }, mk(P), [], NOW);
    expect(t.observe({ 'BTC-PERP': scale }, mk(P - 10n ** 18n), [], NOW + 60)).toEqual([]);
    const flip = t.observe({ 'BTC-PERP': -scale }, mk(P - 2n * 10n ** 18n), [], NOW + 120);
    expect(flip).toHaveLength(1);
    expect(flip[0]?.pnl).toBe(-3n * 10n ** 18n);
    const back = t.observe({}, mk(P - 5n * 10n ** 18n), [], NOW + 180);
    expect(back[0]?.side).toBe('short');
    expect(back[0]?.pnl).toBe(3n * 10n ** 18n);
  });

  it('adds to a position at the average entry and ignores unknown markets', () => {
    const t = new TradeTracker(0);
    t.observe({ 'BTC-PERP': scale }, mk(P), [], NOW);
    t.observe({ 'BTC-PERP': 2n * scale }, mk(P + 2n * 10n ** 18n), [], NOW + 60);
    expect(t.observe({}, mk(P + 1n * 10n ** 18n), [], NOW + 120)[0]?.pnl).toBe(0n);
    expect(t.observe({ 'XYZ-PERP': 5n }, markets, [], NOW)).toEqual([]);
  });
});

describe('loss cooldown', () => {
  it('starts after 2 losing trades in a row and lasts cooldownSec', () => {
    const c = new LossCooldown(DEFAULT_COOLDOWN);
    expect(c.record([trade(-1n)], NOW)).toBeUndefined();
    const why = c.record([trade(-1n)], NOW + 60);
    expect(why).toContain('2 losing trades in a row');
    expect(c.active(NOW + 60)).toBe(true);
    expect(c.active(NOW + 60 + 599)).toBe(true);
    expect(c.active(NOW + 60 + 600)).toBe(false);
    expect(c.stats()).toMatchObject({ trades: 2, losses: 2, cooldowns: 1 });
  });

  it('a win in between resets the streak; tolerance ignores tiny losses', () => {
    const c = new LossCooldown(DEFAULT_COOLDOWN);
    c.record([trade(-1n), trade(0n), trade(-1n)], NOW);
    expect(c.active(NOW)).toBe(false);
    const tol = new LossCooldown(parseCooldown({ lossToleranceCents: 1 }));
    tol.record([trade(-(10n ** 15n)), trade(-(10n ** 15n))], NOW);
    expect(tol.active(NOW)).toBe(false);
    expect(tol.stats().losses).toBe(0);
  });

  it('does nothing when disabled', () => {
    const c = new LossCooldown(parseCooldown({ enabled: false }));
    expect(c.record([trade(-1n), trade(-1n), trade(-1n)], NOW)).toBeUndefined();
    expect(c.active(NOW)).toBe(false);
    expect(c.stats().losses).toBe(3);
  });

  const intent = (side: 'long' | 'short', quantity = 10n, reduceOnly = false): OrderIntent => ({
    market: 'BTC-PERP',
    side,
    orderType: 'post_only',
    price: P,
    quantity,
    reduceOnly,
    agent: 'a',
    reason: 'r',
  });

  it('during a cooldown only reduces: openings dropped, reducing quotes made reduce-only and capped', () => {
    const c = new LossCooldown(DEFAULT_COOLDOWN);
    const all = [intent('long'), intent('short', 50n), intent('short', 5n, true)];
    expect(c.filter(all, { 'BTC-PERP': 20n }, NOW)).toEqual(all); // not active
    c.record([trade(-1n), trade(-1n)], NOW);
    const out = c.filter(all, { 'BTC-PERP': 20n }, NOW + 1);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ side: 'short', reduceOnly: true, quantity: 20n });
    expect(out[0]?.reason).toContain('cooldown: reduce only');
    expect(out[1]).toEqual(intent('short', 5n, true));
    expect(c.filter([intent('long'), intent('short')], {}, NOW + 1)).toEqual([]);
    expect(c.filter([intent('short', 5n)], { 'BTC-PERP': 20n }, NOW + 1)[0]?.quantity).toBe(5n);
    expect(c.stats().droppedOpenings).toBe(3);
  });

  it('picks the resting orders that would add to or open a position', () => {
    const c = new LossCooldown(DEFAULT_COOLDOWN);
    const tr = [order('long', P, 1n), order('short', P, 2n), { ...order('long', P, 3n), market: 'ETH-PERP' }];
    expect(c.openingOrders(tr, { 'BTC-PERP': 5n }).map((o) => o.orderId)).toEqual([1n, 3n]);
    expect(c.openingOrders(tr, { 'BTC-PERP': -5n }).map((o) => o.orderId)).toEqual([2n, 3n]);
  });

  it('finds the tracked orders that vanished', () => {
    const a = order('long', P, 1n);
    const b = order('short', P, 2n);
    expect(
      vanishedOrders(
        new Map([
          [1n, a],
          [2n, b],
        ]),
        new Map([[2n, b]]),
      ),
    ).toEqual([a]);
  });
});

describe('session runner with the cooldown', () => {
  async function session(cooldown: ReturnType<typeof parseCooldown>) {
    let clock = NOW;
    const venue = new SimVenue(simMarkets(NOW), { collateral: usd('1000'), now: () => clock, seed: 7 });
    const dir = await mkdtemp(join(tmpdir(), 'cgp-cool-'));
    const lines: string[] = [];
    const statuses: string[] = [];
    const statusPath = join(dir, 'status.json');
    const r = await runSession({
      venue,
      policy: parsePolicy(SESSION_POLICY),
      journalPath: join(dir, 's.jsonl'),
      statusPath,
      signer,
      now: () => clock,
      wait: async (sec) => {
        statuses.push((JSON.parse(await readFile(statusPath, 'utf8')) as { state: string }).state);
        clock += sec;
        venue.step(40);
      },
      log: (l) => lines.push(l),
      approve: () => Promise.resolve(false),
      seconds: 4 * 3600,
      cycleSec: 120,
      probeEvery: 0,
      quoteNotional: usd('10.5'),
      bandBps: 40,
      strategy: 'skew',
      minGas: 10n,
      cooldown,
    });
    return { r, lines, statuses };
  }

  it('estimates trades, starts cooldowns on losing streaks and only reduces while cooling', async () => {
    const { r, lines, statuses } = await session(parseCooldown({ lossStreak: 1 }));
    expect(r.cooldown.trades).toBeGreaterThan(0);
    expect(r.cooldown.cooldowns).toBeGreaterThan(0);
    expect(lines.some((l) => l.startsWith('[trade]'))).toBe(true);
    expect(lines.some((l) => l.startsWith('[cooldown]'))).toBe(true);
    expect(statuses).toContain('running (cooldown: reduce only)');
    expect(r.flat).toBe(true);
  });

  it('never cools down when disabled', async () => {
    const { r } = await session(parseCooldown({ enabled: false }));
    expect(r.cooldown.cooldowns).toBe(0);
    expect(r.cooldown.droppedOpenings).toBe(0);
  });
});

describe('replay with the cooldown', () => {
  const mkc = (start: number, prices: number[]): Candle[] =>
    prices.map((p, i) => {
      const v = (BigInt(Math.round(p * 10)) * 10n ** 17n).toString();
      return { bucketStart: String(start + i * 60), openPrice: v, high: v, low: v, closePrice: v };
    });
  const wave = Array.from({ length: 900 }, (_, i) => 78_000 + 800 * Math.sin(i / 15) - i * 4);
  const base = {
    candles: { 'BTC-PERP': mkc(NOW, wave) },
    policy: parsePolicy(SESSION_POLICY),
    strategy: {
      kind: 'skew' as const,
      cfg: { ...DEFAULT_SKEW, quoteNotional: usd('10.5'), maxInventoryNotional: usd('29.5') },
    },
    signer,
    feeBps: 2,
  };

  it('runs the same cooldown code and reports its counters', async () => {
    const on = await replay({ ...base, cooldown: parseCooldown({ lossStreak: 1 }) });
    const off = await replay({ ...base, cooldown: parseCooldown({ enabled: false }) });
    const none = await replay(base);
    expect(on.cooldown?.trades).toBeGreaterThan(0);
    expect(on.cooldown?.cooldowns).toBeGreaterThan(0);
    expect(off.cooldown?.cooldowns).toBe(0);
    expect(none.cooldown).toBeUndefined();
  });
});
