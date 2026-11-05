import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { replay, type Candle } from '../src/backtest/replay.js';
import { runSession } from '../src/cli/session.js';
import {
  DEFAULT_PROFIT_RULES,
  makerOnly,
  parseProfitRules,
  parseSkewConfig,
  sessionLossStop,
  skewProfitFields,
} from '../src/engine/profit-rules.js';
import {
  DEFAULT_SKEW,
  quoteEdgeBps,
  requiredEdgeBps,
  SkewState,
  skewMaker,
  type SkewMakerConfig,
} from '../src/engine/skew-maker.js';
import { DEFAULT_STRATEGY_RULES, parseStrategyRules } from '../src/engine/strategy-rules.js';
import { parsePolicy, SESSION_POLICY } from '../src/gate/policy.js';
import type { OrderIntent } from '../src/gate/types.js';
import { usd } from '../src/gate/units.js';
import { SimVenue, simMarkets } from '../src/venue/index.js';
import type { VenueSnapshot } from '../src/venue/types.js';
import { NOW } from './fixtures.js';

// anvil test key 0 (public, allowlisted in .gitleaks.toml)
const signer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const markets = Object.fromEntries(simMarkets(NOW).map((m) => [m.market, m]));
const btc = markets['BTC-PERP'];
if (btc === undefined) throw new Error('fixture');
const cfg: SkewMakerConfig = {
  ...DEFAULT_SKEW,
  markets: ['BTC-PERP'],
  quoteNotional: usd('10.5'),
  maxInventoryNotional: usd('29.5'),
  agent: 'skew-maker',
};
const at = (bps: bigint) => ({
  ...markets,
  'BTC-PERP': { ...btc, markPrice: (btc.markPrice * (10_000n + bps)) / 10_000n },
});

describe('profit rule: quote only with edge', () => {
  it('measures edge on the right side of the mark', () => {
    expect(quoteEdgeBps(10_000n, 9_975n, true)).toBe(25);
    expect(quoteEdgeBps(10_000n, 10_030n, false)).toBe(30);
    expect(quoteEdgeBps(10_000n, 10_010n, true)).toBe(-10);
    expect(quoteEdgeBps(0n, 1n, true)).toBe(0);
    expect(requiredEdgeBps({ makerFeeBps: 2, minEdgeBps: 3 })).toBe(7);
  });

  it('the default spread clears the default edge floor on both sides', () => {
    const s = skewMaker(cfg, new SkewState(), markets, {}, [], NOW);
    expect(s.intents).toHaveLength(2);
    expect(s.noEdge).toHaveLength(0);
  });

  it('skips opening quotes when fees eat the spread', () => {
    const s = skewMaker({ ...cfg, makerFeeBps: 15, minEdgeBps: 0 }, new SkewState(), markets, {}, [], NOW);
    expect(s.intents).toHaveLength(0);
    expect(s.noEdge).toHaveLength(2);
    expect(s.noEdge[0]).toContain('< 30 bps');
  });

  it('still asks for the reducing quote when the opening side has no edge', () => {
    const s = skewMaker(
      { ...cfg, makerFeeBps: 40, minEdgeBps: 0 },
      new SkewState(),
      markets,
      { 'BTC-PERP': 14_000n },
      [],
      NOW,
    );
    expect(s.intents.map((i) => i.side)).toEqual(['short']);
    expect(s.noEdge.join(' ')).toContain('long');
  });
});

describe('profit rule: per-trade take-profit and stop-loss', () => {
  const pos = { 'BTC-PERP': 200_000n };

  it('takes profit with a reduce-only post-only exit once the move reaches takeProfitBps', () => {
    const st = new SkewState();
    skewMaker(cfg, st, markets, pos, [], NOW);
    const s = skewMaker(cfg, st, at(60n), pos, [], NOW + 60);
    expect(s.exits.join(' ')).toContain('tp ');
    expect(s.intents).toHaveLength(1);
    expect(s.intents[0]?.reduceOnly).toBe(true);
    expect(s.intents[0]?.orderType).toBe('post_only');
  });

  it('takes profit on a short when the mark falls', () => {
    const st = new SkewState();
    const short = { 'BTC-PERP': -200_000n };
    skewMaker(cfg, st, markets, short, [], NOW);
    const s = skewMaker(cfg, st, at(-60n), short, [], NOW + 60);
    expect(s.exits.join(' ')).toContain('tp ');
    expect(s.intents.every((i) => i.reduceOnly && i.side === 'long')).toBe(true);
  });

  it('does not take profit below the threshold or when switched off', () => {
    const st = new SkewState();
    skewMaker(cfg, st, markets, pos, [], NOW);
    expect(skewMaker(cfg, st, at(30n), pos, [], NOW + 60).exits).toHaveLength(0);
    const off = { ...cfg, takeProfitBps: 0 };
    const st2 = new SkewState();
    skewMaker(off, st2, markets, pos, [], NOW);
    expect(skewMaker(off, st2, at(500n), pos, [], NOW + 60).exits).toHaveLength(0);
  });

  it('the stop-loss still wins on an adverse move', () => {
    const st = new SkewState();
    skewMaker(cfg, st, markets, pos, [], NOW);
    expect(skewMaker(cfg, st, at(-80n), pos, [], NOW + 60).exits.join(' ')).toContain('stop');
  });
});

describe('profit rule: maker only', () => {
  const base: OrderIntent = {
    market: 'BTC-PERP',
    side: 'long',
    orderType: 'post_only',
    price: 1n,
    quantity: 1n,
    reduceOnly: false,
    agent: 'a',
    reason: 'r',
  };
  const ioc: OrderIntent = { ...base, orderType: 'ioc' };
  const closeIoc: OrderIntent = { ...base, orderType: 'ioc', reduceOnly: true };

  it('drops opening intents that are not post_only, keeps reduce-only ones', () => {
    const r = makerOnly([base, ioc, closeIoc], DEFAULT_PROFIT_RULES);
    expect(r.kept).toEqual([base, closeIoc]);
    expect(r.dropped).toEqual([ioc]);
  });

  it('can be switched off', () => {
    expect(makerOnly([ioc], { postOnly: false }).kept).toEqual([ioc]);
  });
});

describe('profit rule: max loss per session', () => {
  it('stops at or past the limit only', () => {
    const r = { maxSessionLossUsd: usd('1') };
    expect(sessionLossStop(usd('100'), usd('99.5'), r)).toBeUndefined();
    expect(sessionLossStop(usd('100'), usd('101'), r)).toBeUndefined();
    expect(sessionLossStop(usd('100'), usd('99'), r)).toBe('session loss limit: -1 USDso (limit 1)');
    expect(sessionLossStop(usd('100'), usd('98.75'), r)).toContain('-1.25');
  });
});

describe('profit rules config', () => {
  it('has conservative documented defaults', () => {
    expect(DEFAULT_PROFIT_RULES).toEqual({
      makerFeeBps: 2,
      minEdgeBps: 3,
      takeProfitBps: 50,
      maxSessionLossUsd: usd('1'),
      postOnly: true,
    });
    expect(skewProfitFields(DEFAULT_PROFIT_RULES)).toEqual({
      makerFeeBps: 2,
      minEdgeBps: 3,
      takeProfitBps: 50,
    });
  });

  it('refuses unknown keys, bad amounts and out-of-range values', () => {
    expect(() => parseProfitRules({ maxLoss: 1 })).toThrow();
    expect(() => parseProfitRules({ maxSessionLossUsd: '0' })).toThrow();
    expect(() => parseProfitRules({ maxSessionLossUsd: '-1' })).toThrow();
    expect(() => parseProfitRules({ makerFeeBps: -1 })).toThrow();
    expect(() => parseProfitRules({ takeProfitBps: 1.5 })).toThrow();
    expect(parseProfitRules({ maxSessionLossUsd: '0.5' }).maxSessionLossUsd).toBe(usd('0.5'));
    expect(parseProfitRules(undefined)).toEqual(DEFAULT_PROFIT_RULES);
  });

  it('validates the skew config file strictly', () => {
    expect(parseSkewConfig(undefined).halfSpreadBps).toBe(DEFAULT_SKEW.halfSpreadBps);
    expect(parseSkewConfig({ stopBps: 40 }).stopBps).toBe(40);
    expect(() => parseSkewConfig({ stopBPS: 40 })).toThrow();
    expect(() => parseSkewConfig({ halfSpreadBps: 0 })).toThrow();
    expect(() => parseSkewConfig({ maxHoldSec: 10 })).toThrow();
  });

  it('reads the profit section of a rules file and accepts the runtime sections', () => {
    expect(parseStrategyRules(undefined)).toEqual(DEFAULT_STRATEGY_RULES);
    const r = parseStrategyRules({ rpcGate: { enabled: true }, flatten: {}, profit: { takeProfitBps: 0 } });
    expect(r.profit.takeProfitBps).toBe(0);
    expect(() => parseStrategyRules({ profits: {} })).toThrow();
  });

  it('the documented example equals the defaults', async () => {
    const ex = JSON.parse(await readFile('docs/strategy-rules.example.json', 'utf8')) as unknown;
    expect(parseStrategyRules(ex)).toEqual(DEFAULT_STRATEGY_RULES);
  });
});

/** Sim venue whose equity bleeds by `drop` per wait, to drive the session loss stop. */
class BleedingVenue extends SimVenue {
  loss = 0n;
  override async snapshot(m: readonly string[]): Promise<VenueSnapshot> {
    const s = await super.snapshot(m);
    return { ...s, account: { ...s.account, equity: s.account.equity - this.loss } };
  }
}

async function session(o: { drop: bigint; profit?: ReturnType<typeof parseProfitRules> }) {
  let clock = NOW;
  const venue = new BleedingVenue(simMarkets(NOW), { collateral: usd('1000'), now: () => clock, seed: 7 });
  const dir = await mkdtemp(join(tmpdir(), 'cgp-profit-'));
  const lines: string[] = [];
  const r = await runSession({
    venue,
    policy: parsePolicy(SESSION_POLICY),
    journalPath: join(dir, 's.jsonl'),
    statusPath: join(dir, 'status.json'),
    signer,
    now: () => clock,
    wait: (sec) => {
      clock += sec;
      venue.loss += o.drop;
      return Promise.resolve();
    },
    log: (l) => lines.push(l),
    approve: () => Promise.resolve(false),
    seconds: 1200,
    cycleSec: 60,
    probeEvery: 0,
    quoteNotional: usd('10.5'),
    bandBps: 40,
    strategy: 'skew',
    minGas: 10n,
    ...(o.profit === undefined ? {} : { profit: o.profit }),
  });
  return { r, lines };
}

describe('session runner with the profit rules', () => {
  it('ends the session on the loss limit with a normal close-out, no kill switch', async () => {
    const { r, lines } = await session({ drop: usd('0.3') });
    expect(r.stopReason).toMatch(/^session loss limit: -1\.2 USDso \(limit 1\)$/);
    expect(r.profit.lossStop).toBe(true);
    expect(r.cycles).toBe(5);
    expect(r.flat).toBe(true);
    expect(lines.join('\n')).not.toContain('kill switch:');
  });

  it('runs to time when the loss stays under the limit', async () => {
    const { r } = await session({ drop: 0n });
    expect(r.stopReason).toBe('time is up');
    expect(r.profit).toEqual({ noEdge: 0, droppedNotMaker: 0, lossStop: false });
  });

  it('counts and logs openings skipped for edge', async () => {
    const { r, lines } = await session({
      drop: 0n,
      profit: parseProfitRules({ makerFeeBps: 15, minEdgeBps: 0 }),
    });
    expect(r.profit.noEdge).toBeGreaterThan(0);
    expect(r.counts.allowed).toBe(0);
    expect(lines.some((l) => l.startsWith('[no edge]'))).toBe(true);
  });
});

describe('replay with the profit rules', () => {
  const mk = (start: number, prices: number[]): Candle[] =>
    prices.map((p, i) => {
      const v = (BigInt(Math.round(p * 10)) * 10n ** 17n).toString();
      return { bucketStart: String(start + i * 60), openPrice: v, high: v, low: v, closePrice: v };
    });
  // a steady fall: a maker that buys keeps losing
  const fall = Array.from({ length: 600 }, (_, i) => 78_000 + 800 * Math.sin(i / 15) - i * 8);
  const strategy = {
    kind: 'skew' as const,
    cfg: { ...DEFAULT_SKEW, quoteNotional: usd('10.5'), maxInventoryNotional: usd('29.5') },
  };

  it('stops a session on its loss limit and resumes in the next one', async () => {
    const base = {
      candles: { 'BTC-PERP': mk(NOW, fall) },
      policy: parsePolicy(SESSION_POLICY),
      strategy,
      signer,
    };
    const without = await replay(base);
    const once = await replay({ ...base, profit: { maxSessionLossUsd: usd('0.05'), postOnly: true } });
    const split = await replay({
      ...base,
      feeBps: 2,
      profit: { maxSessionLossUsd: usd('0.05'), postOnly: true },
      sessionSec: 3600,
    });
    expect(without.sessionLossStops).toBe(0);
    expect(without.sessions).toBe(1);
    expect(once.sessionLossStops).toBe(1);
    expect(once.fills).toBeLessThan(without.fills);
    expect(split.sessions).toBe(10);
    expect(split.sessionLossStops).toBeGreaterThan(1);
    expect(once.droppedNotMaker).toBe(0);
  });
});
