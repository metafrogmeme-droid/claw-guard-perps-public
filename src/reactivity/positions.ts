// Somnia Reactivity on the venue itself: every MarginBank PositionUpdated for the traded account is pushed to the
// guard the moment its block lands (`somnia_watch`, filtered on topic1 = account). The guard re-checks the new
// position against the policy without waiting for the next poll:
//   - a position in a market the policy does not list        -> Blocked by your rule: UNKNOWN_MARKET
//   - a non-zero position while the stop is on              -> Blocked by your rule: WHILE_STOPPED
//   - a position worth more than maxPositionNotionalUsd     -> Blocked by your rule: POSITION_CAP
// Any of these calls onBreach (the CLI trips the kill switch: cancel resting orders, reduce positions). A fill
// from a resting maker order, or a trade by another key on the same account, is caught the same way.
import { decodeEventLog, pad, parseAbi, toEventSelector, type Hex } from 'viem';

import type { Policy } from '../gate/policy.js';
import { formatDecimal, notional } from '../gate/units.js';

const usd2 = (raw: bigint): string => {
  const [i = '0', f = ''] = formatDecimal(raw, 18).split('.');
  return `${i}.${(f + '00').slice(0, 2)} USD`;
};
import type { RawNotification, ReactivityTransport, Subscription, WatchParams } from './watch.js';

export const POSITION_UPDATED = toEventSelector(
  'PositionUpdated(address,address,int128,uint128,int256,int256)',
);

const BANK_ABI = parseAbi([
  'event PositionUpdated(address indexed account, address indexed perpPool, int128 newSize, uint128 avgEntryPrice, int256 realizedPnl, int256 entryFundingIndex)',
]);

export function positionWatchParams(marginBank: Hex, account: Hex): WatchParams {
  return {
    address: marginBank,
    topics: [[POSITION_UPDATED], pad(account.toLowerCase() as Hex)],
    eth_calls: [],
    context: [],
    push_changes_only: false,
  };
}

export interface PositionEvent {
  readonly account: Hex;
  readonly pool: Hex;
  readonly newSize: bigint;
  readonly avgEntryPrice: bigint;
  readonly realizedPnl: bigint;
}

export function decodePosition(n: RawNotification): PositionEvent | undefined {
  try {
    const ev = decodeEventLog({ abi: BANK_ABI, topics: n.topics as [Hex, ...Hex[]], data: n.data });
    return {
      account: ev.args.account,
      pool: ev.args.perpPool,
      newSize: ev.args.newSize,
      avgEntryPrice: ev.args.avgEntryPrice,
      realizedPnl: ev.args.realizedPnl,
    };
  } catch {
    return undefined;
  }
}

export interface GuardMarket {
  readonly market: string;
  readonly baseDecimals: number;
  readonly markPrice: bigint;
}

export interface PositionVerdict {
  readonly code: 'OK' | 'UNKNOWN_MARKET' | 'WHILE_STOPPED' | 'POSITION_CAP';
  readonly message: string;
}

export function judgePosition(
  ev: PositionEvent,
  m: GuardMarket | undefined,
  policy: Policy,
  stopped: boolean,
): PositionVerdict {
  if (ev.newSize === 0n) return { code: 'OK', message: 'Allowed: within your limits (flat)' };
  if (m === undefined || !policy.markets.includes(m.market)) {
    return {
      code: 'UNKNOWN_MARKET',
      message: `Blocked by your rule: UNKNOWN_MARKET (position in pool ${ev.pool}, not in your market list)`,
    };
  }
  if (stopped) {
    return {
      code: 'WHILE_STOPPED',
      message: `Blocked by your rule: WHILE_STOPPED (${m.market} position while the stop is on)`,
    };
  }
  const abs = ev.newSize < 0n ? -ev.newSize : ev.newSize;
  const px = m.markPrice > 0n ? m.markPrice : ev.avgEntryPrice;
  const value = notional(px, abs, m.baseDecimals);
  if (value > policy.maxPositionNotionalUsd) {
    return {
      code: 'POSITION_CAP',
      message: `Blocked by your rule: POSITION_CAP (${m.market} position ${usd2(value)}, limit ${usd2(policy.maxPositionNotionalUsd)})`,
    };
  }
  return { code: 'OK', message: `Allowed: within your limits (${m.market} ${usd2(value)})` };
}

export interface PositionGuardOptions {
  readonly transport: ReactivityTransport;
  readonly marginBank: Hex;
  readonly account: Hex;
  readonly policy: Policy;
  /** Pool address (any case) -> market facts. */
  readonly market: (pool: Hex) => GuardMarket | undefined;
  readonly stopped: () => boolean;
  readonly onBreach: (v: PositionVerdict, ev: PositionEvent) => Promise<void>;
  readonly onEvent?: (ev: PositionEvent, v: PositionVerdict) => void;
  readonly log?: (line: string) => void;
}

export class PositionGuard {
  readonly events: PositionEvent[] = [];
  breaches = 0;
  private sub: Subscription | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: PositionGuardOptions) {}

  async start(): Promise<void> {
    this.sub = await this.o.transport.subscribe(positionWatchParams(this.o.marginBank, this.o.account), {
      onData: (n) => {
        this.push(n);
      },
      onConnect: () => this.o.log?.(`[positions] subscribed to PositionUpdated for ${this.o.account}`),
      onError: (e) => this.o.log?.(`[positions] ${e.message}`),
    });
  }

  async stop(): Promise<void> {
    await this.sub?.unsubscribe();
    await this.idle();
  }

  idle(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  push(n: RawNotification): void {
    const ev = decodePosition(n);
    if (ev?.account.toLowerCase() !== this.o.account.toLowerCase()) return;
    this.events.push(ev);
    const v = judgePosition(ev, this.o.market(ev.pool), this.o.policy, this.o.stopped());
    this.o.onEvent?.(ev, v);
    if (v.code === 'OK') return;
    this.breaches += 1;
    const run = this.queue.then(() => this.o.onBreach(v, ev));
    this.queue = run.catch((e: unknown) => {
      this.o.log?.(`[positions] reaction failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  }
}
