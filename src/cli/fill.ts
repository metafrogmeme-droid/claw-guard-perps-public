// The filled-trade proof, shared by `fill --sim` and `fill --live`:
//  1. one taker (IOC) long at the venue minimum size. The demo policy says "Needs your OK" for every opening
//     taker order, so the owner's answer is asked for and written into the decision receipt (ownerOk).
//  2. if it filled, a reduce-only IOC short for exactly the filled size closes the position. A verified reduce
//     adds no exposure, so the gate allows it without asking.
//  3. the account must end flat; if it does not, the kill switch flattens it and the run reports that.
// Every step leaves a signed receipt; the journal is verified at the end.
import type { LocalAccount } from 'viem';

import type { Approver } from '../engine/engine.js';
import { Engine } from '../engine/engine.js';
import { quoteQuantity } from '../engine/strategy.js';
import type { Policy } from '../gate/policy.js';
import { policyHash } from '../gate/policy.js';
import type { OrderIntent } from '../gate/types.js';
import { floorToGrid } from '../gate/units.js';
import { Journal } from '../receipts/journal.js';
import { verifyChain, type VerifyResult } from '../receipts/receipt.js';
import type { BookTop, Venue, VenueMarket } from '../venue/types.js';

export interface FillOptions {
  readonly venue: Venue;
  readonly policy: Policy;
  readonly journalPath: string;
  readonly signer: LocalAccount;
  readonly now: () => number;
  readonly log: (line: string) => void;
  readonly approve: Approver;
  readonly market: string;
  /** Target notional, raw USDso; rounded up to the lot and never below the venue minimum. */
  readonly notional: bigint;
  /** How far past the best price the IOC limit may go, bps. Keeps the taker price tight. */
  readonly slippageBps?: number;
}

export interface FillStep {
  readonly verdict: string;
  readonly message: string;
  readonly ownerOk?: boolean;
  readonly sent: boolean;
  readonly ok?: boolean;
  readonly txHash?: `0x${string}`;
  readonly filled: bigint;
  readonly error?: string;
}

export interface FillResult {
  readonly open: FillStep;
  readonly close?: FillStep;
  readonly flat: boolean;
  readonly killSwitchUsed: boolean;
  readonly check: VerifyResult;
  readonly journal: Journal;
}

/** IOC limit: best opposite price plus a small buffer, on the tick grid, capped by the policy's deviation. */
export function takerPrice(
  m: VenueMarket,
  buy: boolean,
  top: BookTop | undefined,
  policy: Policy,
  slippageBps: number,
): bigint {
  const ref = (buy ? top?.bestAsk : top?.bestBid) ?? m.markPrice;
  const b = BigInt(slippageBps);
  const capBps = BigInt(policy.maxPriceDeviationBps);
  if (buy) {
    const want = (ref * (10_000n + b) + 9_999n) / 10_000n;
    const cap = (m.markPrice * (10_000n + capBps)) / 10_000n;
    const p = want < cap ? want : cap;
    const up = floorToGrid(p + m.tickSize - 1n, m.tickSize);
    return up > cap ? floorToGrid(cap, m.tickSize) : up;
  }
  const want = (ref * (10_000n - b)) / 10_000n;
  const cap = (m.markPrice * (10_000n - capBps) + 9_999n) / 10_000n;
  const p = want > cap ? want : cap;
  const down = floorToGrid(p, m.tickSize);
  return down < cap ? floorToGrid(cap + m.tickSize - 1n, m.tickSize) : down;
}

function step(r: Awaited<ReturnType<Engine['submit']>>): FillStep {
  const x = r.execution?.result;
  return {
    verdict: r.decision.verdict,
    message: r.decision.message,
    ...(r.decision.verdict === 'needs_ok' ? { ownerOk: r.approved } : {}),
    sent: x !== undefined,
    ...(x === undefined ? {} : { ok: x.ok }),
    ...(x?.txHash === undefined ? {} : { txHash: x.txHash }),
    filled: x?.filled ?? 0n,
    ...(x?.errorName !== undefined || x?.error !== undefined ? { error: x.errorName ?? x.error ?? '' } : {}),
  };
}

export async function runFill(o: FillOptions): Promise<FillResult> {
  const journal = await Journal.open(o.journalPath, o.signer, policyHash(o.policy));
  const engine = new Engine({ venue: o.venue, policy: o.policy, journal, now: o.now, approve: o.approve });
  const slip = o.slippageBps ?? 10;
  o.log(`venue ${o.venue.mode}, account ${o.venue.account}, sender ${o.venue.sender}`);

  const s0 = await engine.snapshot([o.market]);
  const m = s0.markets[o.market];
  if (m === undefined) throw new Error(`${o.market} is not listed by the venue`);
  const start = s0.account.positions[o.market] ?? 0n;
  if (start !== 0n || s0.orders.length > 0) {
    throw new Error(
      `account is not flat (${o.market} position ${start.toString()}, ${String(s0.orders.length)} open orders); run \`kill\` first`,
    );
  }

  // 1. open: taker long, minimal size
  const buyPx = takerPrice(m, true, await o.venue.bookTop?.(m), o.policy, slip);
  const openIntent: OrderIntent = {
    market: o.market,
    side: 'long',
    orderType: 'ioc',
    price: buyPx,
    quantity: quoteQuantity(m, buyPx, o.notional),
    reduceOnly: false,
    agent: 'operator',
    reason: 'fill proof: one minimal taker order, owner asked first',
  };
  const open = step(await engine.submit(openIntent));
  o.log(
    `[open] ${open.message}${open.ownerOk === true ? ' (owner said yes)' : open.ownerOk === false ? ' (owner said no)' : ''}` +
      (open.sent
        ? ` -> venue ${open.ok === true ? 'ok' : (open.error ?? 'failed')}, filled ${open.filled.toString()}`
        : ', not sent'),
  );

  // 2. close: reduce-only taker short for whatever the account now holds
  let close: FillStep | undefined;
  const s1 = await engine.snapshot([o.market]);
  const pos = s1.account.positions[o.market] ?? 0n;
  const m1 = s1.markets[o.market] ?? m;
  if (pos !== 0n) {
    const sellPx = takerPrice(m1, pos < 0n, await o.venue.bookTop?.(m1), o.policy, slip);
    close = step(
      await engine.submit({
        market: o.market,
        side: pos > 0n ? 'short' : 'long',
        orderType: 'ioc',
        price: sellPx,
        quantity: pos < 0n ? -pos : pos,
        reduceOnly: true,
        agent: 'operator',
        reason: 'fill proof: reduce-only close back to flat',
      }),
    );
    o.log(
      `[close] ${close.message}` +
        (close.sent
          ? ` -> venue ${close.ok === true ? 'ok' : (close.error ?? 'failed')}, filled ${close.filled.toString()}`
          : ', not sent'),
    );
  }

  // 3. end flat, or flatten through the kill switch and say so
  let s2 = await engine.snapshot([o.market]);
  let killSwitchUsed = false;
  if ((s2.account.positions[o.market] ?? 0n) !== 0n || s2.orders.length > 0) {
    killSwitchUsed = true;
    o.log('[close] account not flat after the close; tripping the kill switch to flatten');
    await engine.kill('fill proof did not end flat');
    s2 = await engine.snapshot([o.market]);
  }
  const flat = (s2.account.positions[o.market] ?? 0n) === 0n && s2.orders.length === 0;
  o.log(
    `[end] ${flat ? 'flat' : 'NOT flat'}: ${o.market} position ${(s2.account.positions[o.market] ?? 0n).toString()}, open orders ${String(s2.orders.length)}`,
  );

  const check = await verifyChain(journal.receipts, o.signer.address);
  o.log(
    check.ok
      ? `receipts: ${String(check.count)} verified, head ${check.head}`
      : `receipts: chain check failed (${String(check.problems.length)} problems)`,
  );
  return { open, ...(close === undefined ? {} : { close }), flat, killSwitchUsed, check, journal };
}
