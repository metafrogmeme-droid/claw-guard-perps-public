// The owner's limits. Written in USD decimal strings in JSON, parsed to exact raw units.
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { usd } from './units.js';

const usdString = z
  .string()
  .regex(/^\d+(\.\d{1,18})?$/, 'a USD amount like "25" or "12.5"')
  .transform((s) => usd(s));

const marketName = z.string().regex(/^[A-Z0-9]+-PERP$/, 'a market like "BTC-PERP"');

export const PolicySchema = z
  .object({
    version: z.literal(1),
    /** Only these markets may be traded. */
    markets: z.array(marketName).min(1),
    /** Pinned base decimals per market. A mismatch with the venue blocks (catches a swapped market row). */
    pinnedBaseDecimals: z.record(marketName, z.number().int().min(0).max(36)).default({}),
    maxOrderNotionalUsd: usdString,
    maxDailyNotionalUsd: usdString,
    /** Max |position| notional per market after the order fills. */
    maxPositionNotionalUsd: usdString,
    /** Max gross notional / equity after the order fills. */
    maxLeverage: z.number().positive().max(100),
    maxOpenOrders: z.number().int().positive(),
    /** Mark older than this is stale: opening orders are blocked. */
    maxMarkAgeSec: z.number().int().positive(),
    /** Limit price further than this from the mark is blocked. */
    maxPriceDeviationBps: z.number().int().positive().max(10_000),
    maxOrdersPerMinute: z.number().int().positive(),
    /** Venue failures in a row before the gate stops sending (revert-loop guard). */
    maxConsecutiveFailures: z.number().int().positive(),
    /** Orders above this notional need the owner's OK, even when inside every cap. */
    needsOkAboveNotionalUsd: usdString,
    /** First order on a market needs the owner's OK. */
    needsOkOnNewMarket: z.boolean().default(false),
    /** Taker (IOC) orders need the owner's OK. */
    needsOkForTaker: z.boolean().default(false),
    killSwitch: z.object({
      /** Drawdown from peak equity that trips the kill switch, in bps. */
      maxDrawdownBps: z.number().int().positive().max(10_000),
      /** What the kill switch does: cancel resting orders, and optionally reduce positions to zero. */
      flattenPositions: z.boolean(),
    }),
  })
  .strict();

export type Policy = z.output<typeof PolicySchema>;
export type PolicyInput = z.input<typeof PolicySchema>;

export function parsePolicy(input: unknown): Policy {
  return PolicySchema.parse(input);
}

/** Canonical JSON of a policy input (sorted keys), so the same limits always hash the same. */
export function canonicalJson(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}

/** sha256 of the canonical parsed policy, 0x-prefixed. Recorded in every receipt. */
export function policyHash(policy: Policy): `0x${string}` {
  return `0x${createHash('sha256').update(canonicalJson(policy)).digest('hex')}`;
}

/** The demo policy: small caps for a testnet bot. */
export const DEMO_POLICY: PolicyInput = {
  version: 1,
  markets: ['BTC-PERP', 'ETH-PERP', 'SOL-PERP'],
  pinnedBaseDecimals: { 'BTC-PERP': 8, 'ETH-PERP': 18, 'SOL-PERP': 9 },
  maxOrderNotionalUsd: '25',
  maxDailyNotionalUsd: '150',
  maxPositionNotionalUsd: '60',
  maxLeverage: 3,
  maxOpenOrders: 6,
  maxMarkAgeSec: 120,
  maxPriceDeviationBps: 300,
  maxOrdersPerMinute: 12,
  maxConsecutiveFailures: 3,
  needsOkAboveNotionalUsd: '20',
  needsOkOnNewMarket: false,
  needsOkForTaker: true,
  killSwitch: { maxDrawdownBps: 500, flattenPositions: true },
};

/** The long live session: two markets, smaller caps, a tighter drawdown stop. */
export const SESSION_POLICY: PolicyInput = {
  ...DEMO_POLICY,
  markets: ['BTC-PERP', 'ETH-PERP'],
  pinnedBaseDecimals: { 'BTC-PERP': 8, 'ETH-PERP': 18 },
  maxOrderNotionalUsd: '15',
  maxDailyNotionalUsd: '400',
  maxPositionNotionalUsd: '40',
  maxLeverage: 2,
  needsOkAboveNotionalUsd: '12',
  killSwitch: { maxDrawdownBps: 200, flattenPositions: true },
};
