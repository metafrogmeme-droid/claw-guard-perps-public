// A long live session: the band maker quotes for hours under a conservative policy, and on a fixed interval a
// scripted agent sends one intent that the rules must stop (blocked) or hold for the owner (needs your OK; in an
// unattended run nobody answers, so it is not sent). The session ends with a close-out through the kill switch
// (cancel every order, close every position reduce-only) and a re-arm once the account is confirmed flat. If it
// cannot confirm flat, the result says NOT flat (the CLI exits non-zero) and the kill switch stays on.
// It writes a status file every cycle, so a background run can be watched with `cat`.
//
// Time bounds (added after the 1 Nov run hung for 40 minutes on one read and missed its deadline):
//  - every venue call is bounded (callTimeoutSec for reads, twice that for writes);
//  - a watchdog timer, independent of the loop, stops the loop graceSec after the deadline even if the loop is
//    stuck on an await; an external AbortSignal (SIGTERM / SIGINT in the CLI) does the same at once;
//  - the close-out then cancels every order and closes every position reduce-only, each call bounded, inside
//    closeoutSec, and reports flat or NOT flat. It never throws, so the report is always written.
//
// RPC health gate (session rule 1, after both 2 Nov sessions ended on one timed-out read): a slow or failing
// read pauses quoting and re-reads with backoff instead of ending the session; it ends only after a bounded
// outage (see src/runtime/rpc-gate.ts and docs/SESSION_RULES.md).
import { writeFile } from 'node:fs/promises';

import type { LocalAccount } from 'viem';

import { Engine, type Approver } from '../engine/engine.js';
import { misbehavingScript } from '../engine/misbehave.js';
import { bandMaker, type BandMakerConfig } from '../engine/strategy.js';
import {
  DEFAULT_PROFIT_RULES,
  makerOnly,
  sessionLossStop,
  skewProfitFields,
  type ProfitRules,
  type SkewShape,
} from '../engine/profit-rules.js';
import {
  DEFAULT_COOLDOWN,
  LossCooldown,
  TradeTracker,
  vanishedOrders,
  type CooldownConfig,
  type CooldownStats,
} from '../engine/cooldown.js';
import { DEFAULT_SKEW, SkewState, skewMaker, type SkewMakerConfig } from '../engine/skew-maker.js';
import { utcDay } from '../gate/gate.js';
import { policyHash, type Policy } from '../gate/policy.js';
import { formatDecimal } from '../gate/units.js';
import { Journal } from '../receipts/journal.js';
import { verifyChain, type VerifyResult } from '../receipts/receipt.js';
import {
  closeOut,
  DEFAULT_FLATTEN_RETRY,
  type CloseOutResult,
  type FlattenRetryConfig,
} from '../runtime/closeout.js';
import { isInfraError, RpcHealthGate, type RpcGateConfig, type RpcGateStats } from '../runtime/rpc-gate.js';
import { deadlineWatchdog } from '../runtime/watchdog.js';
import { StopRequestedError, stopReasonOf, timedVenue, withTimeout } from '../runtime/timeout.js';
import type { Venue } from '../venue/types.js';

export interface SessionOptions {
  readonly venue: Venue;
  readonly policy: Policy;
  readonly journalPath: string;
  readonly statusPath: string;
  readonly signer: LocalAccount;
  readonly now: () => number;
  readonly wait: (sec: number) => Promise<void>;
  readonly log: (line: string) => void;
  readonly approve: Approver;
  readonly seconds: number;
  readonly cycleSec: number;
  /** Every this many cycles the scripted agent sends one intent the rules should stop. 0 = never. */
  readonly probeEvery: number;
  readonly quoteNotional: bigint;
  readonly bandBps: number;
  /** Quoting strategy. 'band' (default) is the original band maker; 'skew' is the post-only inventory-skew maker. */
  readonly strategy?: 'band' | 'skew';
  /** Overrides for the skew maker (bps and seconds); ignored for 'band'. */
  readonly skew?: Partial<SkewShape>;
  /** Session rule 2: edge floor, take-profit, maker-only filter, session loss stop. Defaults apply when omitted. */
  readonly profit?: ProfitRules;
  /** Session rule 3: loss-streak cooldown. Defaults apply when omitted. */
  readonly cooldown?: CooldownConfig;
  /** Stop early when the sender's gas falls under this (raw STT). */
  readonly minGas: bigint;
  readonly gasBalance?: () => Promise<bigint>;
  /** Stops the loop and runs the close-out when aborted (the CLI wires SIGTERM / SIGINT here). */
  readonly signal?: AbortSignal;
  /** Bound for one venue read, in seconds; writes get twice this. Default 30. */
  readonly callTimeoutSec?: number;
  /** Outer bound for one venue read, seconds (default callTimeoutSec). Live runs set it above the venue's own retries. */
  readonly readTimeoutSec?: number;
  /** The watchdog stops the loop this long after the deadline if it is still running. Default 60. */
  readonly graceSec?: number;
  /**
   * The watchdog stops the loop (normal close-out) when it made no progress for this long, wall-clock seconds.
   * Never below 3 cycles or 3 RPC backoffs. Default 900. 0 = off.
   */
  readonly stallSec?: number;
  /** Watchdog tick, ms. Default 5000. */
  readonly watchdogTickMs?: number;
  /** Process clock in ms (performance.now in live runs); lets the watchdog report wall-clock jumps. */
  readonly monoMs?: () => number;
  /** Total budget for the close-out, in seconds. Default 180. */
  readonly closeoutSec?: number;
  /** Close-out attempts inside the budget. Default 3. */
  readonly closeoutAttempts?: number;
  /** Pause between close-out attempts, in seconds. Default 0. */
  readonly closeoutPauseSec?: number;
  /** Session rule 4: close-out retry phase after the first budget. Defaults: DEFAULT_FLATTEN_RETRY. */
  readonly flatten?: FlattenRetryConfig;
  /** Session rule 1: RPC health gate (pause on slow / failing reads). Defaults: DEFAULT_RPC_GATE. */
  readonly rpcGate?: RpcGateConfig;
  /** Wall clock in ms, used to time reads for the RPC health gate. Default Date.now. */
  readonly clockMs?: () => number;
}

export type SessionCloseOut = Omit<CloseOutResult, 'snapshot'>;

export interface SessionCounts {
  allowed: number;
  blocked: number;
  needsOk: number;
  ownerYes: number;
  sent: number;
  venueOk: number;
  cancels: number;
}

export interface SessionResult {
  readonly startedAt: number;
  readonly endedAt: number;
  readonly cycles: number;
  readonly stopReason: string;
  readonly counts: SessionCounts;
  readonly blockedCodes: Readonly<Record<string, number>>;
  readonly startEquity: bigint;
  readonly endEquity: bigint;
  readonly pnl: bigint;
  readonly flat: boolean;
  readonly txHashes: readonly `0x${string}`[];
  readonly check: VerifyResult;
  readonly closeOut: SessionCloseOut;
  /** True when the loop was stopped by the watchdog (past the deadline, or stalled). */
  readonly watchdogFired: boolean;
  /** Why the watchdog fired ('deadline watchdog' or 'loop stalled: ...'), when it did. */
  readonly watchdogReason?: string;
  /** Wall-clock jumps the watchdog saw (the box was paused): count and the largest, seconds. */
  readonly clockJumps: { readonly count: number; readonly maxSec: number };
  /** Session rule 2 counters: openings skipped for edge, intents dropped as not maker, loss stop hit. */
  readonly profit: { readonly noEdge: number; readonly droppedNotMaker: number; readonly lossStop: boolean };
  /** RPC health gate: pauses and outage seconds in this session. */
  readonly rpc: RpcGateStats;
  /** Session rule 3 counters (trades are estimates from snapshots). */
  readonly cooldown: CooldownStats;
}

export async function runSession(o: SessionOptions): Promise<SessionResult> {
  const callMs = (o.callTimeoutSec ?? 30) * 1000;
  // reads retry inside the venue (3 x 20 s + backoff, rotating RPCs), so the outer read bound must cover that
  const venue = timedVenue(o.venue, {
    readMs: (o.readTimeoutSec ?? o.callTimeoutSec ?? 30) * 1000,
    writeMs: callMs * 2,
  });
  // one engine step is a few venue calls (snapshot + sizing + place); bound it as a whole too
  const stepMs = callMs * 4;
  const journal = await Journal.open(o.journalPath, o.signer, policyHash(o.policy));
  const engine = new Engine({ venue, policy: o.policy, journal, now: o.now, approve: o.approve });
  const gate = new RpcHealthGate(o.rpcGate);
  const clockMs = o.clockMs ?? Date.now;
  // do not start while the RPC is failing: re-read with backoff inside the outage budget, then refuse
  const firstRead = async (): Promise<Awaited<ReturnType<Engine['snapshot']>>> => {
    const t0 = o.now();
    for (let n = 1; ; n += 1) {
      try {
        return await engine.snapshot();
      } catch (e) {
        if (!isInfraError(e) || o.signal?.aborted === true) throw e;
        const waited = o.now() - t0;
        const msg = e instanceof Error ? e.message : String(e);
        if (!gate.startBudgetLeft(waited)) {
          throw new Error(
            `RPC not healthy at start (${String(n)} reads, ${String(waited)} s): ${msg}; not starting`,
            { cause: e },
          );
        }
        const w = gate.startBackoff(n);
        o.log(`[rpc] start read ${String(n)} failed (${msg}); retrying in ${String(w)} s`);
        await o.wait(w);
      }
    }
  };
  const s0 = await firstRead();
  if (Object.keys(s0.account.positions).length > 0 || s0.orders.length > 0) {
    throw new Error('account is not flat; run `kill` first');
  }
  const startedAt = o.now();
  const deadline = startedAt + o.seconds;
  const counts: SessionCounts = {
    allowed: 0,
    blocked: 0,
    needsOk: 0,
    ownerYes: 0,
    sent: 0,
    venueOk: 0,
    cancels: 0,
  };
  const blockedCodes: Record<string, number> = {};
  const tally = (r: Awaited<ReturnType<Engine['submit']>>): void => {
    const d = r.decision;
    if (d.verdict === 'allowed') counts.allowed += 1;
    if (d.verdict === 'blocked') {
      counts.blocked += 1;
      for (const c of d.codes) blockedCodes[c] = (blockedCodes[c] ?? 0) + 1;
    }
    if (d.verdict === 'needs_ok') {
      counts.needsOk += 1;
      if (r.approved) counts.ownerYes += 1;
    }
    if (r.execution !== undefined) {
      counts.sent += 1;
      if (r.execution.result.ok) counts.venueOk += 1;
    }
  };
  const cfg: BandMakerConfig = {
    markets: o.policy.markets,
    bandBps: o.bandBps,
    requoteBps: o.bandBps * 2,
    quoteNotional: o.quoteNotional,
    agent: 'band-maker',
  };
  const profit = o.profit ?? DEFAULT_PROFIT_RULES;
  const rule2 = { noEdge: 0, droppedNotMaker: 0, lossStop: false };
  const trades = new TradeTracker(profit.makerFeeBps);
  const cooling = new LossCooldown(o.cooldown ?? DEFAULT_COOLDOWN);
  // our tracked orders at the end of the last cycle; the ones gone by the next snapshot were (most likely) filled
  let lastTracked = new Map(engine.tracked);
  const skewCfg: SkewMakerConfig = {
    ...DEFAULT_SKEW,
    ...o.skew,
    ...skewProfitFields(profit),
    markets: o.policy.markets,
    quoteNotional: o.quoteNotional,
    // keep inventory inside the guard's position cap with room for one more quote
    maxInventoryNotional: o.policy.maxPositionNotionalUsd - o.quoteNotional,
    agent: 'skew-maker',
  };
  const skewState = new SkewState();
  let cycles = 0;
  let stopReason = 'time is up';
  let equity = s0.account.equity;
  const status = async (state: string, extra: Record<string, unknown> = {}): Promise<void> => {
    await writeFile(
      o.statusPath,
      `${JSON.stringify(
        {
          state,
          cycles,
          startedAt,
          deadline,
          now: o.now(),
          counts,
          blockedCodes,
          startEquity: formatDecimal(s0.account.equity, 18),
          equity: formatDecimal(equity, 18),
          receipts: journal.receipts.length,
          ...extra,
        },
        null,
        2,
      )}\n`,
    );
  };

  // stop control: external signal or the deadline watchdog abort `stop`; every loop await is bounded by it
  const stop = new AbortController();
  const requestStop = (why: string): void => {
    if (!stop.signal.aborted) stop.abort(why);
  };
  const ext = o.signal;
  const onExt = (): void => {
    requestStop(`signal: ${ext === undefined ? 'stop' : stopReasonOf(ext)}`);
  };
  if (ext?.aborted === true) onExt();
  ext?.addEventListener('abort', onExt, { once: true });
  const graceSec = o.graceSec ?? 60;
  const gateCfg = gate.cfg;
  const stallSec =
    (o.stallSec ?? 900) <= 0
      ? 0
      : Math.max(o.stallSec ?? 900, 3 * o.cycleSec, 3 * gateCfg.backoffMaxSec, (3 * stepMs) / 1000);
  const dog = deadlineWatchdog({
    deadline,
    graceSec,
    now: o.now,
    stallSec,
    ...(o.watchdogTickMs === undefined ? {} : { tickMs: o.watchdogTickMs }),
    ...(o.monoMs === undefined ? {} : { monoMs: o.monoMs }),
    onFire: (why) => {
      o.log(
        why === 'deadline watchdog'
          ? `[watchdog] loop still running ${String(graceSec)}s after the deadline; stopping it`
          : `[watchdog] ${why}; stopping it`,
      );
      requestStop(why);
    },
    onClockJump: (sec) => {
      o.log(`[watchdog] wall clock jumped ${String(sec)} s ahead of the process clock (box paused?)`);
    },
  });
  let inflight: Promise<unknown> = Promise.resolve();
  const bounded = <T>(p: Promise<T>, label: string, ms = stepMs): Promise<T> => {
    inflight = p.catch(() => undefined);
    return withTimeout(p, ms, label, stop.signal).finally(() => {
      dog.progress();
    });
  };

  o.log(
    `[session] start equity ${formatDecimal(s0.account.equity, 18)} USDso, until ${new Date(deadline * 1000).toISOString()}`,
  );

  // one trading cycle; returns a stop reason to end the session, or undefined to go on
  const cycle = async (): Promise<string | undefined> => {
    // read phase: every read is timed; a slow read pauses quoting like a failed one
    cycles += 1;
    let slowest = 0;
    const timedRead = async <T>(p: () => Promise<T>, label: string, ms?: number): Promise<T> => {
      const t = clockMs();
      const v = await bounded(p(), label, ms);
      slowest = Math.max(slowest, (clockMs() - t) / 1000);
      return v;
    };
    const gas = o.gasBalance;
    if (gas !== undefined && (await timedRead(gas, 'gas balance', callMs)) < o.minGas) {
      return 'gas under the floor';
    }
    if (await timedRead(() => engine.watch(), 'kill switch check')) {
      return `kill switch: ${engine.killSwitch.reason ?? ''}`;
    }
    const s = await timedRead(() => engine.snapshot(), 'snapshot');
    equity = s.account.equity;
    const g = gate.onRead(slowest, o.now());
    if (g.action === 'end') return g.why;
    if (g.action === 'pause') {
      await pause(g.waitSec, g.why, g.started);
      return undefined;
    }
    const lossStop = sessionLossStop(s0.account.equity, equity, profit);
    if (lossStop !== undefined) {
      rule2.lossStop = true;
      return lossStop;
    }
    const closed = trades.observe(
      s.account.positions,
      s.markets,
      vanishedOrders(lastTracked, engine.tracked),
      o.now(),
    );
    for (const t of closed)
      o.log(`[trade] ${t.market} ${t.side} closed, est. pnl ${formatDecimal(t.pnl, 18)} USDso`);
    const cool = cooling.record(closed, o.now());
    if (cool !== undefined) {
      o.log(`[cooldown] ${cool}`);
      for (const c of cooling.openingOrders([...engine.tracked.values()], s.account.positions)) {
        await bounded(engine.cancel(c, 'cooldown'), 'cooldown cancel');
        counts.cancels += 1;
      }
    }
    const used = engine.memory.day === utcDay(o.now()) ? engine.memory.dailyNotional : 0n;
    const budgetLeft = o.policy.maxDailyNotionalUsd > used ? o.policy.maxDailyNotionalUsd - used : 0n;
    const step =
      o.strategy === 'skew'
        ? skewMaker(
            skewCfg,
            skewState,
            s.markets,
            s.account.positions,
            [...engine.tracked.values()],
            o.now(),
            budgetLeft,
          )
        : bandMaker(cfg, s.markets, [...engine.tracked.values()]);
    if ('exits' in step) for (const e of step.exits as readonly string[]) o.log(`[exit] ${e}`);
    if ('noEdge' in step) {
      const skipped = step.noEdge as readonly string[];
      rule2.noEdge += skipped.length;
      for (const e of skipped) o.log(`[no edge] ${e}`);
    }
    const { kept, dropped } = makerOnly(cooling.filter(step.intents, s.account.positions, o.now()), profit);
    rule2.droppedNotMaker += dropped.length;
    for (const d of dropped) o.log(`[maker only] dropped ${d.market} ${d.side} ${d.orderType}`);
    for (const c of step.cancels) {
      await bounded(engine.cancel(c, 'requote'), 'requote cancel');
      counts.cancels += 1;
    }
    for (const it of kept) tally(await bounded(engine.submit(it), 'quote'));
    if (o.probeEvery > 0 && cycles % o.probeEvery === 0) {
      const first = o.policy.markets[0];
      const m = first === undefined ? undefined : s.markets[first];
      if (m !== undefined) {
        const probes = misbehavingScript(m, o.quoteNotional).filter((p) => p.expect !== 'allowed');
        const p = probes[(cycles / o.probeEvery - 1) % probes.length];
        if (p !== undefined) {
          const r = await bounded(engine.submit(p.intent), 'probe');
          tally(r);
          o.log(
            `[probe] ${p.label}: ${r.decision.message}${r.decision.verdict === 'needs_ok' ? (r.approved ? ' (owner said yes)' : ' (no owner answer, not sent)') : ''}`,
          );
        }
      }
    }
    lastTracked = new Map(engine.tracked);
    if (cycles % 10 === 1) {
      o.log(
        `[session] cycle ${String(cycles)}: allowed ${String(counts.allowed)}, blocked ${String(counts.blocked)}, needs your OK ${String(counts.needsOk)}, equity ${formatDecimal(equity, 18)}`,
      );
    }
    await status(cooling.active(o.now()) ? 'running (cooldown: reduce only)' : 'running');
    await sessionWait(o.cycleSec);
    return undefined;
  };
  const sessionWait = async (sec: number): Promise<void> => {
    const left = Math.max(0, deadline - o.now());
    await withTimeout(o.wait(Math.min(sec, left)), 0, 'wait', stop.signal);
    dog.progress();
  };
  // paused: no quoting; pull resting quotes once (best effort, they only remove risk), then wait and re-read
  const pause = async (waitSec: number, why: string, started: boolean): Promise<void> => {
    if (started) {
      o.log(`[rpc] pausing quotes: ${why}`);
      if (gate.cfg.cancelOnPause) {
        for (const t of [...engine.tracked.values()]) {
          try {
            if (
              (await bounded(engine.cancel(t, 'rpc pause'), 'pause cancel', callMs * 2)).data['ok'] === true
            ) {
              counts.cancels += 1;
            }
          } catch (e) {
            if (e instanceof StopRequestedError) throw e;
          }
        }
      }
    }
    // orders we pulled for the pause are not fills; do not count them as trades on the next cycle
    lastTracked = new Map(engine.tracked);
    o.log(`[rpc] paused (${why}); re-reading in ${String(waitSec)} s`);
    await status('paused: RPC', { rpc: gate.stats(o.now()), why });
    await sessionWait(waitSec);
  };

  let ended = false;
  try {
    while (o.now() < deadline && !stop.signal.aborted) {
      try {
        const why = await cycle();
        if (why !== undefined) {
          stopReason = why;
          ended = true;
          break;
        }
      } catch (e) {
        if (e instanceof StopRequestedError) throw e;
        const g = gate.onError(e, o.now());
        if (g.action !== 'pause') {
          stopReason = g.action === 'end' ? g.why : stopReason;
          ended = true;
          break;
        }
        await pause(g.waitSec, g.why, g.started);
      }
    }
    if (!ended && stop.signal.aborted) stopReason = stopReasonOf(stop.signal);
  } catch (e) {
    stopReason =
      e instanceof StopRequestedError ? e.reason : `error: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    dog.cancel();
    ext?.removeEventListener('abort', onExt);
  }

  // close out: let a call already on the wire settle (bounded), then flatten and confirm flat
  o.log(`[session] ending (${stopReason}); flattening`);
  await status('closing out', { stopReason });
  const closeoutMs = (o.closeoutSec ?? 180) * 1000;
  const settleMs = Math.min(callMs * 2, 15_000, closeoutMs / 4);
  await withTimeout(inflight, settleMs, 'in-flight call').catch(() => undefined);
  const co = await closeOut(engine, {
    reason: `end of session: ${stopReason}`,
    budgetMs: closeoutMs,
    stepMs,
    attempts: o.closeoutAttempts ?? 3,
    pauseMs: (o.closeoutPauseSec ?? 0) * 1000,
    // only a real guard trip keeps the kill switch; an RPC error or the deadline must not stop on chain
    stop: engine.killSwitch.tripped,
    log: o.log,
    retry: o.flatten ?? DEFAULT_FLATTEN_RETRY,
  });
  const flat = co.flat;
  if (flat && engine.killSwitch.tripped) {
    // re-arm only once flat; a NOT flat account keeps the kill switch on
    try {
      await withTimeout(engine.rearm(), stepMs, 'rearm');
    } catch (e) {
      o.log(`[session] re-arm failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const endEquity = co.snapshot?.account.equity ?? equity;
  const txHashes = journal.receipts
    .filter((r) => r.kind === 'execution')
    .map((r) => r.data['txHash'])
    .filter((h): h is `0x${string}` => typeof h === 'string');
  const check = await verifyChain(journal.receipts, o.signer.address);
  equity = endEquity;
  const closeOutReport: SessionCloseOut = {
    flat: co.flat,
    attempts: co.attempts,
    passes: co.passes,
    openOrders: co.openOrders,
    positions: co.positions,
    errors: co.errors,
    retries: co.retries,
  };
  await status(flat ? 'done, flat' : 'done, NOT flat: run `pnpm cli kill`', {
    stopReason,
    closeOut: {
      ...closeOutReport,
      positions: Object.fromEntries(Object.entries(co.positions).map(([k, v]) => [k, v.toString()])),
    },
  });
  o.log(
    `[session] done: ${String(cycles)} cycles, ${flat ? 'flat' : 'NOT flat'}, pnl ${formatDecimal(endEquity - s0.account.equity, 18)} USDso, ${String(check.count)} receipts`,
  );
  if (!flat)
    o.log(
      `[session] close-out did not confirm flat: ${co.errors.join('; ') || 'orders or positions remain'}`,
    );
  return {
    startedAt,
    endedAt: o.now(),
    cycles,
    stopReason,
    counts,
    blockedCodes,
    startEquity: s0.account.equity,
    endEquity,
    pnl: endEquity - s0.account.equity,
    flat,
    txHashes,
    check,
    closeOut: closeOutReport,
    profit: rule2,
    cooldown: cooling.stats(),
    watchdogFired: dog.fired,
    ...(dog.reason === undefined ? {} : { watchdogReason: dog.reason }),
    clockJumps: dog.jumps,
    rpc: gate.stats(o.now()),
  };
}
