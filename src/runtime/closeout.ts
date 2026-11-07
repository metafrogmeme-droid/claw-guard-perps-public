// Guaranteed close-out: cancel every open order, close every position reduce-only, and check the account is
// flat. Every call is time-bounded, it retries a few times inside a total budget, and it never throws: the
// caller gets a result saying flat or NOT flat plus the errors, writes the report, and exits non-zero when
// the account is not flat. Running it on a flat account sends nothing and journals nothing (idempotent).
// A residual the pool cannot reduce without exceeding the position is reported and not retried: another pass
// would send nothing, and rounding the size up would flip the position.
import { z } from 'zod';

import type { Engine, FlattenOutcome } from '../engine/engine.js';
import type { VenueSnapshot } from '../venue/types.js';
import { withTimeout } from './timeout.js';

export const FlattenRetrySchema = z
  .object({
    /** false = no retry phase (the old behaviour). */
    enabled: z.boolean().default(true),
    /** Total time for the retry phase after the first close-out budget, seconds. */
    retryBudgetSec: z.number().positive().max(3600).default(600),
    /** First wait before a retry, seconds; doubles per retry. */
    backoffBaseSec: z.number().positive().max(600).default(5),
    /** Longest wait between retries, seconds. */
    backoffMaxSec: z.number().positive().max(600).default(60),
    /** Bound for one retry pass (snapshot, or cancel-all + reduce-only), seconds. Capped by the budget left. */
    passTimeoutSec: z.number().positive().max(1800).default(180),
    /** Retries in the retry phase. */
    maxRetries: z.number().int().min(1).max(100).default(10),
  })
  .strict()
  .refine((c) => c.backoffMaxSec >= c.backoffBaseSec, 'backoffMaxSec must be >= backoffBaseSec');

export type FlattenRetryConfig = z.output<typeof FlattenRetrySchema>;

export const DEFAULT_FLATTEN_RETRY: FlattenRetryConfig = FlattenRetrySchema.parse({});

export function parseFlattenRetry(input: unknown): FlattenRetryConfig {
  return FlattenRetrySchema.parse(input ?? {});
}

export interface CloseOutOptions {
  readonly reason: string;
  /** Total budget for the whole close-out, in ms. */
  readonly budgetMs: number;
  /** Bound for one engine step (snapshot, or one flatten pass), in ms. */
  readonly stepMs: number;
  readonly attempts: number;
  /** Pause between attempts, in ms (lets a just-sent tx settle before the re-read). */
  readonly pauseMs?: number;
  /** Base backoff after a failed attempt (timeout/error), doubled per failure, capped by the budget. Default 2000. */
  readonly backoffMs?: number;
  /**
   * true: flatten through the kill switch (journals kill_switch -> on-chain stop when anchored). Only for a real
   * guard trip or a manual kill. false (default): journals session_aborted, which never stops on chain.
   */
  readonly stop?: boolean;
  readonly log?: (line: string) => void;
  /** Retry phase after the first budget ends NOT flat (rule 4). Omitted = none. */
  readonly retry?: FlattenRetryConfig;
}

export interface CloseOutResult {
  readonly flat: boolean;
  readonly attempts: number;
  /** Flatten passes that sent cancels / reduce-only orders. 0 when the account was already flat. */
  readonly passes: number;
  readonly openOrders: number;
  readonly positions: Readonly<Record<string, bigint>>;
  readonly errors: readonly string[];
  /** Attempts in the retry phase (0 when the first budget was enough). */
  readonly retries: number;
  /** The last snapshot that could be read, if any. */
  readonly snapshot?: VenueSnapshot;
}

const isFlat = (s: VenueSnapshot): boolean =>
  s.orders.length === 0 && Object.values(s.account.positions).every((p) => p === 0n);

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Record guard/venue problems. Returns true when the pass had nothing to cancel or reduce and every skip
 * is terminal, so further passes cannot close the account.
 */
function noteFlatten(
  result: unknown,
  label: string,
  errors: string[],
  log?: (line: string) => void,
): boolean {
  if (result === null || typeof result !== 'object') return false;
  const outcome = result as Partial<FlattenOutcome>;
  if (Array.isArray(outcome.problems)) {
    for (const p of outcome.problems) if (typeof p === 'string') errors.push(`${label}: ${p}`);
  }
  const plan = outcome.plan;
  if (plan === undefined) return false;
  for (const s of plan.skipped)
    errors.push(`${label}: ${s.market} position ${s.position.toString()}: ${s.why}`);
  if (plan.cancels.length > 0 || plan.reduces.length > 0) return false;
  if (plan.skipped.length === 0 || plan.skipped.some((s) => !s.terminal)) return false;
  log?.(`[close-out] ${label}: residual cannot be closed by a reduce-only order; not retrying`);
  return true;
}

export async function closeOut(engine: Engine, o: CloseOutOptions): Promise<CloseOutResult> {
  const started = Date.now();
  const left = (): number => o.budgetMs - (Date.now() - started);
  const step = <T>(p: Promise<T>, label: string): Promise<T> =>
    withTimeout(p, Math.max(1, Math.min(o.stepMs, left())), label);
  // a flatten pass may use at most half of what is left while attempts remain, so one retry always fits
  const flattenStep = <T>(p: Promise<T>, label: string): Promise<T> => {
    const cap = attempts < o.attempts ? Math.floor(left() / 2) : left();
    return withTimeout(p, Math.max(1, Math.min(o.stepMs, cap)), label);
  };
  const errors: string[] = [];
  let last: VenueSnapshot | undefined;
  let flat = false;
  let attempts = 0;
  let passes = 0;
  let failures = 0;
  let blocked = false;
  while (attempts < o.attempts && left() > 0) {
    attempts += 1;
    try {
      last = await step(engine.snapshot(), 'close-out snapshot');
      if (isFlat(last)) {
        flat = true;
        break;
      }
      passes += 1;
      o.log?.(
        `[close-out] attempt ${String(attempts)}: ${String(last.orders.length)} open orders, ${String(Object.keys(last.account.positions).length)} positions; cancelling and closing reduce-only`,
      );
      const why = `${o.reason} (close-out ${String(attempts)})`;
      // reduce-only flatten; after a guard trip / manual kill keep the stop, otherwise never trip it
      const result = await flattenStep(
        o.stop === true ? engine.kill(why) : engine.abort(why),
        'close-out flatten',
      );
      failures = 0;
      if (noteFlatten(result, `attempt ${String(attempts)}`, errors, o.log)) {
        blocked = true;
        break;
      }
    } catch (e) {
      failures += 1;
      errors.push(`attempt ${String(attempts)}: ${msg(e)}`);
      o.log?.(`[close-out] attempt ${String(attempts)} failed: ${msg(e)}`);
    }
    const backoff = failures > 0 ? (o.backoffMs ?? 2000) * 2 ** (failures - 1) : 0;
    const pause = Math.min(Math.max(o.pauseMs ?? 0, backoff), left());
    if (pause > 0) await new Promise((r) => setTimeout(r, pause));
  }
  // retry phase: its own, longer budget with backoff, so one slow pass never ends the session NOT flat
  let retries = 0;
  const rc = o.retry;
  if (!flat && !blocked && rc?.enabled === true) {
    const rStart = Date.now();
    const rLeft = (): number => rc.retryBudgetSec * 1000 - (Date.now() - rStart);
    const pass = <T>(p: Promise<T>, label: string): Promise<T> =>
      withTimeout(p, Math.max(1, Math.min(rc.passTimeoutSec * 1000, rLeft())), label);
    o.log?.(
      `[close-out] not flat after the first budget; retrying for up to ${String(rc.retryBudgetSec)} s with backoff`,
    );
    while (retries < rc.maxRetries && rLeft() > 0) {
      const wait = Math.min(rc.backoffMaxSec, rc.backoffBaseSec * 2 ** retries) * 1000;
      if (wait >= rLeft()) break;
      await new Promise((r) => setTimeout(r, wait));
      retries += 1;
      try {
        last = await pass(engine.snapshot(), 'close-out retry snapshot');
        if (isFlat(last)) {
          flat = true;
          break;
        }
        passes += 1;
        o.log?.(
          `[close-out] retry ${String(retries)}: ${String(last.orders.length)} open orders, ${String(Object.keys(last.account.positions).length)} positions; cancelling and closing reduce-only`,
        );
        const why = `${o.reason} (close-out retry ${String(retries)})`;
        const result = await pass(
          o.stop === true ? engine.kill(why) : engine.abort(why),
          'close-out retry flatten',
        );
        if (noteFlatten(result, `retry ${String(retries)}`, errors, o.log)) break;
      } catch (e) {
        errors.push(`retry ${String(retries)}: ${msg(e)}`);
        o.log?.(`[close-out] retry ${String(retries)} failed: ${msg(e)}`);
      }
    }
  }
  if (!flat) {
    // final check, with its own bound even when the budget is spent
    try {
      last = await withTimeout(engine.snapshot(), o.stepMs, 'close-out final check');
      flat = isFlat(last);
    } catch (e) {
      last = undefined;
      errors.push(`final check: ${msg(e)}`);
      errors.push('could not read the account to confirm it is flat');
    }
  }
  return {
    flat,
    attempts,
    passes,
    openOrders: last?.orders.length ?? -1,
    positions: last?.account.positions ?? {},
    errors,
    retries,
    ...(last === undefined ? {} : { snapshot: last }),
  };
}
