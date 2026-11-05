// One resting post-only bid through the gate, for the Reactivity demo: something real for an on-chain stop to
// cancel. Maker, below the "Needs your OK" size, well inside the price band: the gate says "Allowed".
import type { LocalAccount } from 'viem';

import { Engine } from '../engine/engine.js';
import { quoteQuantity } from '../engine/strategy.js';
import { policyHash, type Policy } from '../gate/policy.js';
import { floorToGrid } from '../gate/units.js';
import { Journal } from '../receipts/journal.js';
import type { Venue } from '../venue/types.js';

export interface RestOptions {
  readonly venue: Venue;
  readonly policy: Policy;
  readonly journalPath: string;
  readonly signer: LocalAccount;
  readonly now: () => number;
  readonly log: (line: string) => void;
  readonly market: string;
  readonly notional: bigint;
  /** How far below the mark the bid rests, bps. Must stay inside the policy's deviation limit. */
  readonly offsetBps: number;
}

export async function runRest(
  o: RestOptions,
): Promise<{ verdict: string; resting: number; txHash?: string }> {
  if (o.offsetBps <= 0 || o.offsetBps >= o.policy.maxPriceDeviationBps) {
    throw new Error(
      `offset ${String(o.offsetBps)} bps must be inside (0, ${String(o.policy.maxPriceDeviationBps)})`,
    );
  }
  const journal = await Journal.open(o.journalPath, o.signer, policyHash(o.policy));
  const engine = new Engine({ venue: o.venue, policy: o.policy, journal, now: o.now });
  const s0 = await engine.snapshot([o.market]);
  const m = s0.markets[o.market];
  if (m === undefined) throw new Error(`${o.market} is not listed by the venue`);
  const price = floorToGrid((m.markPrice * BigInt(10_000 - o.offsetBps)) / 10_000n, m.tickSize);
  const r = await engine.submit({
    market: o.market,
    side: 'long',
    orderType: 'post_only',
    price,
    quantity: quoteQuantity(m, price, o.notional),
    reduceOnly: false,
    agent: 'operator',
    reason: `reactivity demo: one resting bid ${String(o.offsetBps)} bps under the mark`,
  });
  const x = r.execution?.result;
  const s1 = await engine.snapshot([o.market]);
  o.log(
    `[rest] ${r.decision.message}${x === undefined ? ', not sent' : ` -> venue ${x.ok ? 'ok' : (x.errorName ?? x.error ?? 'failed')}`}; open orders ${String(s1.orders.length)}`,
  );
  return {
    verdict: r.decision.verdict,
    resting: s1.orders.length,
    ...(x?.txHash === undefined ? {} : { txHash: x.txHash }),
  };
}
