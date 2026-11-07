// The runner: snapshot -> gate -> decision receipt -> venue -> execution receipt. Every intent, whatever the
// verdict, leaves a signed receipt. Only "allowed" (or "needs_ok" with the owner's yes) reaches the venue.
// Cancels are not gated (they only remove risk) but are receipted.
import type { Hex } from 'viem';

import { EMPTY_MEMORY, evaluate, recordAllowed, recordVenueResult } from '../gate/gate.js';
import { isWellFormed, rawIntentData } from '../gate/shape.js';
import type { Policy } from '../gate/policy.js';
import type { Decision, GateMemory, OrderIntent } from '../gate/types.js';
import {
  INITIAL_KILL_SWITCH,
  onEquity,
  planFlatten,
  reset,
  tripManually,
  type FlattenPlan,
  type KillSwitchState,
  type RestingOrder,
} from '../killswitch/killswitch.js';
import type { Journal } from '../receipts/journal.js';
import type { Receipt } from '../receipts/receipt.js';
import type { PlaceResult, Venue, VenueSnapshot } from '../venue/types.js';

/** Asked when the gate says "Needs your OK". Returning false (or no approver) means no. */
export type Approver = (intent: OrderIntent, decision: Decision) => Promise<boolean>;

export interface EngineOptions {
  readonly venue: Venue;
  readonly policy: Policy;
  readonly journal: Journal;
  readonly now: () => number;
  readonly approve?: Approver;
}

/** What one flatten pass planned and what happened to each reduce. Cancels are receipted on their own. */
export interface FlattenOutcome {
  readonly plan: FlattenPlan;
  /** Guard blocks, venue rejections, and partial fills. Empty when every reduce filled in full. */
  readonly problems: readonly string[];
}

export interface SubmitResult {
  readonly decision: Decision;
  readonly approved: boolean;
  readonly receipt: Receipt;
  readonly execution?: { readonly result: PlaceResult; readonly receipt: Receipt };
}

/** Orders this engine placed and believes are resting, with the price it sent. */
export interface TrackedOrder extends RestingOrder {
  readonly side: OrderIntent['side'];
  readonly price: bigint;
}

export function intentData(i: OrderIntent): Record<string, unknown> {
  return {
    market: i.market,
    side: i.side,
    orderType: i.orderType,
    price: i.price,
    quantity: i.quantity,
    reduceOnly: i.reduceOnly,
    agent: i.agent,
    reason: i.reason,
    assumedBaseDecimals: i.assumedBaseDecimals,
  };
}

export class Engine {
  memory: GateMemory = EMPTY_MEMORY;
  killSwitch: KillSwitchState = INITIAL_KILL_SWITCH;
  readonly tracked = new Map<bigint, TrackedOrder>();
  private last: VenueSnapshot | undefined;

  constructor(private readonly o: EngineOptions) {}

  get policy(): Policy {
    return this.o.policy;
  }

  async snapshot(extra: readonly string[] = []): Promise<VenueSnapshot> {
    const names = [...new Set([...this.o.policy.markets, ...extra])];
    const snap = await this.o.venue.snapshot(names);
    this.last = snap;
    const live = new Set(snap.orders.map((x) => x.orderId));
    for (const id of [...this.tracked.keys()]) if (!live.has(id)) this.tracked.delete(id);
    return snap;
  }

  lastSnapshot(): VenueSnapshot | undefined {
    return this.last;
  }

  private ts(): number {
    return this.o.now();
  }

  /** Run one intent through the gate and, when it passes, to the venue. */
  async submit(intent: OrderIntent): Promise<SubmitResult> {
    // Agents can hand over untyped data. A malformed intent never reaches the venue, not even for sizing,
    // and its receipt records a sanitised copy.
    const wellFormed = isWellFormed(intent);
    const loose: unknown = intent;
    const name =
      typeof loose === 'object' &&
      loose !== null &&
      typeof (loose as { market?: unknown }).market === 'string'
        ? (loose as { market: string }).market
        : undefined;
    const snap = await this.snapshot(name === undefined ? [] : [name]);
    const market = name === undefined ? undefined : snap.markets[name];
    let sizing;
    if (market !== undefined && wellFormed) {
      try {
        sizing = await this.o.venue.sizing(market, intent);
      } catch {
        sizing = undefined;
      }
    }
    const now = this.ts();
    this.memory = { ...this.memory, killSwitch: this.killSwitch.tripped };
    const decision = evaluate({
      intent,
      policy: this.o.policy,
      market,
      account: snap.account,
      memory: this.memory,
      sizing,
      now,
    });
    let approved = false;
    if (decision.verdict === 'needs_ok' && this.o.approve !== undefined) {
      approved = await this.o.approve(intent, decision);
    }
    const receipt = await this.o.journal.append(
      'decision',
      {
        intent: wellFormed ? intentData(intent) : rawIntentData(intent),
        verdict: decision.verdict,
        message: decision.message,
        codes: decision.codes,
        details: decision.details,
        notional: decision.notional,
        ownerOk: decision.verdict === 'needs_ok' ? approved : undefined,
        venue: { mode: this.o.venue.mode, account: this.o.venue.account, sender: this.o.venue.sender },
        mark: market === undefined ? undefined : { price: market.markPrice, at: market.markUpdatedAt },
        sizing,
        equity: snap.account.equity,
        position: name === undefined ? 0n : (snap.account.positions[name] ?? 0n),
      },
      now,
    );
    const pass = decision.verdict === 'allowed' || approved;
    if (!pass || market === undefined || !wellFormed) return { decision, approved, receipt };

    this.memory = recordAllowed(this.memory, decision, intent, now);
    const result = await this.o.venue.place(market, intent);
    this.memory = recordVenueResult(this.memory, result.ok || result.benign === true);
    if (result.ok && result.orderId !== undefined && result.filled < intent.quantity) {
      this.tracked.set(result.orderId, {
        market: intent.market,
        orderId: result.orderId,
        side: intent.side,
        price: intent.price,
      });
    }
    const exec = await this.o.journal.append(
      'execution',
      {
        action: 'place',
        decision: receipt.hash,
        ok: result.ok,
        txHash: result.txHash,
        orderId: result.orderId,
        filled: result.filled,
        errorName: result.errorName,
        error: result.error,
        benign: result.benign,
      },
      this.ts(),
    );
    return { decision, approved, receipt, execution: { result, receipt: exec } };
  }

  async cancel(order: RestingOrder, why: string): Promise<Receipt> {
    const market =
      this.last?.markets[order.market] ?? (await this.snapshot([order.market])).markets[order.market];
    const r =
      market === undefined
        ? { ok: false, error: 'market not listed' as string }
        : await this.o.venue.cancel(market, order);
    if (r.ok) this.tracked.delete(order.orderId);
    return this.o.journal.append(
      'execution',
      { action: 'cancel', market: order.market, orderId: order.orderId, why, ...r },
      this.ts(),
    );
  }

  /** Feed the latest equity to the kill switch; flatten when it trips. Returns true when it tripped now. */
  async watch(): Promise<boolean> {
    const snap = await this.snapshot();
    const u = onEquity(this.killSwitch, snap.account.equity, this.ts(), this.o.policy);
    this.killSwitch = u.state;
    if (!u.justTripped) return false;
    await this.flatten(u.state.reason ?? 'drawdown');
    return true;
  }

  /** Operator stop: trip now, cancel everything, reduce positions. */
  async kill(reason: string): Promise<FlattenOutcome> {
    this.killSwitch = tripManually(this.killSwitch, this.ts(), reason);
    return this.flatten(this.killSwitch.reason ?? reason);
  }

  /**
   * Infra / error / end-of-session close-out: cancel everything and reduce positions WITHOUT tripping the kill
   * switch. Journals a session_aborted receipt, which does not set the on-chain stop.
   */
  async abort(reason: string): Promise<FlattenOutcome> {
    return this.flatten(reason, 'session_aborted');
  }

  /** Operator re-arm from the current equity. */
  async rearm(): Promise<Receipt> {
    const snap = await this.snapshot();
    this.killSwitch = reset(snap.account.equity);
    this.memory = { ...this.memory, killSwitch: false, consecutiveFailures: 0 };
    return this.o.journal.append('kill_switch', { action: 'rearm', equity: snap.account.equity }, this.ts());
  }

  private async flatten(
    reason: string,
    kind: 'kill_switch' | 'session_aborted' = 'kill_switch',
  ): Promise<FlattenOutcome> {
    const snap = await this.snapshot();
    const plan = planFlatten(this.o.policy, snap.account.positions, snap.orders, snap.markets);
    await this.o.journal.append(
      kind,
      {
        action: kind === 'kill_switch' ? 'trip' : 'abort',
        reason,
        equity: snap.account.equity,
        peakEquity: this.killSwitch.peakEquity,
        cancels: plan.cancels.length,
        reduces: plan.reduces.map(intentData),
        skipped: plan.skipped,
      },
      this.ts(),
    );
    for (const c of plan.cancels)
      await this.cancel(c, kind === 'kill_switch' ? 'kill switch' : 'session close-out');
    const problems: string[] = [];
    for (const r of plan.reduces) {
      // submit reads the account again. A position that shrank since the plan is blocked (NOT_REDUCING)
      // instead of being sent long and flipping, because the pool will not clamp a regular order.
      const sent = await this.submit(r);
      const filled = sent.execution?.result.filled;
      if (sent.execution === undefined) {
        const codes = sent.decision.codes.join(',');
        problems.push(
          `${r.market}: reduce not sent (${sent.decision.verdict}${codes === '' ? '' : ` ${codes}`})`,
        );
      } else if (!sent.execution.result.ok) {
        const name = sent.execution.result.errorName ?? sent.execution.result.error ?? 'rejected';
        problems.push(`${r.market}: venue rejected the reduce (${name})`);
      } else if (filled === undefined || filled < r.quantity) {
        problems.push(
          `${r.market}: partial fill ${(filled ?? 0n).toString()} of ${r.quantity.toString()}; remainder is not closed yet`,
        );
      }
    }
    return { plan, problems };
  }

  head(): Hex | undefined {
    return this.o.journal.receipts.at(-1)?.hash;
  }
}
