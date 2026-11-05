// Rule codes and the only three user-facing verdict wordings.
import type { Verdict } from './types.js';

/** Codes that block the order. Order here is the order they are reported in. */
export const BLOCK_CODES = [
  'INTENT_MALFORMED',
  'KILL_SWITCH_ACTIVE',
  'FAILURE_LOOP',
  'MARKET_NOT_ALLOWED',
  'MARKET_DECIMALS_CHANGED',
  'DECIMALS_MISMATCH',
  'QTY_ZERO',
  'PRICE_ZERO',
  'PRICE_OFF_TICK',
  'QTY_OFF_LOT',
  'QTY_BELOW_MIN',
  'NOT_REDUCING',
  'MARK_UNKNOWN',
  'MARK_STALE',
  'VENUE_UNPRICEABLE',
  'PRICE_FAR_FROM_MARK',
  'ORDER_NOTIONAL_CAP',
  'DAILY_NOTIONAL_CAP',
  'POSITION_CAP',
  'LEVERAGE_CAP',
  'NO_EQUITY',
  'OPEN_ORDERS_CAP',
  'RATE_LIMIT',
  'VENUE_MAX_SIZE',
] as const;

/** Codes that hold the order for the owner's OK. */
export const OK_CODES = ['ABOVE_OK_THRESHOLD', 'NEW_MARKET', 'TAKER_ORDER'] as const;

export type BlockCode = (typeof BLOCK_CODES)[number];
export type OkCode = (typeof OK_CODES)[number];
export type RuleCode = BlockCode | OkCode;

export const ALLOWED_MESSAGE = 'Allowed: within your limits';

export function verdictMessage(verdict: Verdict, codes: readonly string[]): string {
  switch (verdict) {
    case 'allowed':
      return ALLOWED_MESSAGE;
    case 'blocked':
      return `Blocked by your rule: ${codes.join(', ')}`;
    case 'needs_ok':
      return `Needs your OK: ${codes.join(', ')}`;
  }
}
