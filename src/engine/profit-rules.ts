// Session rule 2: profit rules. Bot-side and stricter only: they decide which quotes are worth asking for and
// when a session has lost enough; they never change a guard limit.
//
//  - quote only with edge: an opening quote must cover a round trip of maker fees plus a minimum edge
//    (makerFeeBps, minEdgeBps; applied inside the skew maker);
//  - post-only maker: any opening intent that is not post_only is dropped before the guard sees it;
//  - per trade: take-profit (takeProfitBps) and stop-loss (stopBps, from #22) switch a position to a
//    reduce-only post_only exit;
//  - per session: once equity is maxSessionLossUsd below the session start, the session stops quoting and runs
//    the normal close-out (session_aborted, never an on-chain stop). Far inside the guard's drawdown stop.
import { z } from 'zod';

import type { OrderIntent } from '../gate/types.js';
import { formatDecimal, usd } from '../gate/units.js';
import { DEFAULT_SKEW, type SkewMakerConfig } from './skew-maker.js';

const usdString = z
  .string()
  .regex(/^\d+(\.\d{1,18})?$/, 'a USD amount like "1" or "0.5"')
  .transform((s) => usd(s))
  .refine((v) => v > 0n, 'must be above 0');

/** `--skew-config` file: the skew maker's quoting shape plus its per-trade exits. Strict and bounded. */
export const SkewConfigSchema = z
  .object({
    halfSpreadBps: z.number().int().min(1).max(500).default(DEFAULT_SKEW.halfSpreadBps),
    requoteBps: z.number().int().min(1).max(500).default(DEFAULT_SKEW.requoteBps),
    skewBps: z.number().int().min(0).max(500).default(DEFAULT_SKEW.skewBps),
    stopBps: z.number().int().min(1).max(2000).default(DEFAULT_SKEW.stopBps),
    maxHoldSec: z.number().int().min(60).max(86_400).default(DEFAULT_SKEW.maxHoldSec),
    volHalfSpreadBps: z.number().int().min(1).max(500).default(DEFAULT_SKEW.volHalfSpreadBps),
    volJumpBps: z.number().int().min(0).max(2000).default(DEFAULT_SKEW.volJumpBps),
    volWindow: z.number().int().min(2).max(100).default(DEFAULT_SKEW.volWindow),
    exitRequoteBps: z.number().int().min(0).max(500).default(DEFAULT_SKEW.exitRequoteBps),
    focusHeavy: z.boolean().default(DEFAULT_SKEW.focusHeavy),
  })
  .strict();

export type SkewShape = z.output<typeof SkewConfigSchema>;

export function parseSkewConfig(input: unknown): SkewShape {
  return SkewConfigSchema.parse(input ?? {});
}

/** `profit` section of the session rules file. */
export const ProfitRulesSchema = z
  .object({
    /** Assumed maker fee per fill, bps. */
    makerFeeBps: z.number().min(0).max(100).default(DEFAULT_SKEW.makerFeeBps),
    /** Edge an opening quote keeps after a round trip of maker fees, bps. */
    minEdgeBps: z.number().min(0).max(500).default(DEFAULT_SKEW.minEdgeBps),
    /** Per-trade take-profit, bps from entry. 0 = off. */
    takeProfitBps: z.number().int().min(0).max(2000).default(DEFAULT_SKEW.takeProfitBps),
    /** Stop quoting and close out once the session is down this much, USD. */
    maxSessionLossUsd: usdString.default(usd('1')),
    /** Drop any opening intent that is not post_only. */
    postOnly: z.boolean().default(true),
  })
  .strict();

export type ProfitRules = z.output<typeof ProfitRulesSchema>;

export const DEFAULT_PROFIT_RULES: ProfitRules = ProfitRulesSchema.parse({});

export function parseProfitRules(input: unknown): ProfitRules {
  return ProfitRulesSchema.parse(input ?? {});
}

/** The skew maker's profit fields from the rules. */
export function skewProfitFields(
  r: ProfitRules,
): Pick<SkewMakerConfig, 'makerFeeBps' | 'minEdgeBps' | 'takeProfitBps'> {
  return { makerFeeBps: r.makerFeeBps, minEdgeBps: r.minEdgeBps, takeProfitBps: r.takeProfitBps };
}

/** Maker only: keeps reduce-only intents and post_only openings, drops the rest. */
export function makerOnly(
  intents: readonly OrderIntent[],
  r: Pick<ProfitRules, 'postOnly'>,
): { readonly kept: readonly OrderIntent[]; readonly dropped: readonly OrderIntent[] } {
  if (!r.postOnly) return { kept: intents, dropped: [] };
  const kept: OrderIntent[] = [];
  const dropped: OrderIntent[] = [];
  for (const i of intents) (i.reduceOnly || i.orderType === 'post_only' ? kept : dropped).push(i);
  return { kept, dropped };
}

/** Stop reason when the session lost maxSessionLossUsd or more since its start, else undefined. */
export function sessionLossStop(
  startEquity: bigint,
  equity: bigint,
  r: Pick<ProfitRules, 'maxSessionLossUsd'>,
): string | undefined {
  const loss = startEquity - equity;
  if (loss < r.maxSessionLossUsd) return undefined;
  return `session loss limit: -${formatDecimal(loss, 18)} USDso (limit ${formatDecimal(r.maxSessionLossUsd, 18)})`;
}
