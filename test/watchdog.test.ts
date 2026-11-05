// Time bounds, deadline watchdog and guaranteed close-out for the session runner (all offline, sim venue).
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { runSession, type SessionOptions } from '../src/cli/session.js';
import { Engine } from '../src/engine/engine.js';
import { parsePolicy, policyHash, SESSION_POLICY } from '../src/gate/policy.js';
import type { OrderIntent } from '../src/gate/types.js';
import { usd } from '../src/gate/units.js';
import { Journal } from '../src/receipts/journal.js';
import { closeOut, parseFlattenRetry } from '../src/runtime/closeout.js';
import { parseRpcGate } from '../src/runtime/rpc-gate.js';
import {
  CallTimeoutError,
  sleep,
  StopRequestedError,
  stopReasonOf,
  timedVenue,
  withTimeout,
} from '../src/runtime/timeout.js';
import {
  BACKSTOP_WORKER_SOURCE,
  deadlineWatchdog,
  hardBackstop,
  softWatchdog,
} from '../src/runtime/watchdog.js';
import { SimVenue, simMarkets } from '../src/venue/index.js';
import type { Venue, VenueSnapshot } from '../src/venue/types.js';
import { NOW } from './fixtures.js';

// anvil test key 0 (public, allowlisted in .gitleaks.toml)
const signer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const policy = parsePolicy(SESSION_POLICY);
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

/** A venue that hangs (never settles) on chosen calls, like a read on a half-open socket. */
class HangingVenue implements Venue {
  readonly mode = 'sim' as const;
  readonly account: `0x${string}`;
  readonly sender: `0x${string}`;
  snapshots = 0;
  constructor(
    readonly inner: SimVenue,
    readonly o: {
      hangSnapshotAt?: number;
      cancelFails?: boolean;
      snapshotThrowsFrom?: number;
      /** Runs when the hanging snapshot starts (e.g. move the wall clock, like a paused box). */
      onHang?: () => void;
    } = {},
  ) {
    this.account = inner.account;
    this.sender = inner.sender;
  }
  snapshot(names: readonly string[]): Promise<VenueSnapshot> {
    this.snapshots += 1;
    if (this.snapshots === this.o.hangSnapshotAt) {
      this.o.onHang?.();
      return never();
    }
    if (this.o.snapshotThrowsFrom !== undefined && this.snapshots >= this.o.snapshotThrowsFrom) {
      return Promise.reject(new Error('rpc down'));
    }
    return this.inner.snapshot(names);
  }
  sizing: Venue['sizing'] = (m, i) => this.inner.sizing(m, i);
  place: Venue['place'] = (m, i) => this.inner.place(m, i);
  cancel: Venue['cancel'] = (m, o) =>
    this.o.cancelFails === true ? Promise.resolve({ ok: false, error: 'reverted' }) : this.inner.cancel(m, o);
  close = (): Promise<void> => Promise.resolve();
}

function sim(): { venue: SimVenue; clock: { t: number } } {
  const clock = { t: NOW };
  return {
    venue: new SimVenue(simMarkets(NOW), { collateral: usd('40'), now: () => clock.t, seed: 7 }),
    clock,
  };
}

async function session(venue: Venue, simv: SimVenue, clock: { t: number }, extra: Partial<SessionOptions>) {
  const dir = await mkdtemp(join(tmpdir(), 'cgp-wd-'));
  const lines: string[] = [];
  const r = await runSession({
    venue,
    policy,
    journalPath: join(dir, 's.jsonl'),
    statusPath: join(dir, 'status.json'),
    signer,
    now: () => clock.t,
    wait: (sec) => {
      clock.t += sec;
      simv.step(sec);
      return Promise.resolve();
    },
    log: (l) => lines.push(l),
    approve: () => Promise.resolve(false),
    seconds: 600,
    cycleSec: 60,
    probeEvery: 0,
    quoteNotional: usd('10.5'),
    bandBps: 40,
    minGas: 0n,
    ...extra,
  });
  const status = JSON.parse(await readFile(join(dir, 'status.json'), 'utf8')) as {
    state: string;
    stopReason?: string;
    closeOut?: { flat: boolean };
  };
  const journal = (await readFile(join(dir, 's.jsonl'), 'utf8').catch(() => ''))
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { kind: string; data: Record<string, unknown> });
  return { r, lines, status, journal };
}

/** Leaves one resting post-only bid and one long position on the sim account. */
async function messUp(v: SimVenue): Promise<void> {
  const m = v.market('BTC-PERP');
  const base: OrderIntent = {
    market: 'BTC-PERP',
    side: 'long',
    orderType: 'post_only',
    price: m.markPrice - m.tickSize * 100n,
    quantity: 14_000n,
    reduceOnly: false,
    agent: 't',
    reason: 't',
  };
  await v.place(m, base);
  await v.place(m, { ...base, orderType: 'ioc', price: m.markPrice + m.tickSize * 100n });
}

describe('withTimeout / sleep', () => {
  it('rejects a call that never settles with CallTimeoutError', async () => {
    const e = await withTimeout(never(), 20, 'venue snapshot').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CallTimeoutError);
    expect((e as CallTimeoutError).message).toBe('venue snapshot timed out after 0.02s');
  });

  it('passes values and errors through, wraps non-Error rejections, and 0 means no bound', async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, 'x')).resolves.toBe(7);
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'x')).rejects.toThrow('boom');
    const plain = new Promise<never>((_res, rej: (x: unknown) => void) => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- testing a non-Error rejection
      rej('plain');
    });
    await expect(withTimeout(plain, 1000, 'x')).rejects.toThrow('plain');
    const late = new Promise<number>((r) => {
      setTimeout(() => {
        r(1);
      }, 30);
    });
    await expect(withTimeout(late, 0, 'x')).resolves.toBe(1);
  });

  it('rejects at once with StopRequestedError when the stop signal aborts (before or during)', async () => {
    const pre = new AbortController();
    pre.abort('SIGTERM');
    await expect(withTimeout(never(), 0, 'x', pre.signal)).rejects.toBeInstanceOf(StopRequestedError);
    const c = new AbortController();
    const p = withTimeout(never(), 0, 'x', c.signal);
    c.abort(new Error('deadline watchdog'));
    await expect(p).rejects.toThrow('stop requested: deadline watchdog');
    const odd = new AbortController();
    odd.abort(42);
    expect(stopReasonOf(odd.signal)).toBe('aborted');
  });

  it('sleep ends early on abort and returns at once for 0', async () => {
    const c = new AbortController();
    const t0 = Date.now();
    const p = sleep(10_000, c.signal);
    c.abort('stop');
    await p;
    expect(Date.now() - t0).toBeLessThan(1000);
    await sleep(0);
    await sleep(5, c.signal);
    await sleep(5);
  });
});

describe('timedVenue', () => {
  it('bounds reads (reject) and writes (ok: false, may still land)', async () => {
    const { venue } = sim();
    const m = venue.market('BTC-PERP');
    const hung: Venue = {
      mode: 'sim',
      account: venue.account,
      sender: venue.sender,
      snapshot: () => never(),
      sizing: () => never(),
      place: () => never(),
      cancel: () => never(),
      bookTop: () => never(),
      close: () => never(),
    };
    const t = timedVenue(hung, { readMs: 10, writeMs: 10 });
    await expect(t.snapshot(['BTC-PERP'])).rejects.toBeInstanceOf(CallTimeoutError);
    const intent: OrderIntent = {
      market: 'BTC-PERP',
      side: 'long',
      orderType: 'post_only',
      price: m.markPrice,
      quantity: 14_000n,
      reduceOnly: false,
      agent: 't',
      reason: 't',
    };
    await expect(t.sizing(m, intent)).rejects.toThrow(/sizing timed out/);
    await expect(t.bookTop?.(m)).rejects.toThrow(/book top timed out/);
    const p = await t.place(m, intent);
    expect(p).toMatchObject({ ok: false, filled: 0n });
    expect(p.error).toMatch(/place timed out after 0.01s; it may still land/);
    const c = await t.cancel(m, { market: 'BTC-PERP', orderId: 1n });
    expect(c.ok).toBe(false);
    expect(c.error).toMatch(/cancel timed out/);
    await expect(t.close()).resolves.toBeUndefined();
    // a write that fails for another reason is not turned into a timeout
    const bad = timedVenue(
      { ...hung, place: () => Promise.reject(new Error('nonce')) },
      { readMs: 10, writeMs: 10 },
    );
    await expect(bad.place(m, intent)).rejects.toThrow('nonce');
    const noTop: Venue = {
      mode: 'sim',
      account: venue.account,
      sender: venue.sender,
      snapshot: () => never(),
      sizing: () => never(),
      place: () => never(),
      cancel: () => never(),
      close: () => never(),
    };
    expect('bookTop' in timedVenue(noTop)).toBe(false);
    expect('bookTop' in timedVenue(venue)).toBe(true);
  });
});

describe('session runner: hangs, deadline watchdog, signals', () => {
  it('a hung call times out: the RPC gate pauses, re-reads, resumes and the session runs to its end', async () => {
    const { venue, clock } = sim();
    const hv = new HangingVenue(venue, { hangSnapshotAt: 6 });
    const { r, status, lines } = await session(hv, venue, clock, { callTimeoutSec: 0.05 });
    expect(r.stopReason).toBe('time is up');
    expect(r.rpc.pauses).toBe(1);
    expect(r.flat).toBe(true);
    expect(status.state).toBe('done, flat');
    expect(lines.some((l) => l.startsWith('[rpc] pausing quotes: venue snapshot timed out'))).toBe(true);
  });

  it('with the RPC gate off, a hung call ends the session and the close-out leaves the account flat', async () => {
    const { venue, clock } = sim();
    // snapshot 1 = start check, 2-3 = cycle 1 (watch, snapshot) ... hang inside cycle 2
    const hv = new HangingVenue(venue, { hangSnapshotAt: 6 });
    const { r, status, lines } = await session(hv, venue, clock, {
      callTimeoutSec: 0.05,
      rpcGate: parseRpcGate({ enabled: false }),
    });
    expect(r.stopReason).toMatch(/^error: venue snapshot timed out after 0.05s/);
    expect(r.flat).toBe(true);
    expect(r.closeOut.flat).toBe(true);
    expect(r.watchdogFired).toBe(false);
    expect(status.state).toBe('done, flat');
    expect(lines.some((l) => l.includes('ending (error: venue snapshot timed out'))).toBe(true);
    expect((await venue.snapshot(policy.markets)).orders).toHaveLength(0);
  });

  it('the deadline watchdog stops a loop that is blocked on a call with no usable timeout', async () => {
    const { venue, clock } = sim();
    const hv = new HangingVenue(venue, { hangSnapshotAt: 3 });
    const t0 = Date.now();
    const { r, lines, status } = await session(hv, venue, clock, {
      seconds: 0.2,
      graceSec: 0.1,
      callTimeoutSec: 1000, // the per-call bound would only fire after ~67 min
      closeoutSec: 2,
      cycleSec: 60,
    });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.watchdogFired).toBe(true);
    expect(r.stopReason).toBe('deadline watchdog');
    expect(lines.some((l) => l.startsWith('[watchdog] loop still running'))).toBe(true);
    expect(r.flat).toBe(true);
    expect(status.stopReason).toBe('deadline watchdog');
  });

  it('SIGTERM (the stop signal) during a wait runs the close-out at once', async () => {
    const { venue, clock } = sim();
    const ctl = new AbortController();
    const { r } = await session(venue, venue, clock, {
      signal: ctl.signal,
      wait: () => {
        ctl.abort('SIGTERM');
        return never();
      },
    });
    expect(r.cycles).toBe(1);
    expect(r.stopReason).toBe('signal: SIGTERM');
    expect(r.flat).toBe(true);
    expect((await venue.snapshot(policy.markets)).orders).toHaveLength(0);
  });

  it('a signal already raised before the start stops before the first cycle', async () => {
    const { venue, clock } = sim();
    const ctl = new AbortController();
    ctl.abort('SIGINT');
    const { r } = await session(venue, venue, clock, { signal: ctl.signal });
    expect(r.cycles).toBe(0);
    expect(r.stopReason).toBe('signal: SIGINT');
    expect(r.flat).toBe(true);
  });

  it('a close-out that cannot cancel reports NOT flat without an on-chain stop receipt', async () => {
    const { venue, clock } = sim();
    const hv = new HangingVenue(venue, { cancelFails: true });
    const { r, status, lines, journal } = await session(hv, venue, clock, {
      seconds: 60,
      flatten: parseFlattenRetry({ retryBudgetSec: 0.2, backoffBaseSec: 0.01, backoffMaxSec: 0.02 }),
    });
    expect(r.closeOut.retries).toBeGreaterThan(0);
    expect(r.flat).toBe(false);
    expect(r.closeOut.flat).toBe(false);
    expect(r.closeOut.attempts).toBe(3);
    expect(r.closeOut.openOrders).toBeGreaterThan(0);
    expect(status.state).toBe('done, NOT flat: run `pnpm cli kill`');
    expect(status.closeOut?.flat).toBe(false);
    expect(lines.some((l) => l.includes('close-out did not confirm flat'))).toBe(true);
    // an infra close-out journals session_aborted (non-stopping), never a kill_switch trip
    expect(journal.filter((x) => x.kind === 'kill_switch')).toHaveLength(0);
    expect(journal.some((x) => x.kind === 'session_aborted' && x.data['action'] === 'abort')).toBe(true);
  });
});

describe('closeOut', () => {
  async function engineOn(v: Venue) {
    const dir = await mkdtemp(join(tmpdir(), 'cgp-co-'));
    const journal = await Journal.open(join(dir, 'j.jsonl'), signer, policyHash(policy));
    return { engine: new Engine({ venue: v, policy, journal, now: () => NOW }), journal };
  }
  const opts = { reason: 'test', budgetMs: 5000, stepMs: 1000, attempts: 3 };

  it('cancels every order, closes the position reduce-only, and is idempotent', async () => {
    const { venue } = sim();
    await messUp(venue);
    const before = await venue.snapshot(policy.markets);
    expect(before.orders.length).toBe(1);
    expect(Object.keys(before.account.positions)).toEqual(['BTC-PERP']);
    const { engine, journal } = await engineOn(venue);
    const lines: string[] = [];
    const a = await closeOut(engine, { ...opts, log: (l) => lines.push(l) });
    expect(a).toMatchObject({ flat: true, passes: 1, openOrders: 0, errors: [] });
    expect(a.positions).toEqual({});
    expect(lines[0]).toMatch(/1 open orders, 1 positions; cancelling and closing reduce-only/);
    const receipts = journal.receipts.length;
    expect(journal.receipts.some((x) => JSON.stringify(x.data).includes('"reduceOnly":true'))).toBe(true);
    // second run: already flat, nothing sent, nothing journaled
    const b = await closeOut(engine, opts);
    expect(b).toMatchObject({ flat: true, passes: 0, attempts: 1, errors: [] });
    expect(journal.receipts.length).toBe(receipts);
  });

  it('reports a failure when the account cannot be read (never throws)', async () => {
    const { venue } = sim();
    await messUp(venue);
    const { engine } = await engineOn(new HangingVenue(venue, { snapshotThrowsFrom: 1 }));
    const r = await closeOut(engine, { ...opts, pauseMs: 1, backoffMs: 1 });
    expect(r.flat).toBe(false);
    expect(r.openOrders).toBe(-1);
    expect(r.errors).toContain('could not read the account to confirm it is flat');
    expect(r.errors[0]).toBe('attempt 1: rpc down');
  });

  it('bounds a hung flatten and still reports', async () => {
    const { venue } = sim();
    await messUp(venue);
    const hv = new HangingVenue(venue, { hangSnapshotAt: 2 }); // snapshot inside the flatten hangs
    const { engine } = await engineOn(timedVenue(hv, { readMs: 5000, writeMs: 5000 }));
    const r = await closeOut(engine, { ...opts, stepMs: 30 });
    expect(r.errors[0]).toBe('attempt 1: close-out flatten timed out after 0.03s');
    expect(r.flat).toBe(true); // the next attempt flattened it
  });
});

// 4 Nov evening: the box was paused from ~21:03 to ~22:18 CET. Node timers run on the process clock, which
// stood still, so the one-shot deadline timer (and the cycle wait) never came due while the wall clock ran
// 76 min past the deadline; only SIGTERM closed it out. These tests freeze the process side the same way (a wait
// or a read that never settles, a one-shot timer an hour away) and move only the wall clock.
describe('paused box: wall-clock deadline and stall watchdog (4 Nov evening hang)', () => {
  it('reproduces the hang: wall clock jumps 4545 s during the cycle-5 wait; the watchdog closes out flat', async () => {
    const { venue, clock } = sim();
    let waits = 0;
    const t0 = Date.now();
    const { r, lines, status, journal } = await session(venue, venue, clock, {
      seconds: 3600,
      cycleSec: 120,
      graceSec: 60,
      watchdogTickMs: 10,
      monoMs: () => performance.now(),
      wait: (sec) => {
        waits += 1;
        if (waits < 5) {
          clock.t += sec;
          venue.step(sec);
          return Promise.resolve();
        }
        clock.t += 4545; // box paused: wall clock runs, this process does not
        return never();
      },
    });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.cycles).toBe(5);
    expect(r.watchdogFired).toBe(true);
    expect(r.watchdogReason).toBe('deadline watchdog');
    expect(r.stopReason).toBe('deadline watchdog');
    expect(r.flat).toBe(true);
    expect(r.clockJumps.count).toBeGreaterThanOrEqual(1);
    expect(r.clockJumps.maxSec).toBeGreaterThanOrEqual(4000);
    expect(lines.some((l) => l.startsWith('[watchdog] wall clock jumped'))).toBe(true);
    expect(status.state).toBe('done, flat');
    expect(journal.some((x) => x.kind === 'session_aborted')).toBe(true);
    expect((await venue.snapshot(policy.markets)).orders).toHaveLength(0);
  });

  it('a read that never settles while the wall clock runs on ends as "loop stalled" before the deadline', async () => {
    const { venue, clock } = sim();
    // snapshot 1 = start check, the 6th read hangs (cycle 1 reads several times); move the wall clock 20000 s
    const hv = new HangingVenue(venue, {
      hangSnapshotAt: 6,
      onHang: () => {
        clock.t += 20_000;
      },
    });
    const { r, lines, status } = await session(hv, venue, clock, {
      seconds: 86_400,
      cycleSec: 120,
      callTimeoutSec: 1000, // stepMs 4000 s: effective stall floor 12000 s
      stallSec: 900,
      watchdogTickMs: 10,
      closeoutSec: 2,
    });
    expect(r.watchdogFired).toBe(true);
    expect(r.watchdogReason).toMatch(/^loop stalled: no progress for \d+ s$/);
    expect(r.stopReason).toBe(r.watchdogReason);
    expect(r.cycles).toBe(1);
    expect(r.flat).toBe(true);
    expect(r.clockJumps.count).toBe(0); // no process clock given: no jump check
    expect(lines.some((l) => l.startsWith('[watchdog] loop stalled'))).toBe(true);
    expect(status.stopReason).toBe(r.watchdogReason);
  });

  it('stallSec 0 turns the stall check off; a normal run is not stopped by it', async () => {
    const { venue, clock } = sim();
    const { r } = await session(venue, venue, clock, { stallSec: 0, watchdogTickMs: 10 });
    expect(r.stopReason).toBe('time is up');
    expect(r.watchdogFired).toBe(false);
    expect(r.watchdogReason).toBeUndefined();
    const { venue: v2, clock: c2 } = sim();
    const { r: r2 } = await session(v2, v2, c2, { stallSec: 1, watchdogTickMs: 10 });
    expect(r2.stopReason).toBe('time is up'); // floor of 3 cycles keeps normal waits inside the bound
  });
});

describe('deadlineWatchdog', () => {
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 40));

  it('fires on the wall clock past deadline + grace even when the one-shot timer is far away', async () => {
    let wall = 1_000;
    const why: string[] = [];
    const jumps: number[] = [];
    let mono = 0;
    const d = deadlineWatchdog({
      deadline: 1_000 + 3_600,
      graceSec: 60,
      now: () => wall,
      stallSec: 0,
      tickMs: 10,
      monoMs: () => mono,
      onFire: (w) => why.push(w),
      onClockJump: (s) => jumps.push(s),
    });
    await tick();
    expect(d.fired).toBe(false);
    wall += 4_545;
    mono += 5; // 5 ms of process time
    await tick();
    expect(d.fired).toBe(true);
    expect(d.reason).toBe('deadline watchdog');
    expect(why).toEqual(['deadline watchdog']);
    expect(jumps).toEqual([4545]);
    expect(d.jumps).toEqual({ count: 1, maxSec: 4545 });
    d.check(); // fires once only
    expect(why).toHaveLength(1);
  });

  it('fires on a stall, progress() resets it, cancel() stops it', async () => {
    let wall = 0;
    const why: string[] = [];
    const d = deadlineWatchdog({
      deadline: 10_000,
      graceSec: 60,
      now: () => wall,
      stallSec: 100,
      tickMs: 10_000,
      onFire: (w) => why.push(w),
    });
    wall = 90;
    d.check();
    d.progress();
    wall = 180;
    d.check();
    expect(d.fired).toBe(false);
    wall = 200;
    d.check();
    expect(d.reason).toBe('loop stalled: no progress for 110 s');
    expect(d.jumps.count).toBe(0);
    const c = deadlineWatchdog({
      deadline: 0,
      graceSec: 0.02,
      now: () => 0,
      stallSec: 0,
      tickMs: 10,
      onFire: (w) => why.push(w),
    });
    c.cancel();
    await tick();
    expect(c.fired).toBe(false);
    expect(why).toHaveLength(1);
  });
});

describe('watchdogs', () => {
  it('soft watchdog fires once, and can be cancelled', async () => {
    let n = 0;
    const a = softWatchdog(10, () => (n += 1));
    const b = softWatchdog(10, () => (n += 100));
    b.cancel();
    await new Promise((r) => setTimeout(r, 40));
    expect(n).toBe(1);
    expect(a.fired).toBe(true);
    expect(b.fired).toBe(false);
  });

  it('hard backstop kills a process whose main thread is stuck in synchronous code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cgp-bs-'));
    const statusPath = join(dir, 'status.json');
    const script = `
      const { Worker } = require('node:worker_threads');
      const w = new Worker(process.env.SRC, { eval: true, workerData: { ms: 200, statusPath: process.env.STATUS, reason: 'test' } });
      w.on('online', () => { const end = Date.now() + 20000; while (Date.now() < end) {} });
    `;
    const child = spawn(process.execPath, ['-e', script], {
      env: { ...process.env, SRC: BACKSTOP_WORKER_SOURCE, STATUS: statusPath },
      stdio: 'ignore',
    });
    const t0 = Date.now();
    const sig = await new Promise<NodeJS.Signals | null>((res) => {
      child.on('exit', (_c, s) => {
        res(s);
      });
    });
    expect(sig).toBe('SIGKILL');
    expect(Date.now() - t0).toBeLessThan(10_000);
    const line = JSON.parse((await readFile(statusPath, 'utf8')).trim()) as { state: string; reason: string };
    expect(line.state).toMatch(/^watchdog hard stop: close-out did not finish/);
    expect(line.reason).toBe('test');
  });

  it('hard backstop can be cancelled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cgp-bs-'));
    const b = hardBackstop(60_000, join(dir, 's.json'), 'never');
    await b.cancel();
    await expect(readFile(join(dir, 's.json'), 'utf8')).rejects.toThrow();
  });
});
