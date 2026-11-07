// Kill switch: track peak equity, trip on drawdown, then cancel every resting order and reduce every
// position. Pure functions: the runner feeds equity readings in and executes the plan it gets back.
// Reduce orders still go through the gate, which lets a verified reduce pass while the switch is on.
import { isReducing } from '../gate/gate.js';
import type { Policy } from '../gate/policy.js';
import type { MarketSpec, OrderIntent } from '../gate/types.js';
import { deviationBps, floorToGrid, notional } from '../gate/units.js';

export interface KillSwitchState {
  /** Highest equity seen since the last reset, raw USDso (18 dp). */
  readonly peakEquity: bigint;
  readonly tripped: boolean;
  readonly trippedAt?: number;
  readonly reason?: string;
}

export const INITIAL_KILL_SWITCH: KillSwitchState = { peakEquity: 0n, tripped: false };

export interface EquityUpdate {
  readonly state: KillSwitchState;
  /** True only on the reading that trips the switch. */
  readonly justTripped: boolean;
  /** Current drawdown from peak in basis points (rounded down). */
  readonly drawdownBps: bigint;
}

export function drawdownBps(peak: bigint, equity: bigint): bigint {
  if (peak <= 0n || equity >= peak) return 0n;
  return ((peak - equity) * 10_000n) / peak;
}

export function onEquity(state: KillSwitchState, equity: bigint, now: number, policy: Policy): EquityUpdate {
  const peak = equity > state.peakEquity ? equity : state.peakEquity;
  const dd = drawdownBps(peak, equity);
  if (state.tripped) return { state: { ...state, peakEquity: peak }, justTripped: false, drawdownBps: dd };
  if (dd >= BigInt(policy.killSwitch.maxDrawdownBps)) {
    return {
      state: {
        peakEquity: peak,
        tripped: true,
        trippedAt: now,
        reason: `drawdown ${dd} bps from peak (limit ${policy.killSwitch.maxDrawdownBps})`,
      },
      justTripped: true,
      drawdownBps: dd,
    };
  }
  return { state: { peakEquity: peak, tripped: false }, justTripped: false, drawdownBps: dd };
}

/** Manual trip (CLI `kill`), for an operator who wants out now. */
export function tripManually(state: KillSwitchState, now: number, reason: string): KillSwitchState {
  return { ...state, tripped: true, trippedAt: now, reason: `manual: ${reason}` };
}

/** Reset re-arms the switch from the current equity. Only the operator does this, never the agent. */
export function reset(equity: bigint): KillSwitchState {
  return { peakEquity: equity, tripped: false };
}

export interface RestingOrder {
  readonly market: string;
  readonly orderId: bigint;
}

export interface FlattenSkip {
  readonly market: string;
  readonly position: bigint;
  readonly why: string;
  /**
   * True when another pass cannot place a reducing order until the position or the market spec changes.
   * A missing mark is not terminal: the next read may price it.
   */
  readonly terminal: boolean;
}

export interface FlattenPlan {
  readonly cancels: readonly RestingOrder[];
  readonly reduces: readonly OrderIntent[];
  /** Positions that were not given a reducing order, with the reason. */
  readonly skipped: readonly FlattenSkip[];
}

const abs = (v: bigint): bigint => (v < 0n ? -v : v);

/**
 * Largest quantity the pool will accept that does not exceed the position.
 * dreamDEX `placeOrder` has no reduce-only clamp: a size above the position flips it, and a size below
 * `minQuantity` or off `lotSize` reverts (`QuantityBelowMinimum`, `InvalidQuantity`). Rounding up is refused.
 */
export function reducibleQuantity(position: bigint, market: MarketSpec): bigint | undefined {
  const held = abs(position);
  if (held === 0n || market.lotSize <= 0n || market.minQuantity <= 0n) return undefined;
  const qty = floorToGrid(held, market.lotSize);
  if (qty === 0n || qty < market.minQuantity || qty > held) return undefined;
  return qty;
}

function skip(market: string, position: bigint, why: string, terminal: boolean): FlattenSkip {
  return { market, position, why, terminal };
}

function cannotReduceWhy(position: bigint, market: MarketSpec): string {
  const held = abs(position);
  const floored = market.lotSize > 0n ? floorToGrid(held, market.lotSize) : 0n;
  return (
    `no reduce-only order can close it: abs ${held.toString()}, lotSize ${market.lotSize.toString()}, ` +
    `minQuantity ${market.minQuantity.toString()}, largest on-lot size that does not exceed the position is ${floored.toString()}. ` +
    `The pool rejects QuantityBelowMinimum and InvalidQuantity, and a regular order has no reduce-only clamp, ` +
    `so rounding the size up to the minimum would flip the position and increase exposure. Not sent. The account is not flat.`
  );
}

/**
 * Exit price for a reduce: an IOC that crosses the book by up to `bandBps` from mark, kept on the tick grid
 * and inside the gate's price band. Selling a long rounds the price up, buying back a short rounds down,
 * so the rounding never widens past the band.
 */
export function exitPrice(mark: bigint, tick: bigint, sellToClose: boolean, bandBps: number): bigint {
  const b = BigInt(bandBps);
  if (sellToClose) {
    const raw = (mark * (10_000n - b) + 9_999n) / 10_000n;
    const up = floorToGrid(raw + tick - 1n, tick);
    return up > mark ? floorToGrid(mark, tick) : up;
  }
  return floorToGrid((mark * (10_000n + b)) / 10_000n, tick);
}

/** Band used for exits: wide enough to fill, one bps inside the gate's own limit. */
export function exitBandBps(policy: Policy): number {
  return Math.max(1, Math.min(200, policy.maxPriceDeviationBps - 1));
}

export function planFlatten(
  policy: Policy,
  positions: Readonly<Record<string, bigint>>,
  orders: readonly RestingOrder[],
  markets: Readonly<Record<string, MarketSpec>>,
  agent = 'kill-switch',
): FlattenPlan {
  const reduces: OrderIntent[] = [];
  const skipped: FlattenSkip[] = [];
  for (const [name, pos] of Object.entries(positions).sort(([a], [b]) => a.localeCompare(b))) {
    if (pos === 0n) continue;
    if (!policy.killSwitch.flattenPositions) {
      skipped.push(
        skip(
          name,
          pos,
          'policy killSwitch.flattenPositions is off, so no reduce is sent. The account is not flat.',
          true,
        ),
      );
      continue;
    }
    const m = markets[name];
    if (m === undefined || m.markPrice <= 0n) {
      skipped.push(
        skip(
          name,
          pos,
          'no mark price to price the exit. Not sent. The account is not flat until a priced reduce fills or the position reads as zero.',
          false,
        ),
      );
      continue;
    }
    if (m.lotSize <= 0n || m.tickSize <= 0n || m.minQuantity <= 0n) {
      skipped.push(
        skip(
          name,
          pos,
          'market spec cannot size an order (lot, tick, or minQuantity is not positive). Not sent. The account is not flat.',
          true,
        ),
      );
      continue;
    }
    const qty = reducibleQuantity(pos, m);
    if (qty === undefined) {
      skipped.push(skip(name, pos, cannotReduceWhy(pos, m), true));
      continue;
    }
    const sell = pos > 0n;
    const price = exitPrice(m.markPrice, m.tickSize, sell, exitBandBps(policy));
    if (price <= 0n) {
      skipped.push(skip(name, pos, 'exit price rounded to zero. Not sent. The account is not flat.', true));
      continue;
    }
    if (deviationBps(price, m.markPrice) > BigInt(policy.maxPriceDeviationBps)) {
      skipped.push(
        skip(
          name,
          pos,
          'tick is too coarse for the price band, so no exit price stays inside the guard limit. Not sent. The account is not flat.',
          true,
        ),
      );
      continue;
    }
    if (notional(price, qty, m.baseDecimals) <= 0n) {
      skipped.push(
        skip(
          name,
          pos,
          `reduce of ${qty.toString()} at ${price.toString()} has quote value 0, which the pool rejects as ZeroQuoteFillsAllowed. ` +
            'A larger size would exceed the position and flip it, because a regular order has no reduce-only clamp. Not sent. The account is not flat.',
          true,
        ),
      );
      continue;
    }
    const intent: OrderIntent = {
      market: name,
      side: sell ? 'short' : 'long',
      orderType: 'ioc',
      price,
      quantity: qty,
      reduceOnly: true,
      agent,
      reason: 'kill switch: reduce position',
    };
    // The gate is the only reduce-only check. An order it would reject as NOT_REDUCING is not sent.
    if (!isReducing(pos, intent)) {
      skipped.push(
        skip(name, pos, 'order would not shrink the position. Not sent. The account is not flat.', true),
      );
      continue;
    }
    reduces.push(intent);
  }
  return { cancels: [...orders], reduces, skipped };
}
