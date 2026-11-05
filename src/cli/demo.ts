// The demo run, shared by `demo --sim` and `demo --live`:
//  1. a scripted agent sends one mistake per intent; each gets its receipt and verdict
//  2. the band maker quotes for a few cycles; the gate's caps shape what goes out
//  3. sim only: the operator takes a position, the mark drops, the kill switch trips and flattens
//  4. the journal is verified end to end
import type { LocalAccount } from 'viem';

import type { Policy } from '../gate/policy.js';
import { policyHash } from '../gate/policy.js';
import { Engine, type Approver } from '../engine/engine.js';
import { misbehavingScript } from '../engine/misbehave.js';
import { bandMaker, quotePrice, quoteQuantity, type BandMakerConfig } from '../engine/strategy.js';
import { Journal } from '../receipts/journal.js';
import { verifyChain, type VerifyResult } from '../receipts/receipt.js';
import type { SimVenue } from '../venue/sim.js';
import type { Venue } from '../venue/types.js';

export interface DemoOptions {
  readonly venue: Venue;
  readonly policy: Policy;
  readonly journalPath: string;
  readonly signer: LocalAccount;
  readonly now: () => number;
  /** Move the clock forward (sim). Live runs wait in real time instead. */
  readonly wait: (sec: number) => Promise<void>;
  readonly log: (line: string) => void;
  readonly approve?: Approver;
  /** Present for --sim: lets the demo move marks and crash the price. */
  readonly sim?: SimVenue;
  readonly cycles: number;
  readonly showcaseMarket: string;
  readonly quoteNotional: bigint;
  readonly bandBps?: number;
}

export interface DemoResult {
  readonly engine: Engine;
  readonly journal: Journal;
  readonly check: VerifyResult;
  readonly scriptMatches: number;
  readonly scriptTotal: number;
}

export async function runDemo(o: DemoOptions): Promise<DemoResult> {
  const journal = await Journal.open(o.journalPath, o.signer, policyHash(o.policy));
  const engine = new Engine({
    venue: o.venue,
    policy: o.policy,
    journal,
    now: o.now,
    ...(o.approve === undefined ? {} : { approve: o.approve }),
  });
  o.log(`venue ${o.venue.mode}, account ${o.venue.account}, sender ${o.venue.sender}`);

  // 1. scripted agent
  const snap = await engine.snapshot();
  const showcase = snap.markets[o.showcaseMarket];
  if (showcase === undefined) throw new Error(`${o.showcaseMarket} is not listed by the venue`);
  const script = misbehavingScript(showcase, o.quoteNotional);
  let matches = 0;
  for (const s of script) {
    const r = await engine.submit(s.intent);
    const hit = r.decision.verdict === s.expect;
    if (hit) matches += 1;
    const sent =
      r.execution === undefined
        ? ''
        : ` -> venue ${r.execution.result.ok ? 'ok' : (r.execution.result.errorName ?? 'failed')}`;
    o.log(`[agent] ${s.label}: ${r.decision.message}${sent}${hit ? '' : ` (expected ${s.expect})`}`);
  }
  // Clear the scripted quote so the maker starts clean.
  for (const t of [...engine.tracked.values()]) await engine.cancel(t, 'end of scripted agent');

  // 2. band maker
  const cfg: BandMakerConfig = {
    markets: o.policy.markets,
    bandBps: o.bandBps ?? 40,
    requoteBps: (o.bandBps ?? 40) * 2,
    quoteNotional: o.quoteNotional,
    agent: 'band-maker',
  };
  for (let i = 0; i < o.cycles; i++) {
    if (await engine.watch()) o.log('[kill switch] tripped on drawdown');
    const s = await engine.snapshot();
    const step = bandMaker(cfg, s.markets, [...engine.tracked.values()]);
    for (const c of step.cancels) await engine.cancel(c, 'requote');
    for (const it of step.intents) {
      const r = await engine.submit(it);
      o.log(`[maker ${String(i + 1)}] ${it.market} ${it.side}: ${r.decision.message}`);
    }
    o.sim?.step(30);
    await o.wait(20);
  }

  // 3. sim: an adverse move trips the kill switch
  if (o.sim !== undefined) {
    const sim = o.sim;
    let m = sim.market(o.showcaseMarket);
    let pos = (await engine.snapshot()).account.positions[m.market] ?? 0n;
    if (pos === 0n) {
      const price = quotePrice(m, false, 50);
      const take = await engine.submit({
        market: m.market,
        side: 'long',
        orderType: 'ioc',
        price,
        quantity: quoteQuantity(m, price, o.quoteNotional),
        reduceOnly: false,
        agent: 'operator',
        reason: 'operator opens a position by hand',
      });
      o.log(`[operator] taker long: ${take.decision.message}${take.approved ? ' (owner said yes)' : ''}`);
      pos = (await engine.snapshot()).account.positions[m.market] ?? 0n;
    }
    const move = pos >= 0n ? 70n : 130n;
    const next = (m.markPrice * move) / 100n;
    sim.setMark(m.market, next - (next % m.tickSize));
    o.log(
      `[sim] ${m.market} position ${pos.toString()}, mark moves ${move === 70n ? 'down' : 'up'} 30% against it`,
    );
    if (await engine.watch()) o.log(`[kill switch] tripped: ${engine.killSwitch.reason ?? ''}`);
    const after = await engine.snapshot();
    const left = Object.entries(after.account.positions).map(([k, v]) => `${k} ${v.toString()}`);
    o.log(
      `[kill switch] open orders ${String(after.orders.length)}, positions left: ${left.join(', ') || 'none'}`,
    );
    m = sim.market(o.showcaseMarket);
    const retry = misbehavingScript(m, o.quoteNotional).at(-1);
    if (retry !== undefined) {
      const again = await engine.submit(retry.intent);
      o.log(`[agent] sends a fresh passive quote after the trip: ${again.decision.message}`);
    }
  }

  const check = await verifyChain(journal.receipts, o.signer.address);
  o.log(
    check.ok
      ? `receipts: ${String(check.count)} verified, head ${check.head}`
      : `receipts: chain check failed (${String(check.problems.length)} problems)`,
  );
  return { engine, journal, check, scriptMatches: matches, scriptTotal: script.length };
}
