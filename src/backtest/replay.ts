import { utcDay } from '../gate/gate.js';
// Replay harness: runs the real Engine + guard (evaluate) against a SimVenue whose marks follow recorded
// dreamDEX candles. Nothing here talks to a network. Fills are optimistic by nature (a resting order fills when
// the price trades through it, no queue), so `penaltyTicks` requires the price to trade that many ticks
// THROUGH the order before it counts as filled.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LocalAccount } from 'viem';

import { Engine } from '../engine/engine.js';
import { bandMaker } from '../engine/strategy.js';
import {
  LossCooldown,
  TradeTracker,
  vanishedOrders,
  type CooldownConfig,
  type CooldownStats,
} from '../engine/cooldown.js';
import { makerOnly, sessionLossStop, type ProfitRules } from '../engine/profit-rules.js';
import { SkewState, skewMaker, type SkewMakerConfig } from '../engine/skew-maker.js';
import { policyHash, type Policy } from '../gate/policy.js';
import { floorToGrid, notional } from '../gate/units.js';
import { Journal } from '../receipts/journal.js';
import { SimVenue, simMarkets } from '../venue/index.js';

export interface Candle {
  readonly bucketStart: string | number;
  readonly openPrice: string;
  readonly high: string;
  readonly low: string;
  readonly closePrice: string;
}

export type StrategyChoice =
  | { readonly kind: 'band'; readonly bandBps: number; readonly quoteNotional: bigint }
  | { readonly kind: 'skew'; readonly cfg: Omit<SkewMakerConfig, 'markets' | 'agent'> };

export interface ReplayOptions {
  readonly candles: Readonly<Record<string, readonly Candle[]>>;
  readonly policy: Policy;
  readonly strategy: StrategyChoice;
  readonly signer: LocalAccount;
  readonly cycleSec?: number;
  readonly collateral?: bigint;
  readonly penaltyTicks?: number;
  /** Fee on every fill, bps of notional (stress test; 0 matches what testnet showed on 2 Nov). */
  readonly feeBps?: number;
  /** Only replay this window (unix seconds). */
  readonly from?: number;
  readonly to?: number;
  /** Session rule 2 (maker-only filter and session loss stop). Omit to replay without them. */
  readonly profit?: Pick<ProfitRules, 'maxSessionLossUsd' | 'postOnly'>;
  /** Split the replay into sessions this long (the loss stop resets per session). Omit = one session. */
  readonly sessionSec?: number;
  /** Session rule 3 (loss-streak cooldown), same code as the session runner. Omit to replay without it. */
  readonly cooldown?: CooldownConfig;
}

export interface ReplayResult {
  readonly hours: number;
  readonly cycles: number;
  readonly intents: number;
  readonly allowed: number;
  readonly blocked: number;
  readonly needsOk: number;
  readonly blockedCodes: Record<string, number>;
  readonly fills: number;
  readonly roundTrips: number;
  readonly wins: number;
  readonly winRate: number;
  readonly pnlUsd: number;
  readonly feesUsd: number;
  readonly maxDrawdownUsd: number;
  readonly killSwitchTrips: number;
  readonly exits: Record<string, number>;
  /** Sessions run, sessions ended early by the loss stop, opening intents dropped as not post_only. */
  readonly sessions: number;
  readonly sessionLossStops: number;
  readonly droppedNotMaker: number;
  /** Cooldown counters; trades here are the snapshot estimates the cooldown sees. */
  readonly cooldown?: CooldownStats;
  readonly endPositions: Record<string, string>;
}

const E18 = 10n ** 18n;
const usdNum = (x: bigint): number => Number(x) / 1e18;

export async function replay(o: ReplayOptions): Promise<ReplayResult> {
  const cycleSec = o.cycleSec ?? 120;
  const names = o.policy.markets;
  const series = new Map<string, Map<number, Candle>>();
  const times = new Set<number>();
  for (const n of names) {
    const m = new Map<number, Candle>();
    for (const c of o.candles[n] ?? []) {
      const t = Number(c.bucketStart);
      if ((o.from !== undefined && t < o.from) || (o.to !== undefined && t > o.to)) continue;
      m.set(t, c);
      times.add(t);
    }
    series.set(n, m);
  }
  const ts = [...times].sort((a, b) => a - b);
  const t0 = ts[0] ?? 0;
  let clock = t0;
  const venue = new SimVenue(
    simMarkets(t0).filter((m) => names.includes(m.market)),
    { collateral: o.collateral ?? 1000n * E18, now: () => clock },
  );
  for (const n of names) {
    const first = [...(series.get(n)?.values() ?? [])][0];
    if (first !== undefined) venue.setMark(n, BigInt(first.openPrice), t0);
  }
  const dir = await mkdtemp(join(tmpdir(), 'cgp-replay-'));
  const journal = await Journal.open(join(dir, 'r.jsonl'), o.signer, policyHash(o.policy));
  const engine = new Engine({
    venue,
    policy: o.policy,
    journal,
    now: () => clock,
    approve: () => Promise.resolve(false),
  });
  const st = new SkewState();
  const counts = { intents: 0, allowed: 0, blocked: 0, needsOk: 0 };
  const blockedCodes: Record<string, number> = {};
  const exits: Record<string, number> = {};
  let cycles = 0;
  let trips = 0;
  let nextCycle = t0;
  let peak = venue.equity();
  let maxDd = 0n;
  const start = venue.equity();
  const k = BigInt(o.penaltyTicks ?? 1);
  const feeOf = (f: { market: string; price: bigint; quantity: bigint }): bigint =>
    (notional(f.price, f.quantity, venue.market(f.market).baseDecimals) *
      BigInt(Math.round((o.feeBps ?? 0) * 100))) /
    1_000_000n;
  // running fees, so the loss stop sees net equity
  let feesSoFar = 0n;
  let feeIdx = 0;
  const netEquity = (): bigint => {
    for (; feeIdx < venue.fills.length; feeIdx += 1) {
      const f = venue.fills[feeIdx];
      if (f !== undefined) feesSoFar += feeOf(f);
    }
    return venue.equity() - feesSoFar;
  };
  let sessions = 1;
  let sessionStart = t0;
  let sessionEquity = venue.equity();
  let halted = false;
  let lossStops = 0;
  let droppedNotMaker = 0;
  const trades = new TradeTracker(o.feeBps ?? 0);
  const cooling = o.cooldown === undefined ? undefined : new LossCooldown(o.cooldown);
  let lastTracked = new Map(engine.tracked);

  const budgetLeft = (): bigint => {
    const used = engine.memory.day === utcDay(clock) ? engine.memory.dailyNotional : 0n;
    return o.policy.maxDailyNotionalUsd > used ? o.policy.maxDailyNotionalUsd - used : 0n;
  };
  const runCycle = async (): Promise<void> => {
    cycles += 1;
    if (await engine.watch()) {
      trips += 1;
      await engine.rearm(); // keep replaying; the trip and its flatten are counted
      return;
    }
    if (o.sessionSec !== undefined && clock - sessionStart >= o.sessionSec) {
      sessions += 1;
      sessionStart = clock;
      sessionEquity = netEquity();
      halted = false;
    }
    if (o.profit !== undefined && !halted) {
      const why = sessionLossStop(sessionEquity, netEquity(), o.profit);
      if (why !== undefined) {
        halted = true;
        lossStops += 1;
        await engine.abort(why);
        return;
      }
    }
    const s = await engine.snapshot();
    if (halted) {
      // the session ended on its loss stop: stay out until the next session, close out what is left
      if (Object.keys(s.account.positions).length > 0 || s.orders.length > 0)
        await engine.abort('session loss limit');
      return;
    }
    if (cooling !== undefined) {
      const closed = trades.observe(
        s.account.positions,
        s.markets,
        vanishedOrders(lastTracked, engine.tracked),
        clock,
      );
      if (cooling.record(closed, clock) !== undefined)
        for (const c of cooling.openingOrders([...engine.tracked.values()], s.account.positions))
          await engine.cancel(c, 'cooldown');
    }
    const tracked = [...engine.tracked.values()];
    const step =
      o.strategy.kind === 'band'
        ? bandMaker(
            {
              markets: names,
              bandBps: o.strategy.bandBps,
              requoteBps: o.strategy.bandBps * 2,
              quoteNotional: o.strategy.quoteNotional,
              agent: 'band-maker',
            },
            s.markets,
            tracked,
          )
        : skewMaker(
            { ...o.strategy.cfg, markets: names, agent: 'skew-maker' },
            st,
            s.markets,
            s.account.positions,
            tracked,
            clock,
            budgetLeft(),
          );
    const ex: readonly string[] = 'exits' in step ? (step.exits as readonly string[]) : [];
    for (const e of ex) {
      const kind = e.split(':')[1]?.trim().split(' ')[0] ?? 'exit';
      exits[kind] = (exits[kind] ?? 0) + 1;
    }
    for (const c of step.cancels) await engine.cancel(c, 'requote');
    const wanted =
      cooling === undefined ? step.intents : cooling.filter(step.intents, s.account.positions, clock);
    const { kept, dropped } =
      o.profit === undefined ? { kept: wanted, dropped: [] } : makerOnly(wanted, o.profit);
    droppedNotMaker += dropped.length;
    for (const it of kept) {
      const r = await engine.submit(it);
      counts.intents += 1;
      if (r.decision.verdict === 'allowed') counts.allowed += 1;
      else if (r.decision.verdict === 'needs_ok') counts.needsOk += 1;
      else {
        counts.blocked += 1;
        for (const c of r.decision.codes) blockedCodes[c] = (blockedCodes[c] ?? 0) + 1;
      }
    }
    lastTracked = new Map(engine.tracked);
  };

  for (const t of ts) {
    clock = t;
    for (const n of names) {
      const c = series.get(n)?.get(t);
      const m = venue.market(n);
      if (c === undefined) {
        venue.setMark(n, m.markPrice, t); // oracle mark stays fresh even without trades
        continue;
      }
      const op = BigInt(c.openPrice);
      const cl = BigInt(c.closePrice);
      // trade-through penalty: the extremes count k ticks less far
      const hi = BigInt(c.high) - k * m.tickSize;
      const lo = BigInt(c.low) + k * m.tickSize;
      const path = cl >= op ? [op, lo, hi, cl] : [op, hi, lo, cl];
      for (const p of path) venue.setMark(n, floorToGrid(p > 0n ? p : m.tickSize, m.tickSize), t);
    }
    const eq = venue.equity();
    if (eq > peak) peak = eq;
    if (peak - eq > maxDd) maxDd = peak - eq;
    if (t >= nextCycle) {
      await runCycle();
      nextCycle = t + cycleSec;
    }
  }

  // fees and round trips from the fill list (average-entry accounting, like the venue)
  let fees = 0n;
  let roundTrips = 0;
  let wins = 0;
  const book = new Map<string, { size: bigint; entry: bigint }>();
  for (const f of venue.fills) {
    fees += feeOf(f);
    const p = book.get(f.market) ?? { size: 0n, entry: 0n };
    const d = f.isBid ? f.quantity : -f.quantity;
    if (p.size === 0n || p.size > 0n === d > 0n) {
      const a = p.size < 0n ? -p.size : p.size;
      p.entry = (p.entry * a + f.price * f.quantity) / (a + f.quantity);
      p.size += d;
    } else {
      const sign = p.size > 0n ? 1n : -1n;
      roundTrips += 1;
      if (sign * (f.price - p.entry) > 0n) wins += 1;
      const a = p.size < 0n ? -p.size : p.size;
      p.size += d;
      if (p.size === 0n) p.entry = 0n;
      else if (f.quantity > a) p.entry = f.price;
    }
    book.set(f.market, p);
  }
  const end = venue.equity();
  const snap = await venue.snapshot(names);
  return {
    hours: ts.length > 1 ? ((ts.at(-1) ?? t0) - t0) / 3600 : 0,
    cycles,
    ...counts,
    blockedCodes,
    fills: venue.fills.length,
    roundTrips,
    wins,
    winRate: roundTrips === 0 ? 0 : wins / roundTrips,
    pnlUsd: usdNum(end - start - fees),
    feesUsd: usdNum(fees),
    maxDrawdownUsd: usdNum(maxDd),
    killSwitchTrips: trips,
    exits,
    sessions,
    sessionLossStops: lossStops,
    droppedNotMaker,
    ...(cooling === undefined ? {} : { cooldown: cooling.stats() }),
    endPositions: Object.fromEntries(
      Object.entries(snap.account.positions).map(([a, b]) => [a, b.toString()]),
    ),
  };
}
