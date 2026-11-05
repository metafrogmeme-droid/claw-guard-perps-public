import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { runDemo } from '../src/cli/demo.js';
import { loadEnv, ownerFrom, privateKeyFrom } from '../src/cli/env.js';
import { Engine, intentData } from '../src/engine/engine.js';
import { misbehavingScript } from '../src/engine/misbehave.js';
import { bandMaker, quotePrice, quoteQuantity } from '../src/engine/strategy.js';
import { parsePolicy, DEMO_POLICY, policyHash } from '../src/gate/policy.js';
import { usd } from '../src/gate/units.js';
import { Journal, readJournal } from '../src/receipts/journal.js';
import { verifyChain } from '../src/receipts/receipt.js';
import { esc, renderTrace } from '../src/trace/html.js';
import { SimVenue, simMarkets, type Venue } from '../src/venue/index.js';
import { NOW } from './fixtures.js';

// anvil test keys 0 and 1 (public, allowlisted in .gitleaks.toml)
const KEY0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const KEY1 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const signer = privateKeyToAccount(KEY0);
const policy = parsePolicy(DEMO_POLICY);
const tmp = () => mkdtemp(join(tmpdir(), 'cgp-'));

async function setup(collateral = usd('40'), approve?: (agent: string) => boolean) {
  let clock = NOW;
  const sim = new SimVenue(simMarkets(clock), { collateral, now: () => clock, seed: 3 });
  const journal = await Journal.open(join(await tmp(), 'j.jsonl'), signer, policyHash(policy));
  const engine = new Engine({
    venue: sim,
    policy,
    journal,
    now: () => clock,
    ...(approve === undefined ? {} : { approve: (i) => Promise.resolve(approve(i.agent)) }),
  });
  return {
    sim,
    journal,
    engine,
    tick: (s: number) => {
      clock += s;
    },
  };
}

describe('strategy', () => {
  const [btc, eth] = simMarkets(NOW);
  it('quotes on the grid, at or above the venue minimum and the target', () => {
    if (btc === undefined || eth === undefined) throw new Error('fixture');
    const bid = quotePrice(btc, true, 40);
    const ask = quotePrice(btc, false, 40);
    expect(bid % btc.tickSize).toBe(0n);
    expect(ask % btc.tickSize).toBe(0n);
    expect(bid).toBeLessThan(btc.markPrice);
    expect(ask).toBeGreaterThan(btc.markPrice);
    const q = quoteQuantity(btc, bid, usd('10.5'));
    expect(q % btc.lotSize).toBe(0n);
    expect(q).toBeGreaterThanOrEqual(btc.minQuantity);
    expect((bid * q) / 10n ** 8n).toBeGreaterThanOrEqual(usd('10.5'));
    expect(quoteQuantity(btc, bid, 1n)).toBe(btc.minQuantity);
    expect(quoteQuantity(btc, 0n, usd('1'))).toBe(btc.minQuantity);
    expect(quoteQuantity(eth, quotePrice(eth, true, 40), usd('10.5')) % eth.lotSize).toBe(0n);
  });
  it('requotes only stale sides and skips unknown marks', () => {
    if (btc === undefined) throw new Error('fixture');
    const cfg = {
      markets: ['BTC-PERP', 'NOPE'],
      bandBps: 40,
      requoteBps: 80,
      quoteNotional: usd('10'),
      agent: 'm',
    };
    const first = bandMaker(cfg, { 'BTC-PERP': btc }, []);
    expect(first.intents.map((i) => i.side)).toEqual(['long', 'short']);
    const tracked = [
      { market: 'BTC-PERP', orderId: 1n, side: 'long' as const, price: quotePrice(btc, true, 40) },
      { market: 'BTC-PERP', orderId: 2n, side: 'short' as const, price: quotePrice(btc, false, 500) },
    ];
    const next = bandMaker(cfg, { 'BTC-PERP': btc }, tracked);
    expect(next.cancels).toEqual([{ market: 'BTC-PERP', orderId: 2n }]);
    expect(next.intents.map((i) => i.side)).toEqual(['short']);
    expect(bandMaker(cfg, { 'BTC-PERP': { ...btc, markPrice: 0n } }, []).intents).toHaveLength(0);
  });
  it('scripted agent skips the off-tick case when the tick is 1', () => {
    if (btc === undefined) throw new Error('fixture');
    expect(misbehavingScript(btc, usd('10')).some((s) => s.label.includes('tick'))).toBe(true);
    expect(misbehavingScript({ ...btc, tickSize: 1n }, usd('10')).some((s) => s.label.includes('tick'))).toBe(
      false,
    );
    const eth = simMarkets(NOW)[1];
    if (eth === undefined) throw new Error('fixture');
    expect(misbehavingScript(eth, usd('10'))[1]?.intent.assumedBaseDecimals).toBe(8);
  });
});

describe('engine', () => {
  it('receipts every verdict and only sends what passes', async () => {
    const { engine, journal, sim } = await setup();
    const btc = sim.market('BTC-PERP');
    const results = [];
    for (const s of misbehavingScript(btc, usd('10.5'))) {
      const r = await engine.submit(s.intent);
      expect(r.decision.verdict).toBe(s.expect);
      expect(r.execution !== undefined).toBe(s.expect === 'allowed');
      results.push(r);
    }
    expect(journal.receipts.filter((r) => r.kind === 'decision')).toHaveLength(results.length);
    expect(engine.tracked.size).toBe(1);
    expect((await verifyChain(journal.receipts, signer.address)).ok).toBe(true);
    expect(engine.head()).toBe(journal.receipts.at(-1)?.hash);
    expect(engine.lastSnapshot()).toBeDefined();
  });
  it('sends a needs-OK order only with the owner yes', async () => {
    const { engine, sim } = await setup(usd('40'), (a) => a === 'owner');
    const btc = sim.market('BTC-PERP');
    const price = quotePrice(btc, false, 50);
    const base = {
      market: 'BTC-PERP',
      side: 'long' as const,
      orderType: 'ioc' as const,
      price,
      reduceOnly: false,
    };
    const q = quoteQuantity(btc, price, usd('10.5'));
    const no = await engine.submit({ ...base, quantity: q, agent: 'agent' });
    expect(no).toMatchObject({ approved: false });
    expect(no.execution).toBeUndefined();
    const yes = await engine.submit({ ...base, quantity: q, agent: 'owner' });
    expect(yes.approved).toBe(true);
    expect(yes.execution?.result.filled).toBe(q);
    expect(yes.receipt.data['ownerOk']).toBe(true);
  });
  it('records venue failures and stops after the failure limit', async () => {
    const { engine, sim, journal } = await setup();
    const btc = sim.market('BTC-PERP');
    const bad: Venue = {
      mode: sim.mode,
      account: sim.account,
      sender: sim.sender,
      snapshot: (n) => sim.snapshot(n),
      sizing: () => Promise.reject(new Error('rpc down')),
      place: () => Promise.resolve({ ok: false, filled: 0n, errorName: 'InsufficientCollateral' }),
      cancel: (m, o) => sim.cancel(m, o),
      close: () => Promise.resolve(),
    };
    const e = new Engine({ venue: bad, policy, journal, now: () => NOW });
    const intent = misbehavingScript(btc, usd('10.5')).at(-1)?.intent;
    if (intent === undefined) throw new Error('script');
    const r = await e.submit(intent);
    expect(r.decision.codes).toContain('VENUE_UNPRICEABLE');
    const sizingOk: Venue = { ...bad, sizing: (m, i) => sim.sizing(m, i) };
    const e2 = new Engine({ venue: sizingOk, policy, journal, now: () => NOW });
    for (let k = 0; k < 3; k++) {
      const x = await e2.submit(intent);
      expect(x.execution?.result.ok).toBe(false);
    }
    expect((await e2.submit(intent)).decision.codes).toContain('FAILURE_LOOP');
    expect(engine.policy).toBe(policy);
  });
  it('cancels, trips on drawdown, flattens, and re-arms', async () => {
    const { engine, sim, journal } = await setup(usd('40'), () => true);
    const btc = sim.market('BTC-PERP');
    expect(await engine.watch()).toBe(false);
    const quote = misbehavingScript(btc, usd('10.5')).at(-1)?.intent;
    if (quote === undefined) throw new Error('script');
    await engine.submit(quote);
    const price = quotePrice(btc, false, 50);
    await engine.submit({
      market: 'BTC-PERP',
      side: 'long',
      orderType: 'ioc',
      price,
      quantity: quoteQuantity(btc, price, usd('20')),
      reduceOnly: false,
      agent: 'owner',
    });
    const c = await engine.cancel({ market: 'NOPE', orderId: 99n }, 'test');
    expect(c.data['ok']).toBe(false);
    sim.setMark('BTC-PERP', (btc.markPrice * 7n) / 10n - (((btc.markPrice * 7n) / 10n) % btc.tickSize));
    expect(await engine.watch()).toBe(true);
    expect(engine.killSwitch.tripped).toBe(true);
    const s = await engine.snapshot();
    expect(s.orders).toHaveLength(0);
    expect(s.account.positions['BTC-PERP']).toBeUndefined();
    expect(await engine.watch()).toBe(false);
    const blocked = await engine.submit({ ...quote, price: quotePrice(sim.market('BTC-PERP'), true, 50) });
    expect(blocked.decision.codes).toContain('KILL_SWITCH_ACTIVE');
    const re = await engine.rearm();
    expect(re.kind).toBe('kill_switch');
    expect(engine.killSwitch.tripped).toBe(false);
    await engine.kill('test');
    expect(engine.killSwitch.reason).toBe('manual: test');
    expect(journal.receipts.some((r) => r.kind === 'kill_switch' && r.data['action'] === 'trip')).toBe(true);
    expect((await verifyChain(journal.receipts, signer.address)).ok).toBe(true);
  });
  it('intentData keeps every field', () => {
    const d = intentData({
      market: 'BTC-PERP',
      side: 'long',
      orderType: 'limit',
      price: 1n,
      quantity: 2n,
      reduceOnly: false,
      agent: 'a',
    });
    expect(d).toMatchObject({ market: 'BTC-PERP', price: 1n, quantity: 2n });
  });
});

describe('demo', () => {
  it('runs the sim demo end to end with every scripted verdict as written', async () => {
    let clock = NOW;
    const sim = new SimVenue(simMarkets(clock), { collateral: usd('40'), now: () => clock, seed: 7 });
    const lines: string[] = [];
    const path = join(await tmp(), 'demo.jsonl');
    const r = await runDemo({
      venue: sim,
      policy,
      journalPath: path,
      signer,
      now: () => clock,
      wait: (s) => {
        clock += s;
        return Promise.resolve();
      },
      log: (l) => lines.push(l),
      approve: (i) => Promise.resolve(i.agent === 'operator'),
      sim,
      cycles: 4,
      showcaseMarket: 'BTC-PERP',
      quoteNotional: usd('10.5'),
    });
    expect(r.scriptMatches).toBe(r.scriptTotal);
    expect(r.check.ok).toBe(true);
    expect(lines.some((l) => l.includes('[kill switch] tripped'))).toBe(true);
    expect(lines.some((l) => l.includes('KILL_SWITCH_ACTIVE'))).toBe(true);
    const html = renderTrace(await readJournal(path), r.check, {
      title: 't <x>',
      explorerTx: 'https://e/tx/',
      baseDecimals: { 'BTC-PERP': 8 },
    });
    expect(html).toContain('Chain verified');
    expect(html).toContain('t &lt;x&gt;');
    expect(html).toContain('href="https://e/tx/0x');
    expect(html).toContain('Allowed: within your limits');
    expect(html).toContain('Blocked by your rule: MARKET_NOT_ALLOWED');
    expect(html).toContain('Needs your OK: TAKER_ORDER');
    expect(html).not.toMatch(/<script/i);
  });
  it('runs the sim demo with no position to start and rejects an unlisted showcase market', async () => {
    let clock = NOW;
    const sim = new SimVenue(simMarkets(clock), { collateral: usd('40'), now: () => clock, seed: 7 });
    const base = {
      venue: sim,
      policy,
      signer,
      now: () => clock,
      wait: (s: number) => {
        clock += s;
        return Promise.resolve();
      },
      log: () => undefined,
      quoteNotional: usd('10.5'),
    };
    const r = await runDemo({
      ...base,
      journalPath: join(await tmp(), 'a.jsonl'),
      sim,
      cycles: 0,
      showcaseMarket: 'ETH-PERP',
      approve: () => Promise.resolve(true),
    });
    expect(r.check.ok).toBe(true);
    await expect(
      runDemo({ ...base, journalPath: join(await tmp(), 'b.jsonl'), cycles: 0, showcaseMarket: 'XRP-PERP' }),
    ).rejects.toThrow(/not listed/);
  });
});

describe('trace', () => {
  it('escapes and reports a broken chain', async () => {
    expect(esc(`<a href="x">'&`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
    const { engine, journal, sim } = await setup();
    const btc = sim.market('BTC-PERP');
    await engine.submit(misbehavingScript(btc, usd('10.5'))[0]?.intent ?? ({} as never));
    await engine.kill('x');
    const tampered = journal.receipts.map((r, i) => (i === 0 ? { ...r, ts: r.ts + 1 } : r));
    const check = await verifyChain(tampered);
    const html = renderTrace(tampered, check, { title: 'x' });
    expect(html).toContain('Chain check failed');
    expect(renderTrace([], { ok: true, count: 0, head: '0x00', problems: [] }, { title: 'e' })).toContain(
      'Allowed 0',
    );
  });
  it('shows execution failures and tx without an explorer', async () => {
    const { journal } = await setup();
    await journal.append(
      'execution',
      { action: 'place', ok: false, errorName: 'InsufficientCollateral', txHash: '0x1234567890abcdef1234' },
      NOW,
    );
    await journal.append(
      'execution',
      { action: 'place', ok: false, benign: true, error: 'PostOnlyWouldCross' },
      NOW,
    );
    await journal.append('execution', { action: 'place', ok: true, filled: '5', orderId: 3 }, NOW);
    await journal.append(
      'decision',
      {
        verdict: 'allowed',
        intent: { market: 'X', quantity: 'abc', price: '-5', reason: 'r' },
        details: {},
        message: 'm',
      },
      NOW,
    );
    const html = renderTrace(journal.receipts, await verifyChain(journal.receipts), { title: 'x' });
    expect(html).toContain('exec-fail');
    expect(html).toContain('exec-benign');
    expect(html).toContain('filled 5');
    expect(html).toContain('<code>0x123456…1234</code>');
    expect(html).toContain('-0.000000000000000005');
  });
});

describe('env', () => {
  it('reads a key file without overriding the environment', async () => {
    const dir = await tmp();
    const f = join(dir, 'env');
    await writeFile(
      f,
      `PRIVATE_KEY=${KEY1}\nexport OWNER_ADDRESS="0x00000000000000000000000000000000000000aa"\n# comment\n`,
    );
    const saved = { k: process.env['PRIVATE_KEY'], o: process.env['OWNER_ADDRESS'] };
    delete process.env['PRIVATE_KEY'];
    delete process.env['OWNER_ADDRESS'];
    let env: Record<string, string | undefined>;
    try {
      env = loadEnv(f);
    } finally {
      if (saved.k !== undefined) process.env['PRIVATE_KEY'] = saved.k;
      if (saved.o !== undefined) process.env['OWNER_ADDRESS'] = saved.o;
    }
    // compare without printing key material on failure
    expect(privateKeyFrom(env) === KEY1).toBe(true);
    expect(ownerFrom(env)).toBe('0x00000000000000000000000000000000000000aa');
    expect(ownerFrom({ OWNER_ADDRESS: '' })).toBeUndefined();
    expect(ownerFrom({})).toBeUndefined();
    expect(() => ownerFrom({ OWNER_ADDRESS: 'nope' })).toThrow();
    expect(() => privateKeyFrom({ PRIVATE_KEY: '0x12' })).toThrow(/throwaway/);
    expect(() => loadEnv(join(dir, 'missing'))).toThrow(/not found/);
  });
});
