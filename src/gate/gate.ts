// The pre-trade gate. Pure function: (intent, policy, market, account, memory, venue sizing, now) -> Decision.
// Every rule is evaluated and every firing rule is reported, so a receipt shows all reasons, not just the first.
import { BLOCK_CODES, OK_CODES, verdictMessage, type RuleCode } from './codes.js';
import type { Policy } from './policy.js';
import type { AccountState, Decision, GateMemory, MarketSpec, OrderIntent, VenueSizing } from './types.js';
import { checkShape } from './shape.js';
import { deviationBps, formatDecimal, notional, onGrid, PRICE_DECIMALS } from './units.js';

export interface GateInput {
  readonly intent: OrderIntent;
  readonly policy: Policy;
  /** Undefined when the venue does not list the market. */
  readonly market: MarketSpec | undefined;
  readonly account: AccountState;
  readonly memory: GateMemory;
  /** The venue's own sizing answer. Undefined when it could not be read (treated as unpriceable). */
  readonly sizing: VenueSizing | undefined;
  /** Unix seconds. */
  readonly now: number;
}

const RATE_WINDOW_SEC = 60;

export function utcDay(nowSec: number): string {
  return new Date(nowSec * 1000).toISOString().slice(0, 10);
}

const fmtUsd = (raw: bigint): string => `${formatDecimal(raw, PRICE_DECIMALS)} USD`;

/** Signed position change of an order: long adds, short subtracts. */
export function signedQty(intent: Pick<OrderIntent, 'side' | 'quantity'>): bigint {
  return intent.side === 'long' ? intent.quantity : -intent.quantity;
}

/** True when the order moves the position toward zero and never past it. */
export function isReducing(position: bigint, intent: Pick<OrderIntent, 'side' | 'quantity'>): boolean {
  if (position === 0n || intent.quantity <= 0n) return false;
  const after = position + signedQty(intent);
  const abs = (v: bigint): bigint => (v < 0n ? -v : v);
  const sameSignOrZero = after === 0n || after > 0n === position > 0n;
  return sameSignOrZero && abs(after) < abs(position);
}

export function evaluate(input: GateInput): Decision {
  const { intent, policy, market, account, memory, sizing, now } = input;
  const fired = new Map<RuleCode, string>();
  const fire = (code: RuleCode, detail: string): void => {
    if (!fired.has(code)) fired.set(code, detail);
  };

  // 0. Shape. A wrong type or an unknown side/order type makes every later rule meaningless: stop here.
  const shape = checkShape(intent);
  if (shape.fatal.length > 0) {
    fire('INTENT_MALFORMED', shape.fatal.join('; '));
    return decide(fired, 0n);
  }
  if (shape.values.length > 0) fire('INTENT_MALFORMED', shape.values.join('; '));

  const position = account.positions[intent.market] ?? 0n;
  const reducing = isReducing(position, intent);

  // 1. Global stops. A reducing order still passes the kill switch: it is how the account gets flat.
  if (memory.killSwitch && !reducing)
    fire('KILL_SWITCH_ACTIVE', 'kill switch is on; only reducing orders pass');
  if (memory.consecutiveFailures >= policy.maxConsecutiveFailures) {
    fire(
      'FAILURE_LOOP',
      `${memory.consecutiveFailures} venue failures in a row (limit ${policy.maxConsecutiveFailures})`,
    );
  }

  // 2. Market identity and scale. Nothing else is meaningful if these fail.
  const allowed = policy.markets.includes(intent.market);
  if (!allowed) fire('MARKET_NOT_ALLOWED', `${intent.market} is not in your market list`);
  if (market === undefined) {
    if (allowed) fire('MARK_UNKNOWN', `${intent.market} is not listed on the venue`);
    return decide(fired, 0n);
  }
  const pinned = policy.pinnedBaseDecimals[intent.market];
  if (pinned !== undefined && pinned !== market.baseDecimals) {
    fire(
      'MARKET_DECIMALS_CHANGED',
      `venue says ${market.baseDecimals} base decimals, your policy pins ${pinned}`,
    );
  }
  if (intent.assumedBaseDecimals !== undefined && intent.assumedBaseDecimals !== market.baseDecimals) {
    fire(
      'DECIMALS_MISMATCH',
      `agent scaled quantity with ${intent.assumedBaseDecimals} decimals, ${intent.market} uses ${market.baseDecimals}`,
    );
  }

  // 3. Grid. The pool rejects these, sometimes without a readable reason.
  if (intent.quantity <= 0n) fire('QTY_ZERO', 'quantity must be positive');
  if (intent.price <= 0n) fire('PRICE_ZERO', 'price must be positive');
  if (intent.price > 0n && !onGrid(intent.price, market.tickSize)) {
    fire('PRICE_OFF_TICK', `price ${intent.price} is not a multiple of tickSize ${market.tickSize}`);
  }
  if (intent.quantity > 0n && !onGrid(intent.quantity, market.lotSize)) {
    fire('QTY_OFF_LOT', `quantity ${intent.quantity} is not a multiple of lotSize ${market.lotSize}`);
  }
  if (intent.quantity > 0n && intent.quantity < market.minQuantity) {
    fire('QTY_BELOW_MIN', `quantity ${intent.quantity} is below minQuantity ${market.minQuantity}`);
  }
  if (intent.reduceOnly && !reducing)
    fire('NOT_REDUCING', 'marked reduce-only but does not shrink the position');

  // 4. Price sanity against a fresh mark. Reducing orders are exempt from staleness: the venue keeps the exit
  //    open during an oracle outage, and so does the gate.
  const markAge = now - market.markUpdatedAt;
  if (market.markPrice <= 0n) {
    fire('MARK_UNKNOWN', 'no mark price');
  } else {
    if (!reducing && markAge > policy.maxMarkAgeSec) {
      fire('MARK_STALE', `mark is ${markAge}s old (limit ${policy.maxMarkAgeSec}s)`);
    }
    if (intent.price > 0n) {
      const dev = deviationBps(intent.price, market.markPrice);
      if (dev > BigInt(policy.maxPriceDeviationBps)) {
        fire('PRICE_FAR_FROM_MARK', `price is ${dev} bps from mark (limit ${policy.maxPriceDeviationBps})`);
      }
    }
  }
  if (!reducing && sizing?.priceable !== true) {
    fire('VENUE_UNPRICEABLE', 'venue cannot size this order right now (stale or missing mark)');
  }

  // 5. Money caps. A verified reduce adds no exposure, so it is not counted against opening caps.
  const orderNotional =
    intent.price > 0n && intent.quantity > 0n
      ? notional(intent.price, intent.quantity, market.baseDecimals)
      : 0n;
  const opening = reducing ? 0n : orderNotional;
  if (opening > policy.maxOrderNotionalUsd) {
    fire('ORDER_NOTIONAL_CAP', `order is ${fmtUsd(opening)} (limit ${fmtUsd(policy.maxOrderNotionalUsd)})`);
  }
  const usedToday = memory.day === utcDay(now) ? memory.dailyNotional : 0n;
  if (opening > 0n && usedToday + opening > policy.maxDailyNotionalUsd) {
    fire(
      'DAILY_NOTIONAL_CAP',
      `today ${fmtUsd(usedToday)} + ${fmtUsd(opening)} exceeds ${fmtUsd(policy.maxDailyNotionalUsd)}`,
    );
  }
  if (!reducing && opening > 0n) {
    const mark = market.markPrice > 0n ? market.markPrice : intent.price;
    const after = position + signedQty(intent);
    const absAfter = after < 0n ? -after : after;
    const posNotional = notional(mark, absAfter, market.baseDecimals);
    if (posNotional > policy.maxPositionNotionalUsd) {
      fire(
        'POSITION_CAP',
        `position would be ${fmtUsd(posNotional)} (limit ${fmtUsd(policy.maxPositionNotionalUsd)})`,
      );
    }
    if (account.equity <= 0n) {
      fire('NO_EQUITY', 'account has no equity');
    } else {
      // gross/equity > maxLeverage, compared exactly with the leverage as a 1e4-scaled integer.
      const levScaled = BigInt(Math.round(policy.maxLeverage * 10_000));
      const gross = account.grossNotional + opening;
      if (gross * 10_000n > account.equity * levScaled) {
        fire(
          'LEVERAGE_CAP',
          `gross ${fmtUsd(gross)} on equity ${fmtUsd(account.equity)} is above ${policy.maxLeverage}x`,
        );
      }
    }
  }

  // 6. Flow limits: resting orders, rate, venue's own size answer.
  if (intent.orderType !== 'ioc' && account.openOrders >= policy.maxOpenOrders) {
    fire('OPEN_ORDERS_CAP', `${account.openOrders} resting orders (limit ${policy.maxOpenOrders})`);
  }
  const recent = memory.recentOrders.filter((t) => now - t < RATE_WINDOW_SEC).length;
  if (recent >= policy.maxOrdersPerMinute) {
    fire('RATE_LIMIT', `${recent} orders in the last minute (limit ${policy.maxOrdersPerMinute})`);
  }
  if (sizing?.priceable === true && (!sizing.placeable || intent.quantity > sizing.maxQuantity)) {
    fire(
      'VENUE_MAX_SIZE',
      `venue accepts at most ${sizing.maxQuantity} (limited by ${sizing.limitedBy ?? 'unknown'})`,
    );
  }

  // 7. Owner-OK holds (only matter when nothing blocks).
  if (opening > policy.needsOkAboveNotionalUsd) {
    fire(
      'ABOVE_OK_THRESHOLD',
      `order is ${fmtUsd(opening)}, your OK line is ${fmtUsd(policy.needsOkAboveNotionalUsd)}`,
    );
  }
  if (policy.needsOkOnNewMarket && !reducing && !memory.seenMarkets.includes(intent.market)) {
    fire('NEW_MARKET', `first order on ${intent.market}`);
  }
  if (policy.needsOkForTaker && intent.orderType === 'ioc' && !reducing) {
    fire('TAKER_ORDER', 'taker (IOC) orders need your OK');
  }

  return decide(fired, opening);
}

function decide(fired: ReadonlyMap<RuleCode, string>, opening: bigint): Decision {
  const blocking = BLOCK_CODES.filter((c) => fired.has(c));
  const holds = OK_CODES.filter((c) => fired.has(c));
  const details: Record<string, string> = {};
  for (const [k, v] of fired) details[k] = v;
  if (blocking.length > 0) {
    return {
      verdict: 'blocked',
      codes: blocking,
      message: verdictMessage('blocked', blocking),
      notional: opening,
      details,
    };
  }
  if (holds.length > 0) {
    return {
      verdict: 'needs_ok',
      codes: holds,
      message: verdictMessage('needs_ok', holds),
      notional: opening,
      details,
    };
  }
  return {
    verdict: 'allowed',
    codes: [],
    message: verdictMessage('allowed', []),
    notional: opening,
    details,
  };
}

export const EMPTY_MEMORY: GateMemory = {
  day: '1970-01-01',
  dailyNotional: 0n,
  recentOrders: [],
  consecutiveFailures: 0,
  killSwitch: false,
  seenMarkets: [],
};

/** Memory after an order was let through (allowed, or approved by the owner). */
export function recordAllowed(
  memory: GateMemory,
  decision: Decision,
  intent: OrderIntent,
  now: number,
): GateMemory {
  const day = utcDay(now);
  const base = memory.day === day ? memory.dailyNotional : 0n;
  return {
    ...memory,
    day,
    dailyNotional: base + decision.notional,
    recentOrders: [...memory.recentOrders.filter((t) => now - t < RATE_WINDOW_SEC), now],
    seenMarkets: memory.seenMarkets.includes(intent.market)
      ? memory.seenMarkets
      : [...memory.seenMarkets, intent.market],
  };
}

/** Memory after the venue answered an order that the gate let through. */
export function recordVenueResult(memory: GateMemory, ok: boolean): GateMemory {
  return { ...memory, consecutiveFailures: ok ? 0 : memory.consecutiveFailures + 1 };
}
