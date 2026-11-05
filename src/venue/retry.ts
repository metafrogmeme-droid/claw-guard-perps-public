// Bounded retries for venue reads. Testnet RPC reads (getPosition, getAccountState) sometimes hang for longer
// than one call bound; one slow read used to end a whole session. Each attempt has its own timeout, a timed-out
// or failed attempt calls onTimeout (the venue rotates to the next RPC there), then waits with backoff.
import { withTimeout } from '../runtime/timeout.js';

export interface ReadRetry {
  /** Timeout for one attempt, ms. */
  readonly attemptMs: number;
  readonly attempts: number;
  /** Wait before retry n is backoffMs * 2^(n-1), ms. */
  readonly backoffMs: number;
}

/** 3 x 20 s with 1 s / 2 s backoff: worst case ~63 s, inside the session read bound. */
export const DEFAULT_READ_RETRY: ReadRetry = { attemptMs: 20_000, attempts: 3, backoffMs: 1_000 };

export async function readWithRetry<T>(
  f: () => Promise<T>,
  label: string,
  o: ReadRetry = DEFAULT_READ_RETRY,
  onTimeout?: (attempt: number, err: unknown) => void,
): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= Math.max(1, o.attempts); i += 1) {
    try {
      return await withTimeout(f(), o.attemptMs, `${label} (attempt ${String(i)})`);
    } catch (e) {
      last = e;
      if (i >= o.attempts) break;
      onTimeout?.(i, e);
      await new Promise((r) => setTimeout(r, o.backoffMs * 2 ** (i - 1)));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}
