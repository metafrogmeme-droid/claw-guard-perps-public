// Time bounds for every network call. A promise from the chain, the indexer or a socket may never settle
// (a half-open connection gives no error and no answer), so the runner never awaits one without a bound.
import type { RestingOrder } from '../killswitch/killswitch.js';
import type { OrderIntent, VenueSizing } from '../gate/types.js';
import type {
  BookTop,
  CancelResult,
  PlaceResult,
  Venue,
  VenueMarket,
  VenueSnapshot,
} from '../venue/types.js';

/** A call did not settle inside its bound. */
export class CallTimeoutError extends Error {
  override readonly name = 'CallTimeoutError';
  constructor(
    readonly label: string,
    readonly ms: number,
  ) {
    super(`${label} timed out after ${String(ms / 1000)}s`);
  }
}

/** The run was told to stop (deadline watchdog, SIGTERM) while a call was still waiting. */
export class StopRequestedError extends Error {
  override readonly name = 'StopRequestedError';
  constructor(readonly reason: string) {
    super(`stop requested: ${reason}`);
  }
}

export function stopReasonOf(signal: AbortSignal): string {
  const r: unknown = signal.reason;
  return typeof r === 'string' ? r : r instanceof Error ? r.message : 'aborted';
}

/**
 * Settles with `p`, or rejects with CallTimeoutError after `ms`, or with StopRequestedError as soon as `signal`
 * aborts, whichever comes first. The timer is always cleared. `ms <= 0` or Infinity means no time bound.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted === true) {
    p.catch(() => undefined);
    return Promise.reject(new StopRequestedError(stopReasonOf(signal)));
  }
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      done();
      reject(new StopRequestedError(signal === undefined ? 'aborted' : stopReasonOf(signal)));
    };
    const done = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    if (ms > 0 && Number.isFinite(ms)) {
      timer = setTimeout(() => {
        done();
        reject(new CallTimeoutError(label, ms));
      }, ms);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        done();
        resolve(v);
      },
      (e: unknown) => {
        done();
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** Sleep that ends early (resolves) when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(t);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}

export interface CallBounds {
  /** Bound for a read (snapshot, sizing, book top), in ms. */
  readonly readMs: number;
  /** Bound for a write (place, cancel), in ms. A write that times out may still land; the caller re-reads. */
  readonly writeMs: number;
}

export const DEFAULT_BOUNDS: CallBounds = { readMs: 30_000, writeMs: 60_000 };

/**
 * The same venue with every call time-bounded. Reads reject with CallTimeoutError. Writes resolve with
 * `ok: false` and the timeout in `error`, so the engine journals it like any other venue failure (the order may
 * still land, which is why the close-out re-reads the account until it is flat).
 */
export function timedVenue(v: Venue, b: CallBounds = DEFAULT_BOUNDS): Venue {
  const read = <T>(p: Promise<T>, what: string): Promise<T> => withTimeout(p, b.readMs, `venue ${what}`);
  const write = async <T extends PlaceResult | CancelResult>(
    p: Promise<T>,
    what: string,
    fallback: T,
  ): Promise<T> => {
    try {
      return await withTimeout(p, b.writeMs, `venue ${what}`);
    } catch (e) {
      if (!(e instanceof CallTimeoutError)) throw e;
      return { ...fallback, error: `${e.message}; it may still land, re-read the account` };
    }
  };
  const timed: Venue = {
    mode: v.mode,
    account: v.account,
    sender: v.sender,
    snapshot: (names: readonly string[]): Promise<VenueSnapshot> => read(v.snapshot(names), 'snapshot'),
    sizing: (m: VenueMarket, i: OrderIntent): Promise<VenueSizing> => read(v.sizing(m, i), 'sizing'),
    place: (m: VenueMarket, i: OrderIntent): Promise<PlaceResult> =>
      write(v.place(m, i), 'place', { ok: false, filled: 0n }),
    cancel: (m: VenueMarket, o: RestingOrder): Promise<CancelResult> =>
      write(v.cancel(m, o), 'cancel', { ok: false }),
    close: (): Promise<void> => withTimeout(v.close(), b.readMs, 'venue close').catch(() => undefined),
  };
  const top = v.bookTop?.bind(v);
  if (top !== undefined) {
    timed.bookTop = (m: VenueMarket): Promise<BookTop | undefined> => read(top(m), 'book top');
  }
  return timed;
}
