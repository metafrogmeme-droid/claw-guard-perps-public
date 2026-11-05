// Kill switch: track peak equity, trip on drawdown, then cancel every resting order and reduce every
// position. Pure functions: the runner feeds equity readings in and executes the plan it gets back.
// Reduce orders still go through the gate, which lets a verified reduce pass while the switch is on.
import type { Policy } from '../gate/policy.js';
import type { MarketSpec, OrderIntent } from '../gate/types.js';
import { deviationBps, floorToGrid } from '../gate/units.js';

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

export interface FlattenPlan {
  readonly cancels: readonly RestingOrder[];
  readonly reduces: readonly OrderIntent[];
  /** Positions that cannot be reduced by an order (dust below minQuantity, or no mark). */
  readonly skipped: readonly { readonly market: string; readonly position: bigint; readonly why: string }[];
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
  const skipped: { market: string; position: bigint; why: string }[] = [];
  if (policy.killSwitch.flattenPositions) {
    for (const [name, pos] of Object.entries(positions).sort(([a], [b]) => a.localeCompare(b))) {
      if (pos === 0n) continue;
      const m = markets[name];
      if (m === undefined || m.markPrice <= 0n) {
        skipped.push({ market: name, position: pos, why: 'no mark price to price the exit' });
        continue;
      }
      const qty = floorToGrid(pos < 0n ? -pos : pos, m.lotSize);
      if (qty < m.minQuantity || qty === 0n) {
        skipped.push({ market: name, position: pos, why: 'below the venue minimum order size' });
        continue;
      }
      const sell = pos > 0n;
      const price = exitPrice(m.markPrice, m.tickSize, sell, exitBandBps(policy));
      if (deviationBps(price, m.markPrice) > BigInt(policy.maxPriceDeviationBps)) {
        skipped.push({ market: name, position: pos, why: 'tick is too coarse for the price band' });
        continue;
      }
      reduces.push({
        market: name,
        side: sell ? 'short' : 'long',
        orderType: 'ioc',
        price,
        quantity: qty,
        reduceOnly: true,
        agent,
        reason: 'kill switch: reduce position',
      });
    }
  }
  return { cancels: [...orders], reduces, skipped };
}
