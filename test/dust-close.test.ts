// Residuals below the venue minimum. dreamDEX rejects QuantityBelowMinimum / InvalidQuantity /
// ZeroQuoteFillsAllowed and has no reduce-only clamp, so close-out and kill must not round a position up.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { killAccountLine, killStopLine } from '../src/cli/stop.js';
import { Engine } from '../src/engine/engine.js';
import { EMPTY_MEMORY, evaluate, isReducing, utcDay } from '../src/gate/index.js';
import { DEMO_POLICY, parsePolicy, policyHash } from '../src/gate/policy.js';
import type { OrderIntent } from '../src/gate/types.js';
import { usd } from '../src/gate/units.js';
import { planFlatten } from '../src/killswitch/index.js';
import { anchorCode } from '../src/receipts/anchor.js';
import { Journal } from '../src/receipts/journal.js';
import { closeOut, parseFlattenRetry } from '../src/runtime/closeout.js';
import { SimVenue, simMarkets, type Venue, type VenueMarket } from '../src/venue/index.js';
import { NOW, account } from './fixtures.js';

// anvil test key 0 (public, allowlisted in .gitleaks.toml)
const signer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const policy = parsePolicy(DEMO_POLICY);

const ETH_DUST = 100_000_000_000_000n; // 0.0001 ETH, the 6 Nov residual
const ETH_MIN = 4n * 10n ** 15n; // 0.004 ETH
const ETH_LOT = 10n ** 14n;

const retry = parseFlattenRetry({
  retryBudgetSec: 2,
  backoffBaseSec: 0.01,
  backoffMaxSec: 0.02,
  passTimeoutSec: 1,
  maxRetries: 5,
});

const fast = {
  reason: 'end of session',
  budgetMs: 2_000,
  stepMs: 500,
  attempts: 3,
  pauseMs: 0,
  backoffMs: 1,
  retry,
};

async function rig(opts?: { maxIocFill?: bigint; markets?: readonly VenueMarket[] }) {
  const markets = opts?.markets ?? simMarkets(NOW);
  const sim = new SimVenue(markets, {
    collateral: usd('1000'),
    now: () => NOW,
    seed: 1,
    ...(opts?.maxIocFill === undefined ? {} : { maxIocFill: opts.maxIocFill }),
  });
  const dir = await mkdtemp(join(tmpdir(), 'cgp-dust-'));
  const journal = await Journal.open(join(dir, 'j.jsonl'), signer, policyHash(policy));
  const engine = new Engine({ venue: sim, policy, journal, now: () => NOW });
  return { sim, journal, engine };
}

function eth(): VenueMarket {
  const m = simMarkets(NOW).find((x) => x.market === 'ETH-PERP');
  if (m === undefined) throw new Error('ETH-PERP missing');
  return m;
}

const abs = (v: bigint): bigint => (v < 0n ? -v : v);

describe('6 Nov ETH dust', () => {
  it('plans no order that would flip 0.0001 ETH, and says the account is not flat', () => {
    const m = eth();
    expect(m.minQuantity).toBe(ETH_MIN);
    expect(m.lotSize).toBe(ETH_LOT);
    const plan = planFlatten(policy, { 'ETH-PERP': ETH_DUST }, [], { 'ETH-PERP': m });
    expect(plan.reduces).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]).toMatchObject({ market: 'ETH-PERP', position: ETH_DUST, terminal: true });
    const why = plan.skipped[0]?.why ?? '';
    expect(why).toContain(ETH_DUST.toString());
    expect(why).toContain(ETH_MIN.toString());
    expect(why).toContain('QuantityBelowMinimum');
    expect(why).toContain('increase exposure');
    expect(why).toContain('not flat');
    // the manual fold (dust + min) is an opening short, not a reduce
    const fold = ETH_DUST + ETH_MIN;
    expect(isReducing(ETH_DUST, { side: 'short', quantity: fold })).toBe(false);
    expect(fold > ETH_DUST).toBe(true);
  });

  it('abort and kill both leave the dust, send nothing, and keep their receipt kinds', async () => {
    const a = await rig();
    const k = await rig();
    a.sim.setPosition('ETH-PERP', ETH_DUST);
    k.sim.setPosition('ETH-PERP', -ETH_DUST);
    const ao = await a.engine.abort('end of session');
    const ko = await k.engine.kill('operator');
    expect(ao.plan.reduces).toEqual([]);
    expect(ko.plan.reduces).toEqual([]);
    expect(ao.plan.skipped.map((s) => s.why)).toEqual(ko.plan.skipped.map((s) => s.why));
    expect(ao.problems).toEqual([]);
    expect(ko.problems).toEqual([]);
    expect(a.sim.fills).toEqual([]);
    expect(k.sim.fills).toEqual([]);
    expect((await a.sim.snapshot(['ETH-PERP'])).account.positions['ETH-PERP']).toBe(ETH_DUST);
    expect((await k.sim.snapshot(['ETH-PERP'])).account.positions['ETH-PERP']).toBe(-ETH_DUST);
    expect(a.engine.killSwitch.tripped).toBe(false);
    expect(k.engine.killSwitch.tripped).toBe(true);
    const aborted = a.journal.receipts.find((r) => r.kind === 'session_aborted');
    const tripped = k.journal.receipts.find((r) => r.kind === 'kill_switch' && r.data['action'] === 'trip');
    expect(aborted).toBeDefined();
    expect(tripped).toBeDefined();
    if (aborted === undefined || tripped === undefined) throw new Error('receipt');
    expect(anchorCode(aborted)).toBe(4);
    expect(anchorCode(tripped)).toBe(5);
    expect(a.journal.receipts.some((r) => r.kind === 'decision' || r.kind === 'kill_switch')).toBe(false);
    expect(k.journal.receipts.some((r) => r.kind === 'decision' || r.kind === 'session_aborted')).toBe(false);
    // repeating it does not open or grow the position
    await a.engine.abort('again');
    await k.engine.kill('again');
    expect(a.sim.fills).toEqual([]);
    expect(k.sim.fills).toEqual([]);
    expect((await a.sim.snapshot(['ETH-PERP'])).account.positions['ETH-PERP']).toBe(ETH_DUST);
    expect((await k.sim.snapshot(['ETH-PERP'])).account.positions['ETH-PERP']).toBe(-ETH_DUST);
  });

  it('close-out reports the residual once and does not spend the retry phase', async () => {
    const { sim, engine, journal } = await rig();
    sim.setPosition('ETH-PERP', ETH_DUST);
    const lines: string[] = [];
    const r = await closeOut(engine, { ...fast, log: (l) => lines.push(l) });
    expect(r.flat).toBe(false);
    expect(r.retries).toBe(0);
    expect(r.passes).toBe(1);
    expect(r.positions['ETH-PERP']).toBe(ETH_DUST);
    expect(r.errors.some((e) => e.includes('QuantityBelowMinimum') && e.includes('not flat'))).toBe(true);
    expect(lines.some((l) => l.includes('not retrying'))).toBe(true);
    expect(sim.fills).toEqual([]);
    expect(journal.receipts.filter((x) => x.kind === 'session_aborted')).toHaveLength(1);
    expect(engine.killSwitch.tripped).toBe(false);
  });

  it('a guard-trip close-out uses kill and still does not call the residual flat', async () => {
    const { sim, engine, journal } = await rig();
    sim.setPosition('ETH-PERP', ETH_DUST);
    const r = await closeOut(engine, { ...fast, stop: true });
    expect(r.flat).toBe(false);
    expect(r.retries).toBe(0);
    expect(engine.killSwitch.tripped).toBe(true);
    expect(sim.fills).toEqual([]);
    expect(engine.killSwitch.reason ?? '').toMatch(/^manual:/);
    const trip = journal.receipts.find((x) => x.kind === 'kill_switch');
    expect(trip).toBeDefined();
    if (trip === undefined) throw new Error('trip');
    expect(anchorCode(trip)).toBe(5);
    expect(journal.receipts.some((x) => x.kind === 'session_aborted')).toBe(false);
  });

  it('a retry that then sees only dust stops instead of spending the retry budget', async () => {
    let reads = 0;
    const market = eth();
    const engine = {
      snapshot: () => {
        reads += 1;
        if (reads === 1) return Promise.reject(new Error('rpc down'));
        return Promise.resolve({
          orders: [],
          account: { positions: { 'ETH-PERP': ETH_DUST }, equity: 0n, grossNotional: 0n, openOrders: 0 },
          markets: { 'ETH-PERP': market },
          at: NOW,
        });
      },
      abort: () =>
        Promise.resolve({
          plan: planFlatten(policy, { 'ETH-PERP': ETH_DUST }, [], { 'ETH-PERP': market }),
          problems: [],
        }),
      kill: () => Promise.reject(new Error('must not trip')),
    } as unknown as Engine;
    const r = await closeOut(engine, { ...fast, attempts: 1 });
    expect(r.flat).toBe(false);
    expect(r.retries).toBe(1);
    expect(r.errors.some((e) => e.includes('rpc down'))).toBe(true);
    expect(r.errors.some((e) => e.includes('QuantityBelowMinimum'))).toBe(true);
    expect(r.positions['ETH-PERP']).toBe(ETH_DUST);
  });
});

describe('size and quote boundaries', () => {
  it('closes an on-lot position at the minimum, and refuses one lot under it', async () => {
    const atMin = await rig();
    atMin.sim.setPosition('ETH-PERP', ETH_MIN);
    const closed = await atMin.engine.abort('min');
    expect(closed.plan.reduces.map((x) => [x.side, x.quantity, x.reduceOnly])).toEqual([
      ['short', ETH_MIN, true],
    ]);
    expect((await atMin.sim.snapshot(['ETH-PERP'])).account.positions['ETH-PERP']).toBeUndefined();
    expect(atMin.sim.fills.map((f) => f.quantity)).toEqual([ETH_MIN]);

    const under = await rig();
    under.sim.setPosition('ETH-PERP', ETH_MIN - ETH_LOT);
    const left = await under.engine.abort('under');
    expect(left.plan.reduces).toEqual([]);
    expect(left.plan.skipped[0]?.terminal).toBe(true);
    expect(under.sim.fills).toEqual([]);
    expect((await under.sim.snapshot(['ETH-PERP'])).account.positions['ETH-PERP']).toBe(ETH_MIN - ETH_LOT);
  });

  it('closes only the on-lot part and then stops on the remainder', async () => {
    const { sim, engine } = await rig();
    const held = ETH_MIN + ETH_LOT / 2n;
    sim.setPosition('ETH-PERP', held);
    const first = await engine.abort('partial grid');
    expect(first.plan.reduces.map((x) => x.quantity)).toEqual([ETH_MIN]);
    const sent = first.plan.reduces[0]?.quantity;
    expect(sent !== undefined && sent <= held).toBe(true);
    const left = (await sim.snapshot(['ETH-PERP'])).account.positions['ETH-PERP'];
    expect(left).toBe(ETH_LOT / 2n);
    const second = await engine.abort('remainder');
    expect(second.plan.reduces).toEqual([]);
    expect(second.plan.skipped[0]?.terminal).toBe(true);
    expect(sim.fills).toHaveLength(1);
    expect((await sim.snapshot(['ETH-PERP'])).account.positions['ETH-PERP']).toBe(ETH_LOT / 2n);
  });

  it('refuses a size whose on-lot floor is under the minimum even when the position is not', () => {
    const m = { ...eth(), lotSize: 6n, minQuantity: 12n };
    const tooTight = planFlatten(policy, { 'ETH-PERP': 11n }, [], { 'ETH-PERP': m });
    expect(tooTight.reduces).toEqual([]);
    expect(tooTight.skipped[0]?.why).toContain('largest on-lot size that does not exceed the position is 6');
    const fits = planFlatten(policy, { 'ETH-PERP': 14n }, [], { 'ETH-PERP': m });
    expect(fits.reduces.map((x) => x.quantity)).toEqual([12n]);
    expect(fits.reduces[0] && isReducing(14n, fits.reduces[0])).toBe(true);
  });

  it('refuses a reduce whose quote value rounds to zero', () => {
    const m = { ...eth(), markPrice: 1n, tickSize: 1n, lotSize: 1n, minQuantity: 1n };
    const plan = planFlatten(policy, { 'ETH-PERP': 10n }, [], { 'ETH-PERP': m });
    expect(plan.reduces).toEqual([]);
    expect(plan.skipped[0]?.terminal).toBe(true);
    expect(plan.skipped[0]?.why).toContain('ZeroQuoteFillsAllowed');
    expect(plan.skipped[0]?.why).toContain('not flat');
  });

  it('refuses a zero exit price and a market spec that cannot size an order', () => {
    const coarse = { ...eth(), markPrice: 1n, tickSize: 10n, lotSize: 1n, minQuantity: 1n };
    const priced = planFlatten(policy, { 'ETH-PERP': 5n }, [], { 'ETH-PERP': coarse });
    expect(priced.reduces).toEqual([]);
    expect(priced.skipped[0]?.why).toContain('exit price rounded to zero');
    const bad = { ...eth(), lotSize: 0n };
    const spec = planFlatten(policy, { 'ETH-PERP': ETH_MIN }, [], { 'ETH-PERP': bad });
    expect(spec.reduces).toEqual([]);
    expect(spec.skipped[0]?.why).toContain('market spec cannot size');
  });

  it('a stale mark still reduces; a missing mark does not, and is not terminal', () => {
    const m = eth();
    const stale = planFlatten(policy, { 'ETH-PERP': ETH_MIN }, [], {
      'ETH-PERP': { ...m, markUpdatedAt: NOW - 10_000 },
    });
    expect(stale.reduces.map((x) => x.quantity)).toEqual([ETH_MIN]);
    const missing = planFlatten(policy, { 'ETH-PERP': ETH_MIN }, [], {
      'ETH-PERP': { ...m, markPrice: 0n },
    });
    expect(missing.reduces).toEqual([]);
    expect(missing.skipped[0]?.terminal).toBe(false);
  });
});

describe('close-out outcomes', () => {
  it('an already flat account sends nothing and journals nothing', async () => {
    const { engine, journal, sim } = await rig();
    const r = await closeOut(engine, fast);
    expect(r).toMatchObject({ flat: true, passes: 0, retries: 0, openOrders: 0 });
    expect(journal.receipts).toEqual([]);
    expect(sim.fills).toEqual([]);
    const again = await closeOut(engine, fast);
    expect(again.flat).toBe(true);
    expect(again.passes).toBe(0);
  });

  it('kill and abort close the same minimum and only kill trips', async () => {
    const a = await rig();
    const k = await rig();
    a.sim.setPosition('ETH-PERP', -ETH_MIN);
    k.sim.setPosition('ETH-PERP', -ETH_MIN);
    const ao = await a.engine.abort('end');
    const ko = await k.engine.kill('operator');
    const pick = (x: OrderIntent) => [x.market, x.side, x.quantity, x.reduceOnly] as const;
    expect(ao.plan.reduces.map(pick)).toEqual(ko.plan.reduces.map(pick));
    expect(ao.plan.reduces[0]?.side).toBe('long');
    expect((await a.sim.snapshot(['ETH-PERP'])).account.positions['ETH-PERP']).toBeUndefined();
    expect((await k.sim.snapshot(['ETH-PERP'])).account.positions['ETH-PERP']).toBeUndefined();
    expect(a.engine.killSwitch.tripped).toBe(false);
    expect(k.engine.killSwitch.tripped).toBe(true);
  });

  it('a partial fill is retried until flat and never increases exposure', async () => {
    const { sim, engine } = await rig({ maxIocFill: ETH_MIN });
    const start = ETH_MIN * 3n;
    sim.setPosition('ETH-PERP', start);
    const seen: { before: bigint; qty: bigint; after: bigint; reduceOnly: boolean }[] = [];
    const innerPlace = sim.place.bind(sim);
    sim.place = (market, intent) =>
      sim.snapshot([intent.market]).then((beforeSnap) => {
        const before = beforeSnap.account.positions[intent.market] ?? 0n;
        return innerPlace(market, intent).then((res) =>
          sim.snapshot([intent.market]).then((afterSnap) => {
            const after = afterSnap.account.positions[intent.market] ?? 0n;
            seen.push({ before, qty: intent.quantity, after, reduceOnly: intent.reduceOnly });
            return res;
          }),
        );
      });
    const r = await closeOut(engine, { ...fast, retry: parseFlattenRetry({ enabled: false }) });
    expect(r.flat).toBe(true);
    expect(seen.length).toBeGreaterThan(1);
    for (const s of seen) {
      expect(s.reduceOnly).toBe(true);
      expect(s.qty <= abs(s.before)).toBe(true);
      expect(abs(s.after) < abs(s.before)).toBe(true);
      expect(s.after === 0n || s.after > 0n === s.before > 0n).toBe(true);
    }
  });

  it('a partial fill that leaves dust stops and does not round the remainder up', async () => {
    const { sim, engine } = await rig({ maxIocFill: ETH_MIN });
    sim.setPosition('ETH-PERP', ETH_MIN + ETH_LOT);
    const r = await closeOut(engine, { ...fast, retry: parseFlattenRetry({ enabled: false }) });
    expect(r.flat).toBe(false);
    expect(r.positions['ETH-PERP']).toBe(ETH_LOT);
    expect(sim.fills).toHaveLength(1);
    expect(sim.fills[0]?.quantity).toBe(ETH_MIN);
    expect(r.errors.some((e) => e.includes('partial fill'))).toBe(true);
    expect(r.errors.some((e) => e.includes('QuantityBelowMinimum'))).toBe(true);
    expect(r.retries).toBe(0);
  });

  it('a venue rejection leaves the position and is not a flat account', async () => {
    const { sim, engine } = await rig();
    sim.setPosition('ETH-PERP', ETH_MIN);
    sim.place = () => Promise.resolve({ ok: false, filled: 0n, errorName: 'InsufficientCollateral' });
    const r = await closeOut(engine, {
      ...fast,
      attempts: 2,
      retry: parseFlattenRetry({ enabled: false }),
    });
    expect(r.flat).toBe(false);
    expect(r.positions['ETH-PERP']).toBe(ETH_MIN);
    expect(r.errors.filter((e) => e.includes('InsufficientCollateral'))).toHaveLength(2);
    expect(sim.fills).toEqual([]);
  });

  it('an unavailable position read is not flat and sends no order', async () => {
    const { sim, engine } = await rig();
    sim.setPosition('ETH-PERP', ETH_MIN);
    const orig = sim.snapshot.bind(sim);
    sim.snapshot = () => Promise.reject(new Error('position read failed'));
    const r = await closeOut(engine, {
      ...fast,
      attempts: 2,
      retry: parseFlattenRetry({ enabled: false }),
    });
    expect(r.flat).toBe(false);
    expect(r.errors.some((e) => e.includes('position read failed'))).toBe(true);
    expect(r.errors.some((e) => e.includes('could not read the account'))).toBe(true);
    expect(sim.fills).toEqual([]);
    sim.snapshot = orig;
    expect((await sim.snapshot(['ETH-PERP'])).account.positions['ETH-PERP']).toBe(ETH_MIN);
  });

  it('a position that shrinks before the order is sent is not flipped', async () => {
    const m = eth();
    const big = ETH_MIN * 2n;
    let reads = 0;
    const placed: OrderIntent[] = [];
    const venue: Venue = {
      mode: 'sim',
      account: '0x00000000000000000000000000000000005e1a7e',
      sender: '0x00000000000000000000000000000000005e1a7e',
      snapshot: () => {
        reads += 1;
        const pos = reads <= 2 ? big : ETH_DUST;
        return Promise.resolve({
          account: { equity: usd('1000'), positions: { 'ETH-PERP': pos }, grossNotional: 0n, openOrders: 0 },
          markets: { 'ETH-PERP': m },
          orders: [],
          at: NOW,
        });
      },
      sizing: () => Promise.resolve({ priceable: true, placeable: true, maxQuantity: 10n ** 24n }),
      place: (_market, intent) => {
        placed.push(intent);
        return Promise.resolve({ ok: true, filled: intent.quantity });
      },
      cancel: () => Promise.resolve({ ok: true }),
      close: () => Promise.resolve(),
    };
    const journal = await Journal.open(
      join(await mkdtemp(join(tmpdir(), 'cgp-stale-')), 'j.jsonl'),
      signer,
      policyHash(policy),
    );
    const engine = new Engine({ venue, policy, journal, now: () => NOW });
    const r = await closeOut(engine, { ...fast, retry: parseFlattenRetry({ enabled: false }) });
    expect(placed).toEqual([]);
    expect(r.flat).toBe(false);
    expect(r.positions['ETH-PERP']).toBe(ETH_DUST);
    expect(r.errors.some((e) => e.includes('NOT_REDUCING'))).toBe(true);
    expect(r.errors.some((e) => e.includes('QuantityBelowMinimum'))).toBe(true);
  });

  it('a missing mark is retried; it is not treated as flat', async () => {
    const { sim, engine } = await rig();
    sim.setPosition('ETH-PERP', ETH_MIN);
    sim.setMark('ETH-PERP', 0n);
    const r = await closeOut(engine, {
      ...fast,
      attempts: 1,
      retry: parseFlattenRetry({
        retryBudgetSec: 0.2,
        backoffBaseSec: 0.01,
        backoffMaxSec: 0.01,
        passTimeoutSec: 1,
        maxRetries: 2,
      }),
    });
    expect(r.flat).toBe(false);
    expect(r.retries).toBe(2);
    expect(sim.fills).toEqual([]);
    expect(r.errors.some((e) => e.includes('no mark price'))).toBe(true);
    expect(r.positions['ETH-PERP']).toBe(ETH_MIN);
  });

  it('still cancels resting orders when the only position is dust', async () => {
    const { sim, engine } = await rig();
    const btc = sim.market('BTC-PERP');
    const placed = await engine.submit({
      market: 'BTC-PERP',
      side: 'long',
      orderType: 'post_only',
      price: btc.markPrice - btc.tickSize,
      quantity: btc.minQuantity,
      reduceOnly: false,
      agent: 'test',
    });
    expect(placed.execution?.result.ok).toBe(true);
    sim.setPosition('ETH-PERP', ETH_DUST);
    const outcome = await engine.abort('cancel and dust');
    expect(outcome.plan.cancels.length).toBe(1);
    expect(outcome.plan.reduces).toEqual([]);
    const snap = await sim.snapshot(['BTC-PERP', 'ETH-PERP']);
    expect(snap.orders).toEqual([]);
    expect(snap.account.positions['ETH-PERP']).toBe(ETH_DUST);
    expect(snap.account.positions['BTC-PERP']).toBeUndefined();
  });

  it('a reducing close above the order cap is still allowed, and dust never becomes an opening', () => {
    const m = simMarkets(NOW)[0];
    if (m === undefined) throw new Error('BTC');
    const qty = 100_000n;
    const plan = planFlatten(policy, { 'BTC-PERP': qty }, [], { 'BTC-PERP': m });
    const reduce = plan.reduces[0];
    expect(reduce).toBeDefined();
    if (reduce === undefined) throw new Error('reduce');
    const d = evaluate({
      intent: reduce,
      policy,
      market: m,
      account: { ...account, positions: { 'BTC-PERP': qty } },
      memory: { ...EMPTY_MEMORY, day: utcDay(NOW), killSwitch: true },
      sizing: undefined,
      now: NOW,
    });
    expect(d.verdict).toBe('allowed');
    expect(d.notional).toBe(0n);
    const dust = planFlatten(policy, { 'ETH-PERP': ETH_DUST }, [], { 'ETH-PERP': eth() });
    expect(dust.reduces).toEqual([]);
  });
});

describe('kill account lines', () => {
  it('does not call a residual flat, and says what anchoring would do', () => {
    expect(killAccountLine(0, 0, true)).toContain('account confirmed flat');
    expect(killAccountLine(0, 1, false)).toContain('NOT flat');
    expect(killStopLine(false, false)).toContain('NOT flat');
    expect(killStopLine(false, false)).toContain('isStopped = false');
    expect(killStopLine(true, false)).toContain('isStopped = true');
    expect(killStopLine(true, false)).toContain('does not remove the residual');
    expect(killStopLine(false)).toContain('will turn it ON');
  });
});
