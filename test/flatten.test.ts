// Session rule 4: the close-out gets its own, longer retry budget with backoff (offline).
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { runSession } from '../src/cli/session.js';
import { Engine } from '../src/engine/engine.js';
import { parsePolicy, SESSION_POLICY } from '../src/gate/policy.js';
import { usd } from '../src/gate/units.js';
import { closeOut, DEFAULT_FLATTEN_RETRY, parseFlattenRetry } from '../src/runtime/closeout.js';
import { parseRuntimeRules } from '../src/cli/rules.js';
import { SimVenue, simMarkets } from '../src/venue/index.js';
import type { Venue, VenueSnapshot } from '../src/venue/types.js';
import { NOW } from './fixtures.js';

// anvil test key 0 (public, allowlisted in .gitleaks.toml)
const signer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const policy = parsePolicy(SESSION_POLICY);

/** Fake engine: the first `slow` flatten passes never settle (a slow testnet pass), later ones flatten. */
function fakeEngine(slow: number) {
  let flat = false;
  const calls: string[] = [];
  const snap = (): VenueSnapshot =>
    ({ orders: [], account: { positions: flat ? {} : { 'BTC-PERP': -1n } } }) as unknown as VenueSnapshot;
  const act = (name: string) => (): Promise<void> => {
    calls.push(name);
    if (calls.length <= slow) return new Promise(() => undefined);
    flat = true;
    return Promise.resolve();
  };
  const engine = {
    snapshot: () => Promise.resolve(snap()),
    kill: act('kill'),
    abort: act('abort'),
  } as unknown as Engine;
  return { engine, calls };
}

const first = { reason: 'end of session', budgetMs: 60, stepMs: 40, attempts: 3, backoffMs: 5 };
const retry = parseFlattenRetry({
  retryBudgetSec: 2,
  backoffBaseSec: 0.01,
  backoffMaxSec: 0.04,
  passTimeoutSec: 0.05,
});

describe('FlattenRetrySchema', () => {
  it('has conservative defaults and refuses bad settings', () => {
    expect(DEFAULT_FLATTEN_RETRY).toEqual({
      enabled: true,
      retryBudgetSec: 600,
      backoffBaseSec: 5,
      backoffMaxSec: 60,
      passTimeoutSec: 180,
      maxRetries: 10,
    });
    expect(parseFlattenRetry(undefined)).toEqual(DEFAULT_FLATTEN_RETRY);
    expect(() => parseFlattenRetry({ backoffBaseSec: 30, backoffMaxSec: 10 })).toThrow(/backoffMaxSec/);
    expect(() => parseFlattenRetry({ retryBudgetSec: 0 })).toThrow();
    expect(() => parseFlattenRetry({ maxRetries: 0 })).toThrow();
    expect(() => parseFlattenRetry({ extra: 1 })).toThrow();
    expect(parseRuntimeRules({ flatten: { retryBudgetSec: 900 } }).flatten.retryBudgetSec).toBe(900);
  });
});

describe('close-out retry phase', () => {
  it('one slow pass used the whole first budget (2 Nov run 2): the retry phase still ends flat', async () => {
    const f = fakeEngine(1);
    const lines: string[] = [];
    const r = await closeOut(f.engine, { ...first, attempts: 1, retry, log: (l) => lines.push(l) });
    expect(r.flat).toBe(true);
    expect(r.retries).toBe(2); // retry 1 flattens, retry 2 reads the account and confirms flat
    expect(f.calls).toEqual(['abort', 'abort']);
    expect(r.errors[0]).toMatch(/^attempt 1: close-out flatten timed out/);
    expect(lines.some((l) => l.startsWith('[close-out] not flat after the first budget'))).toBe(true);
    expect(lines.some((l) => l.startsWith('[close-out] retry 1: 0 open orders, 1 positions'))).toBe(true);
  });

  it('without the retry phase the same case ends NOT flat (old behaviour)', async () => {
    const f = fakeEngine(1);
    const r = await closeOut(f.engine, { ...first, attempts: 1 });
    expect(r.flat).toBe(false);
    expect(r.retries).toBe(0);
    const off = await closeOut(fakeEngine(1).engine, {
      ...first,
      attempts: 1,
      retry: parseFlattenRetry({ enabled: false }),
    });
    expect(off.retries).toBe(0);
    expect(off.flat).toBe(false);
  });

  it('backs off between retries (doubling, capped) and keeps the kill-switch path after a guard trip', async () => {
    const f = fakeEngine(4);
    const t0 = Date.now();
    const r = await closeOut(f.engine, { ...first, attempts: 1, retry, stop: true });
    expect(r.flat).toBe(true);
    expect(r.retries).toBe(5);
    expect(f.calls.every((c) => c === 'kill')).toBe(true);
    expect(r.errors.filter((e) => e.startsWith('retry '))).toHaveLength(3);
    // waits 10 + 20 + 40 + 40 ms, plus 3 timed-out passes of 50 ms
    expect(Date.now() - t0).toBeGreaterThanOrEqual(10 + 20 + 40 + 40 + 3 * 50 - 15);
  });

  it('is bounded: stops after maxRetries or when the retry budget is spent, then reports NOT flat', async () => {
    const a = await closeOut(fakeEngine(99).engine, {
      ...first,
      attempts: 1,
      retry: { ...retry, maxRetries: 2 },
    });
    expect(a).toMatchObject({ flat: false, retries: 2 });
    const t0 = Date.now();
    const b = await closeOut(fakeEngine(99).engine, {
      ...first,
      attempts: 1,
      retry: parseFlattenRetry({
        retryBudgetSec: 0.15,
        backoffBaseSec: 0.01,
        backoffMaxSec: 0.01,
        passTimeoutSec: 1,
        maxRetries: 100,
      }),
    });
    expect(b.flat).toBe(false);
    expect(b.retries).toBeLessThan(100);
    expect(Date.now() - t0).toBeLessThan(1500);
    // a backoff that no longer fits the budget ends the phase without another pass
    const c = await closeOut(fakeEngine(99).engine, {
      ...first,
      attempts: 1,
      retry: parseFlattenRetry({ retryBudgetSec: 0.01, backoffBaseSec: 0.05, backoffMaxSec: 0.05 }),
    });
    expect(c.retries).toBe(0);
  });

  it('a flat account is found by the retry snapshot without sending anything', async () => {
    let n = 0;
    const engine = {
      snapshot: () => {
        n += 1;
        return n === 1
          ? Promise.reject(new Error('rpc down'))
          : Promise.resolve({ orders: [], account: { positions: {} } } as unknown as VenueSnapshot);
      },
      abort: () => Promise.reject(new Error('must not be called')),
    } as unknown as Engine;
    const r = await closeOut(engine, { ...first, attempts: 1, retry });
    expect(r).toMatchObject({ flat: true, retries: 1, passes: 0 });
  });
});

/** Sim venue whose first `failCancels` cancels revert, like a congested testnet. */
class StickyVenue implements Venue {
  readonly mode = 'sim' as const;
  readonly account: `0x${string}`;
  readonly sender: `0x${string}`;
  cancels = 0;
  closing = false;
  constructor(
    readonly inner: SimVenue,
    readonly failCancels: number,
  ) {
    this.account = inner.account;
    this.sender = inner.sender;
  }
  snapshot: Venue['snapshot'] = (n) => this.inner.snapshot(n);
  sizing: Venue['sizing'] = (m, i) => this.inner.sizing(m, i);
  place: Venue['place'] = (m, i) => this.inner.place(m, i);
  cancel: Venue['cancel'] = (m, o) => {
    if (this.closing) {
      this.cancels += 1;
      if (this.cancels <= this.failCancels) return Promise.resolve({ ok: false, error: 'reverted' });
    }
    return this.inner.cancel(m, o);
  };
  close = (): Promise<void> => Promise.resolve();
}

describe('session with the close-out retry phase', () => {
  it('ends flat although every cancel in the first budget reverted', async () => {
    let clock = NOW;
    const inner = new SimVenue(simMarkets(NOW), { collateral: usd('1000'), now: () => clock, seed: 7 });
    const venue = new StickyVenue(inner, 12);
    const dir = await mkdtemp(join(tmpdir(), 'cgp-flat-'));
    const lines: string[] = [];
    const r = await runSession({
      venue,
      policy,
      journalPath: join(dir, 's.jsonl'),
      statusPath: join(dir, 'status.json'),
      signer,
      now: () => clock,
      wait: (sec) => {
        clock += sec;
        inner.step(sec);
        return Promise.resolve();
      },
      log: (l) => {
        lines.push(l);
        if (l.startsWith('[session] ending')) venue.closing = true;
      },
      approve: () => Promise.resolve(false),
      seconds: 600,
      cycleSec: 120,
      probeEvery: 0,
      quoteNotional: usd('10.5'),
      bandBps: 40,
      minGas: 0n,
      closeoutSec: 0.3,
      flatten: retry,
    });
    expect(r.flat).toBe(true);
    expect(r.closeOut.retries).toBeGreaterThan(0);
    expect(r.closeOut.errors).toEqual([]);
    expect(lines.some((l) => l.startsWith('[close-out] not flat after the first budget'))).toBe(true);
  });
});
