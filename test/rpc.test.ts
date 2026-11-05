import { describe, expect, it } from 'vitest';

import type { Engine } from '../src/engine/engine.js';
import { closeOut } from '../src/runtime/closeout.js';
import { resolveNetwork, TOKYO_TESTNET } from '../src/venue/network.js';
import { readWithRetry } from '../src/venue/retry.js';
import type { VenueSnapshot } from '../src/venue/types.js';

describe('RPC fallback list', () => {
  it('has two Tokyo RPCs by default, primary first', () => {
    const n = resolveNetwork({});
    expect(n.rpcUrls).toHaveLength(2);
    expect(n.wsRpcUrls).toHaveLength(2);
    expect(n.rpcUrl).toBe(TOKYO_TESTNET.rpcUrl);
  });
  it('RPC_URL goes first, RPC_URLS are added, no duplicates', () => {
    const n = resolveNetwork({ RPC_URL: 'http://a', RPC_URLS: 'http://b, http://a' });
    expect(n.rpcUrls.slice(0, 2)).toEqual(['http://a', 'http://b']);
    expect(new Set(n.rpcUrls).size).toBe(n.rpcUrls.length);
    expect(n.rpcUrl).toBe('http://a');
  });
});

describe('readWithRetry', () => {
  it('retries a hung read with backoff and rotates on each timeout', async () => {
    let n = 0;
    const rotations: number[] = [];
    const v = await readWithRetry(
      () => {
        n += 1;
        return n < 3 ? new Promise<number>(() => undefined) : Promise.resolve(42);
      },
      'getPosition',
      { attemptMs: 20, attempts: 3, backoffMs: 5 },
      (i) => rotations.push(i),
    );
    expect(v).toBe(42);
    expect(rotations).toEqual([1, 2]);
  });
  it('gives up after the attempts with the last error', async () => {
    await expect(
      readWithRetry(() => Promise.reject(new Error('rpc down')), 'getAccountState', {
        attemptMs: 20,
        attempts: 2,
        backoffMs: 1,
      }),
    ).rejects.toThrow('rpc down');
  });
});

describe('close-out budget', () => {
  it('a hung first flatten cannot use the whole budget: a retry always fits', async () => {
    let flat = false;
    let calls = 0;
    const engine = {
      snapshot: () =>
        Promise.resolve({
          orders: flat ? [] : [{}],
          account: { positions: {} },
        } as unknown as VenueSnapshot),
      abort: () => {
        calls += 1;
        if (calls === 1) return new Promise<void>(() => undefined);
        flat = true;
        return Promise.resolve();
      },
      kill: () => Promise.resolve(),
    } as unknown as Engine;
    // stepMs is as large as the budget (like run 2 on 2 Nov); before, attempt 1 ate everything
    const r = await closeOut(engine, { reason: 'x', budgetMs: 400, stepMs: 400, attempts: 3, backoffMs: 5 });
    expect(calls).toBe(2);
    expect(r.flat).toBe(true);
  });
});
