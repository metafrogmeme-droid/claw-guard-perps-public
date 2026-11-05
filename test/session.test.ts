import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { runSession } from '../src/cli/session.js';
import { parsePolicy, SESSION_POLICY } from '../src/gate/policy.js';
import { usd } from '../src/gate/units.js';
import { SimVenue, simMarkets } from '../src/venue/index.js';
import { NOW } from './fixtures.js';

// anvil test key 0 (public, allowlisted in .gitleaks.toml)
const signer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const policy = parsePolicy(SESSION_POLICY);

async function run(opts: { gas?: bigint; seconds?: number; probeEvery?: number; daily?: string } = {}) {
  let clock = NOW;
  const venue = new SimVenue(simMarkets(NOW), { collateral: usd('40'), now: () => clock, seed: 7 });
  const dir = await mkdtemp(join(tmpdir(), 'cgp-session-'));
  const lines: string[] = [];
  const r = await runSession({
    venue,
    policy:
      opts.daily === undefined ? policy : parsePolicy({ ...SESSION_POLICY, maxDailyNotionalUsd: opts.daily }),
    journalPath: join(dir, 's.jsonl'),
    statusPath: join(dir, 'status.json'),
    signer,
    now: () => clock,
    wait: (sec) => {
      clock += sec;
      venue.step(sec);
      return Promise.resolve();
    },
    log: (l) => lines.push(l),
    approve: () => Promise.resolve(false),
    seconds: opts.seconds ?? 600,
    cycleSec: 60,
    probeEvery: opts.probeEvery ?? 1,
    quoteNotional: usd('10.5'),
    bandBps: 40,
    minGas: 10n,
    gasBalance: () => Promise.resolve(opts.gas ?? 100n),
  });
  const status = JSON.parse(await readFile(join(dir, 'status.json'), 'utf8')) as { state: string };
  return { r, lines, status, venue };
}

describe('live session runner (sim)', () => {
  it('quotes, probes, counts verdicts, ends flat and re-armed', async () => {
    const { r, lines, status } = await run({ daily: '100000' });
    expect(r.cycles).toBe(10);
    expect(r.stopReason).toBe('time is up');
    expect(r.flat).toBe(true);
    expect(r.counts.allowed).toBeGreaterThan(0);
    expect(lines.filter((l) => l.startsWith('[probe]'))).toHaveLength(10); // one probe per cycle
    expect(r.counts.blocked).toBeGreaterThan(0);
    expect(r.counts.allowed + r.counts.blocked + r.counts.needsOk).toBeGreaterThanOrEqual(r.counts.sent);
    expect(r.counts.ownerYes).toBe(0);
    expect(Object.keys(r.blockedCodes).length).toBeGreaterThan(0);
    expect(r.txHashes.length).toBeGreaterThan(0);
    expect(r.check.ok).toBe(true);
    expect(r.pnl).toBe(r.endEquity - r.startEquity);
    expect(status.state).toBe('done, flat');
  });

  it('stops early under the gas floor', async () => {
    const { r } = await run({ gas: 1n, probeEvery: 0 });
    expect(r.stopReason).toBe('gas under the floor');
    expect(r.cycles).toBe(1);
    expect(r.flat).toBe(true);
  });

  it('refuses to start when not flat', async () => {
    const venue = new SimVenue(simMarkets(NOW), { collateral: usd('40'), now: () => NOW });
    const m = venue.market('BTC-PERP');
    await venue.place(m, {
      market: 'BTC-PERP',
      side: 'long',
      orderType: 'post_only',
      price: m.markPrice - m.tickSize * 100n,
      quantity: 14_000n,
      reduceOnly: false,
      agent: 't',
      reason: 't',
    });
    const dir = await mkdtemp(join(tmpdir(), 'cgp-session-'));
    await expect(
      runSession({
        venue,
        policy,
        journalPath: join(dir, 's.jsonl'),
        statusPath: join(dir, 'st.json'),
        signer,
        now: () => NOW,
        wait: () => Promise.resolve(),
        log: () => undefined,
        approve: () => Promise.resolve(false),
        seconds: 60,
        cycleSec: 60,
        probeEvery: 0,
        quoteNotional: usd('10.5'),
        bandBps: 40,
        minGas: 0n,
      }),
    ).rejects.toThrow(/not flat/);
  });
});
