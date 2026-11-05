// Session rule 1: RPC health gate (offline; sim venue, scripted RPC failures).
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { runSession, type SessionOptions } from '../src/cli/session.js';
import { DEFAULT_PROFIT_RULES } from '../src/engine/profit-rules.js';
import { parsePolicy, SESSION_POLICY } from '../src/gate/policy.js';
import { usd } from '../src/gate/units.js';
import { DEFAULT_RPC_GATE, isInfraError, parseRpcGate, RpcHealthGate } from '../src/runtime/rpc-gate.js';
import { CallTimeoutError, StopRequestedError } from '../src/runtime/timeout.js';
import { SimVenue, simMarkets } from '../src/venue/index.js';
import type { Venue, VenueSnapshot } from '../src/venue/types.js';
import { NOW } from './fixtures.js';

// anvil test key 0 (public, allowlisted in .gitleaks.toml)
const signer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const policy = parsePolicy(SESSION_POLICY);

describe('isInfraError', () => {
  it('treats timeouts, socket and HTTP 5xx / 429 errors as infra, everything else not', () => {
    expect(isInfraError(new CallTimeoutError('venue snapshot', 30_000))).toBe(true);
    for (const m of [
      'getPosition (attempt 3) timed out after 20s',
      'read ECONNRESET',
      'WebSocket is not open',
      'fetch failed',
      'HTTP request failed. Status: 503',
      'Status: 429 Too Many Requests',
      'rpc down',
    ]) {
      expect(isInfraError(new Error(m))).toBe(true);
    }
    expect(isInfraError(new StopRequestedError('SIGTERM'))).toBe(false);
    expect(isInfraError(new Error('account is not flat; run `kill` first'))).toBe(false);
    expect(isInfraError(new TypeError("Cannot read properties of undefined (reading 'markPrice')"))).toBe(
      false,
    );
    expect(isInfraError('timeout')).toBe(true);
  });
});

describe('RpcGateSchema', () => {
  it('has conservative defaults and refuses bad or unknown settings', () => {
    expect(DEFAULT_RPC_GATE).toEqual({
      enabled: true,
      slowReadSec: 20,
      backoffBaseSec: 5,
      backoffMaxSec: 60,
      maxOutageSec: 600,
      maxTotalOutageSec: 1200,
      healthyProbes: 2,
      cancelOnPause: true,
    });
    expect(parseRpcGate(undefined)).toEqual(DEFAULT_RPC_GATE);
    expect(() => parseRpcGate({ maxOutageSec: 0 })).toThrow();
    expect(() => parseRpcGate({ maxOutageSec: 99_999 })).toThrow();
    expect(() => parseRpcGate({ backoffBaseSec: 10, backoffMaxSec: 5 })).toThrow(/backoffMaxSec/);
    expect(() => parseRpcGate({ maxOutageSec: 900, maxTotalOutageSec: 600 })).toThrow(/maxTotalOutageSec/);
    expect(() => parseRpcGate({ typo: 1 })).toThrow();
  });
});

describe('RpcHealthGate', () => {
  const cfg = parseRpcGate({
    slowReadSec: 10,
    backoffBaseSec: 5,
    backoffMaxSec: 30,
    maxOutageSec: 100,
    maxTotalOutageSec: 150,
    healthyProbes: 2,
  });
  const rpcDown = new Error('rpc down');

  it('trades on fast reads, pauses with doubling capped backoff, resumes after N fast reads', () => {
    const g = new RpcHealthGate(cfg);
    expect(g.onRead(1, 0)).toEqual({ action: 'trade' });
    expect(g.onError(rpcDown, 10)).toMatchObject({ action: 'pause', waitSec: 5, started: true });
    expect(g.onError(rpcDown, 15)).toMatchObject({ action: 'pause', waitSec: 10, started: false });
    expect(g.onRead(11, 25)).toMatchObject({ action: 'pause', waitSec: 20, why: 'slow read 11.0 s > 10 s' });
    expect(g.onError(rpcDown, 45)).toMatchObject({ waitSec: 30 });
    expect(g.onError(rpcDown, 75)).toMatchObject({ waitSec: 30 }); // capped
    expect(g.paused).toBe(true);
    expect(g.onRead(1, 80)).toMatchObject({ action: 'pause', why: 'RPC healthy 1/2', waitSec: 5 });
    expect(g.onRead(1, 85)).toEqual({ action: 'trade' });
    expect(g.stats(90)).toEqual({ pauses: 1, outageSec: 75, longestOutageSec: 75, paused: false });
    // backoff starts again from the base on the next outage
    expect(g.onError(rpcDown, 100)).toMatchObject({ waitSec: 5, started: true });
  });

  it('a slow read in the middle of the healthy probes resets the count', () => {
    const g = new RpcHealthGate(cfg);
    g.onError(rpcDown, 0);
    expect(g.onRead(1, 5)).toMatchObject({ action: 'pause' });
    expect(g.onRead(12, 10)).toMatchObject({ action: 'pause' });
    expect(g.onRead(1, 30)).toMatchObject({ action: 'pause', why: 'RPC healthy 1/2' });
  });

  it('ends after one long outage, or when outages add up', () => {
    const a = new RpcHealthGate(cfg);
    a.onError(rpcDown, 0);
    expect(a.onError(rpcDown, 99)).toMatchObject({ action: 'pause' });
    const end = a.onError(rpcDown, 100);
    expect(end).toMatchObject({ action: 'end' });
    expect(end.action === 'end' ? end.why : '').toMatch(/^RPC outage 100 s >= 100 s \(rpc down\)$/);
    const b = new RpcHealthGate(cfg);
    b.onError(rpcDown, 0);
    b.onRead(1, 80);
    b.onRead(1, 90); // outage 1: 90 s
    b.onError(rpcDown, 200);
    expect(b.onError(rpcDown, 259)).toMatchObject({ action: 'pause' });
    const tot = b.onError(rpcDown, 260);
    expect(tot.action === 'end' ? tot.why : '').toMatch(/^RPC outages 150 s in total >= 150 s/);
  });

  it('non-infra errors end at once; disabled gate is the old behaviour', () => {
    const g = new RpcHealthGate(cfg);
    expect(g.onError(new Error('bug'), 0)).toEqual({ action: 'end', why: 'error: bug' });
    const off = new RpcHealthGate(parseRpcGate({ enabled: false }));
    expect(off.onError(rpcDown, 0)).toEqual({ action: 'end', why: 'error: rpc down' });
    expect(off.onRead(999, 0)).toEqual({ action: 'trade' });
    expect(off.startBudgetLeft(0)).toBe(false);
    expect(g.startBudgetLeft(99)).toBe(true);
    expect(g.startBudgetLeft(100)).toBe(false);
    expect([1, 2, 3, 4, 5].map((n) => g.startBackoff(n))).toEqual([5, 10, 20, 30, 30]);
  });
});

/** Sim venue whose snapshot reads fail or are slow on chosen calls. */
class FlakyVenue implements Venue {
  readonly mode = 'sim' as const;
  readonly account: `0x${string}`;
  readonly sender: `0x${string}`;
  reads = 0;
  constructor(
    readonly inner: SimVenue,
    readonly plan: (n: number) => 'ok' | 'fail' | 'slow' | 'bug',
    readonly clock: { ms: number; t: number },
  ) {
    this.account = inner.account;
    this.sender = inner.sender;
  }
  snapshot(names: readonly string[]): Promise<VenueSnapshot> {
    this.reads += 1;
    const p = this.plan(this.reads);
    if (p === 'fail') return Promise.reject(new Error('getAccountState (attempt 3) timed out after 20s'));
    if (p === 'bug') return Promise.reject(new TypeError('bad answer'));
    if (p === 'slow') this.clock.ms += 25_000; // the read "took" 25 s on the wall clock
    return this.inner.snapshot(names);
  }
  sizing: Venue['sizing'] = (m, i) => this.inner.sizing(m, i);
  place: Venue['place'] = (m, i) => this.inner.place(m, i);
  cancel: Venue['cancel'] = (m, o) => this.inner.cancel(m, o);
  close = (): Promise<void> => Promise.resolve();
}

type Plan = (n: number, t: number, ending: boolean) => 'ok' | 'fail' | 'slow' | 'bug';

async function run(plan: Plan, extra: Partial<SessionOptions> = {}) {
  const clock = { t: NOW, ms: 0 };
  const inner = new SimVenue(simMarkets(NOW), { collateral: usd('1000'), now: () => clock.t, seed: 7 });
  let ending = false;
  const venue = new FlakyVenue(inner, (n) => plan(n, clock.t - NOW, ending), clock);
  const dir = await mkdtemp(join(tmpdir(), 'cgp-rpc-'));
  const lines: string[] = [];
  const r = await runSession({
    venue,
    policy,
    journalPath: join(dir, 's.jsonl'),
    statusPath: join(dir, 'status.json'),
    signer,
    now: () => clock.t,
    clockMs: () => clock.ms,
    wait: (sec) => {
      clock.t += sec;
      inner.step(sec);
      return Promise.resolve();
    },
    log: (l) => {
      lines.push(l);
      if (l.startsWith('[session] ending')) ending = true;
      if (process.env['DBG'] !== undefined) console.log(l);
    },
    approve: () => Promise.resolve(false),
    seconds: 3600,
    cycleSec: 120,
    probeEvery: 0,
    quoteNotional: usd('10.5'),
    bandBps: 40,
    minGas: 0n,
    rpcGate: parseRpcGate({}),
    // these tests are about the RPC gate; lift the session loss stop (rule 2) so the sim's drift cannot end the run
    profit: { ...DEFAULT_PROFIT_RULES, maxSessionLossUsd: usd('1000') },
    ...extra,
  });
  const journal = (await readFile(join(dir, 's.jsonl'), 'utf8'))
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { kind: string; data: Record<string, unknown> });
  return { r, lines, journal, inner };
}

describe('session with the RPC health gate', () => {
  it('a 3-minute outage mid-session pauses, pulls quotes, resumes and runs to the end', async () => {
    // every read fails from minute 10 to minute 13 of the session
    const { r, lines } = await run((_n, t) => (t >= 600 && t < 780 ? 'fail' : 'ok'));
    expect(r.stopReason).toBe('time is up');
    expect(r.rpc.pauses).toBe(1);
    expect(r.rpc.outageSec).toBeGreaterThan(0);
    expect(r.rpc.outageSec).toBeLessThan(600);
    expect(r.flat).toBe(true);
    expect(lines.filter((l) => l.startsWith('[rpc] pausing quotes'))).toHaveLength(1);
    expect(lines.some((l) => l.includes('RPC healthy 1/2'))).toBe(true);
    expect(r.counts.cancels).toBeGreaterThan(0); // quotes were pulled at the pause
  });

  it('an outage longer than maxOutageSec ends the session, flat, without an on-chain stop', async () => {
    const { r, journal } = await run((_n, t, ending) => (t >= 600 && !ending ? 'fail' : 'ok'));
    expect(r.stopReason).toMatch(/^RPC outage \d+ s >= 600 s/);
    expect(r.flat).toBe(true);
    expect(journal.filter((x) => x.kind === 'kill_switch' && x.data['action'] === 'trip')).toHaveLength(0);
    expect(journal.some((x) => x.kind === 'session_aborted')).toBe(true);
  });

  it('slow reads pause quoting as well', async () => {
    const { r, lines } = await run((_n, t) => (t === 600 ? 'slow' : 'ok'));
    expect(r.stopReason).toBe('time is up');
    expect(r.rpc.pauses).toBe(1);
    expect(lines.some((l) => l.includes('pausing quotes: slow read 25.0 s > 20 s'))).toBe(true);
  });

  it('a non-infra error still ends the session at once', async () => {
    const { r } = await run((n) => (n === 6 ? 'bug' : 'ok'));
    expect(r.stopReason).toBe('error: bad answer');
    expect(r.rpc.pauses).toBe(0);
    expect(r.flat).toBe(true);
  });

  it('waits for a healthy RPC at the start, and refuses to start after the outage budget', async () => {
    const ok = await run((n) => (n <= 3 ? 'fail' : 'ok'), { seconds: 600 });
    expect(ok.r.stopReason).toBe('time is up');
    expect(ok.lines.filter((l) => l.startsWith('[rpc] start read'))).toHaveLength(3);
    await expect(run(() => 'fail', { rpcGate: parseRpcGate({ maxOutageSec: 60 }) })).rejects.toThrow(
      /^RPC not healthy at start \(\d+ reads, \d+ s\).*not starting$/,
    );
    await expect(run((n) => (n === 1 ? 'bug' : 'ok'))).rejects.toThrow('bad answer');
  });
});

describe('session rules file', () => {
  it('defaults without a file, validates sections, refuses unknown top-level keys', async () => {
    const { DEFAULT_RUNTIME_RULES, parseRuntimeRules } = await import('../src/cli/rules.js');
    expect(parseRuntimeRules(undefined)).toEqual(DEFAULT_RUNTIME_RULES);
    expect(parseRuntimeRules({ rpcGate: { maxOutageSec: 300 } }).rpcGate.maxOutageSec).toBe(300);
    // strategy sections are read elsewhere; they are allowed here
    expect(parseRuntimeRules({ cooldown: {} }).rpcGate).toEqual(DEFAULT_RPC_GATE);
    expect(() => parseRuntimeRules({ rpcgate: {} })).toThrow();
    expect(() => parseRuntimeRules({ rpcGate: { slowReadSec: -1 } })).toThrow();
  });
});

describe('docs/session-rules.example.json', () => {
  it('parses and equals the defaults for every section', async () => {
    const { DEFAULT_RUNTIME_RULES, parseRuntimeRules } = await import('../src/cli/rules.js');
    const raw = JSON.parse(await readFile('docs/session-rules.example.json', 'utf8')) as unknown;
    expect(parseRuntimeRules(raw)).toEqual(DEFAULT_RUNTIME_RULES);
  });
});
