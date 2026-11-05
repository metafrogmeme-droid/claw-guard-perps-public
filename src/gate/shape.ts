// Runtime shape check of an order intent. The TypeScript types only hold for agents compiled with this repo;
// untyped agent output (JSON from an LLM, a script) can carry anything. The gate runs this first.
import type { OrderIntent } from './types.js';

const SIDES: readonly string[] = ['long', 'short'];
const ORDER_TYPES: readonly string[] = ['limit', 'post_only', 'ioc'];
const KEYS: ReadonlySet<string> = new Set([
  'market',
  'side',
  'orderType',
  'price',
  'quantity',
  'reduceOnly',
  'agent',
  'reason',
  'assumedBaseDecimals',
]);

export interface ShapeCheck {
  /** Problems that make every later rule meaningless (wrong type, unknown enum, missing field). */
  readonly fatal: readonly string[];
  /** Well-typed but out-of-range values. Later rules still run and add their own codes. */
  readonly values: readonly string[];
}

const describe = (v: unknown): string =>
  v === null ? 'null' : typeof v === 'string' ? `"${v.slice(0, 40)}"` : typeof v;

export function checkShape(raw: unknown): ShapeCheck {
  const fatal: string[] = [];
  const values: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { fatal: [`intent must be an object, got ${describe(raw)}`], values };
  }
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!KEYS.has(k)) fatal.push(`unknown field "${k.slice(0, 40)}"`);
  const { market, side, orderType, price, quantity, reduceOnly, agent, reason, assumedBaseDecimals } = o;
  if (typeof market !== 'string') fatal.push(`market must be a string, got ${describe(market)}`);
  if (typeof side !== 'string' || !SIDES.includes(side))
    fatal.push(`side must be "long" or "short", got ${describe(side)}`);
  if (typeof orderType !== 'string' || !ORDER_TYPES.includes(orderType))
    fatal.push(`orderType must be one of ${ORDER_TYPES.join(', ')}, got ${describe(orderType)}`);
  if (typeof price !== 'bigint') fatal.push(`price must be a bigint (raw units), got ${describe(price)}`);
  else if (price <= 0n) values.push('price must be positive');
  if (typeof quantity !== 'bigint')
    fatal.push(`quantity must be a bigint (raw units), got ${describe(quantity)}`);
  else if (quantity <= 0n) values.push('quantity must be positive');
  if (typeof reduceOnly !== 'boolean')
    fatal.push(`reduceOnly must be true or false, got ${describe(reduceOnly)}`);
  if (typeof agent !== 'string') fatal.push(`agent must be a string, got ${describe(agent)}`);
  if (reason !== undefined && typeof reason !== 'string')
    fatal.push(`reason must be a string, got ${describe(reason)}`);
  if (assumedBaseDecimals !== undefined) {
    if (typeof assumedBaseDecimals !== 'number' || !Number.isInteger(assumedBaseDecimals))
      fatal.push(`assumedBaseDecimals must be a whole number, got ${describe(assumedBaseDecimals)}`);
    else if (assumedBaseDecimals < 0) values.push('assumedBaseDecimals must not be negative');
  }
  return { fatal, values };
}

/** A receipt-ready copy of whatever the agent sent: JSON-able values kept, anything else replaced by its type. */
export function rawIntentData(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { malformed: describe(raw) };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 32)) {
    const key = k.slice(0, 40);
    if (typeof v === 'bigint' || typeof v === 'boolean') out[key] = v;
    else if (typeof v === 'string') out[key] = v.slice(0, 200);
    else if (typeof v === 'number') out[key] = Number.isFinite(v) ? v : String(v);
    else if (v !== undefined) out[key] = `<${describe(v)}>`;
  }
  return out;
}

/** Narrowing helper for callers that hold an intent of unknown origin. */
export function isWellFormed(raw: unknown): raw is OrderIntent {
  return checkShape(raw).fatal.length === 0;
}
