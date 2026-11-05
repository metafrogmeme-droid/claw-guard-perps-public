import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { KNOWN_GAPS, PROBE_GROUPS, probeMatrix, type ProbeVariant } from '../src/engine/probe-matrix.js';
import {
  FENCE_ERROR,
  ProbeFence,
  probeMarkdown,
  runProbes,
  type ProbeRunResult,
} from '../src/engine/probes.js';
import { BLOCK_CODES } from '../src/gate/codes.js';
import { SESSION_POLICY, parsePolicy, policyHash } from '../src/gate/policy.js';
import { usd } from '../src/gate/units.js';
import { Journal, readJournal } from '../src/receipts/journal.js';
import { verifyChain } from '../src/receipts/receipt.js';
import { SimVenue, simMarkets, type Venue } from '../src/venue/index.js';
import type { VenueSnapshot } from '../src/venue/types.js';
import { NOW } from './fixtures.js';

// anvil test key 0 (public, allowlisted in .gitleaks.toml)
const KEY0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const signer = privateKeyToAccount(KEY0);
const policy = parsePolicy(SESSION_POLICY);
const tmp = () => mkdtemp(join(tmpdir(), 'cgp-probes-'));
const sim = () => new SimVenue(simMarkets(NOW), { collateral: usd('2000'), now: () => NOW, seed: 7 });

async function run(venue: Venue = sim()) {
  const path = join(await tmp(), 'p.jsonl');
  const journal = await Journal.open(path, signer, policyHash(policy));
  const lines: string[] = [];
  const r = await runProbes({
    venue,
    policy,
    journal,
    policyHash: policyHash(policy),
    now: () => NOW,
    log: (l) => lines.push(l),
    quoteNotional: usd('10.5'),
  });
  return { r, path, lines, journal };
}

async function matrix(): Promise<ProbeVariant[]> {
  const s = await sim().snapshot(['BTC-PERP', 'ETH-PERP']);
  const btc = s.markets['BTC-PERP'];
  const eth = s.markets['ETH-PERP'];
  if (btc === undefined || eth === undefined) throw new Error('sim markets missing');
  return probeMatrix({ btc, eth }, usd('10.5'));
}

describe('probe matrix', () => {
  it('has 30+ unique variants, each with an expected verdict, in every group', async () => {
    const m = await matrix();
    expect(m.length).toBeGreaterThanOrEqual(30);
    expect(new Set(m.map((p) => p.id)).size).toBe(m.length);
    for (const g of PROBE_GROUPS) expect(m.some((p) => p.group === g)).toBe(true);
    for (const p of m) if (p.expect !== 'allowed') expect(p.rule).toBeDefined();
    expect(m.filter((p) => p.forward === true).map((p) => p.id)).toEqual(['ctl-forward']);
  });

  it('expects every block rule at least once, plus both OK rules this policy uses', async () => {
    const rules = new Set((await matrix()).map((p) => p.rule));
    for (const c of BLOCK_CODES) expect(rules.has(c), c).toBe(true);
    expect(rules.has('TAKER_ORDER')).toBe(true);
    expect(rules.has('ABOVE_OK_THRESHOLD')).toBe(true);
  });

  it('lists only existing ids as known gaps', async () => {
    const ids = new Set((await matrix()).map((p) => p.id));
    for (const id of Object.keys(KNOWN_GAPS)) expect(ids.has(id), id).toBe(true);
  });
});

describe('probe run against the sim', async () => {
  const { r, path, lines } = await run();
  const byId = new Map(r.results.map((x) => [x.id, x]));

  it.each((await matrix()).map((p) => [p.id, p] as const))('%s', (id, p) => {
    const x = byId.get(id);
    expect(x).toBeDefined();
    if (x === undefined) return;
    expect(x.verdict).not.toBe('threw');
    expect(x.receipts.length).toBe(p.repeat ?? 1);
    if (p.forward !== true) expect(x.venueSubmits).toBe(0);
    if (p.expect !== 'allowed') expect(x.reachedFence).toBe(0);
    expect(x.verdict).toBe(p.expect);
    if (p.rule !== undefined) expect(x.codes).toContain(p.rule);
    expect(x.pass).toBe(true);
    expect(x.knownGap).toBeUndefined();
  });

  it('never sends a blocked or held probe to the venue', () => {
    expect(r.fenceOk).toBe(true);
    expect(r.venueSubmits).toBe(1);
    expect(r.expectedVenueSubmits).toBe(1);
    expect(r.results.filter((x) => x.expect !== 'allowed').every((x) => x.venueSubmits === 0)).toBe(true);
    // nothing that should be stopped gets past the gate
    expect(r.gateLetThrough).toBe(0);
  });

  it('has no new gaps and cleans up after the control quote', () => {
    expect(r.unexpected).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(Object.keys(KNOWN_GAPS)).toEqual([]);
    expect(r.passed).toBe(r.total);
    expect(r.cleanup).toEqual({ cancels: 1, closeOutSubmits: 0, positionsLeft: 0 });
    expect(byId.get('ctl-forward')?.venueOk).toBe(true);
  });

  it('signs a receipt for every probe and the chain verifies from disk', async () => {
    expect(r.check.ok).toBe(true);
    const disk = await readJournal(path);
    expect((await verifyChain(disk)).ok).toBe(true);
    const decisions = disk.filter((x) => x.kind === 'decision');
    const expected = r.results.reduce((n, x) => n + x.receipts.length, 0);
    expect(decisions.length).toBe(expected);
  });

  it('counts per group and per rule, and logs each probe', () => {
    expect(r.byGroup.reduce((n, g) => n + g.probes, 0)).toBe(r.total);
    expect(r.byRule.reduce((n, g) => n + g.probes, 0)).toBe(r.total);
    expect(r.codesSeen['MARKET_NOT_ALLOWED']).toBeGreaterThanOrEqual(8);
    expect(lines.filter((l) => l.startsWith('[probe] ')).length).toBe(r.total);
    expect(lines.some((l) => l.includes('gate threw'))).toBe(false);
    expect(r.codesSeen['INTENT_MALFORMED']).toBeGreaterThanOrEqual(10);
  });

  it('writes a markdown summary with anchors as links', () => {
    const md = probeMarkdown(r, { journal: '0xabc', anchors: ['0x01', '0x02'], explorerTx: 'https://x/tx/' });
    expect(md).toContain(`| Probes | ${String(r.total)} |`);
    expect(md).toContain('| Not as expected, new | 0 |');
    expect(md).toContain('Journal 0xabc');
    expect(md).toContain('- [0x01](https://x/tx/0x01)');
    const bare = probeMarkdown(r, { anchors: ['0x03'] });
    expect(bare).toContain('- 0x03');
    expect(probeMarkdown(r)).not.toContain('## Anchors');
  });

  it('marks a probe that is not a listed gap as new', () => {
    const first = r.results[0];
    if (first === undefined) throw new Error('no results');
    const broken: ProbeRunResult = {
      ...r,
      results: [{ ...first, pass: false, verdict: 'threw', codes: [] }],
      failed: [first.id],
      unexpected: [first.id],
    };
    const md = probeMarkdown(broken);
    expect(md).toContain(`| Not as expected, new | 1: ${first.id} |`);
    expect(md).toContain('NOT AS EXPECTED');
    expect(md).toContain('| Not as expected, known gaps | 0 |');
    const gap: ProbeRunResult = {
      ...broken,
      results: [{ ...first, pass: false, knownGap: 'still open' }],
      unexpected: [],
    };
    const g = probeMarkdown(gap);
    expect(g).toContain('known gap: still open');
    expect(g).toContain(`| Not as expected, known gaps | 1: ${first.id} |`);
  });
});

describe('probe fence', () => {
  it('fences orders unless the probe is marked forward, and passes reads through', async () => {
    const inner = sim();
    const f = new ProbeFence(inner, () => NOW);
    expect(f.mode).toBe(inner.mode);
    expect(f.account).toBe(inner.account);
    expect(f.sender).toBe(inner.sender);
    const s = await f.snapshot(['BTC-PERP']);
    const m = s.markets['BTC-PERP'];
    if (m === undefined) throw new Error('no BTC');
    const [p] = probeMatrix({ btc: m, eth: m }, usd('10.5'));
    if (p === undefined) throw new Error('empty matrix');
    const res = await f.place(m, p.intent);
    expect(res).toEqual({ ok: false, filled: 0n, error: FENCE_ERROR });
    expect(f.placeCalls).toBe(1);
    expect(f.venueSubmits).toBe(0);
    await f.close();
  });

  it('applies an account setup even when the target market is not listed', async () => {
    const f = new ProbeFence(sim(), () => NOW);
    const s0 = await f.snapshot(['BTC-PERP']);
    const m = s0.markets['BTC-PERP'];
    if (m === undefined) throw new Error('no BTC');
    const [p] = probeMatrix({ btc: m, eth: m }, usd('10.5'));
    if (p === undefined) throw new Error('empty matrix');
    f.current = {
      ...p,
      intent: { ...p.intent, market: 'NOPE-PERP' },
      setup: { account: (a) => ({ ...a, equity: 1n }) },
    };
    const s = await f.snapshot(['BTC-PERP', 'NOPE-PERP']);
    expect(s.account.equity).toBe(1n);
    const none = new ProbeFence(noMarkets(sim()), () => NOW);
    none.current = f.current;
    expect((await none.snapshot([])).account.equity).toBe(s0.account.equity);
  });
});

/** Sim wrapper that lists no markets. */
function noMarkets(inner: SimVenue): Venue {
  return new Proxy(inner, {
    get(t, k, r) {
      if (k === 'snapshot') {
        return async (ms: readonly string[]): Promise<VenueSnapshot> => ({
          ...(await t.snapshot(ms)),
          markets: {},
        });
      }
      const v: unknown = Reflect.get(t, k, r);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

/** Sim wrapper that reports a BTC position while `hold.on` is set. */
function holding(inner: SimVenue, hold: { on: boolean }): Venue {
  return new Proxy(inner, {
    get(t, k, r) {
      if (k === 'snapshot') {
        return async (ms: readonly string[]): Promise<VenueSnapshot> => {
          const s = await t.snapshot(ms);
          if (!hold.on) return s;
          return {
            ...s,
            account: { ...s.account, positions: { ...s.account.positions, 'BTC-PERP': 100_000n } },
          };
        };
      }
      const v: unknown = Reflect.get(t, k, r);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

describe('probe run edge cases', () => {
  it('refuses an account that is not flat', async () => {
    await expect(run(holding(sim(), { on: true }))).rejects.toThrow(/flat account/);
  });

  it('refuses when a matrix market is not listed', async () => {
    await expect(run(noMarkets(sim()))).rejects.toThrow(/must be listed/);
  });

  it('records a probe as threw when the venue read fails, and keeps going', async () => {
    const inner = sim();
    let armed = false;
    const v = new Proxy(inner, {
      get(t, k, r) {
        if (k === 'snapshot')
          return (ms: readonly string[]) => (armed ? Promise.reject(new Error('rpc down')) : t.snapshot(ms));
        const x: unknown = Reflect.get(t, k, r);
        return typeof x === 'function' ? (x as (...a: unknown[]) => unknown).bind(t) : x;
      },
    });
    const journal = await Journal.open(join(await tmp(), 't.jsonl'), signer, policyHash(policy));
    const lines: string[] = [];
    const r = await runProbes({
      venue: v,
      policy,
      journal,
      policyHash: policyHash(policy),
      now: () => NOW,
      log: (l) => {
        lines.push(l);
        armed = l.includes('mkt-unknown:');
      },
      quoteNotional: usd('10.5'),
    });
    expect(r.unexpected).toEqual(['mkt-lowercase']);
    expect(r.results.find((x) => x.id === 'mkt-lowercase')?.verdict).toBe('threw');
    expect(lines.find((l) => l.includes('mkt-lowercase'))).toMatch(/FAIL .*gate threw \(rpc down\)/);
  });

  it('closes out reduce-only when a position is left after the run', async () => {
    const hold = { on: false };
    const journal = await Journal.open(join(await tmp(), 'c.jsonl'), signer, policyHash(policy));
    const r = await runProbes({
      venue: holding(sim(), hold),
      policy,
      journal,
      policyHash: policyHash(policy),
      now: () => NOW,
      log: (l) => {
        if (l.includes('ctl-forward')) hold.on = true;
      },
      quoteNotional: usd('10.5'),
    });
    expect(r.cleanup.closeOutSubmits).toBe(1);
    expect(r.cleanup.positionsLeft).toBe(1);
    expect(journal.receipts.some((x) => x.kind === 'session_aborted')).toBe(true);
    expect(r.venueSubmits).toBe(1);
  });
});
