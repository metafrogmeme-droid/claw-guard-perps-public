// The venue seam. The gate never talks to a chain; the runner reads a snapshot from a Venue, asks the gate,
// and only then calls place/cancel. Two implementations: the simulated venue (tests, demo --sim) and dreamDEX.
import type { AccountState, MarketSpec, OrderIntent, VenueSizing } from '../gate/types.js';
import type { RestingOrder } from '../killswitch/killswitch.js';

export type VenueMode = 'sim' | 'own-account' | 'linked-bot-key';

export interface VenueMarket extends MarketSpec {
  /** Pool contract (dreamDEX) or a synthetic id (sim). */
  readonly pool: `0x${string}`;
  readonly marginBank: `0x${string}`;
  /** Initial margin in bps, from the market row. */
  readonly initialMarginBps: number;
}

export interface VenueSnapshot {
  readonly account: AccountState;
  readonly markets: Readonly<Record<string, VenueMarket>>;
  readonly orders: readonly RestingOrder[];
  /** Unix seconds the snapshot describes. */
  readonly at: number;
}

export interface PlaceResult {
  readonly ok: boolean;
  readonly txHash?: `0x${string}`;
  readonly orderId?: bigint;
  /** Base quantity filled in this transaction. */
  readonly filled: bigint;
  /** Named pool error, when the venue rejected the order. */
  readonly errorName?: string;
  readonly error?: string;
  /** True when the outcome is an ordinary market event (IOC found nothing, post-only would cross). */
  readonly benign?: boolean;
}

export interface CancelResult {
  readonly ok: boolean;
  readonly txHash?: `0x${string}`;
  readonly error?: string;
}

/** Best resting prices, raw (18 dp). Either side may be missing on an empty book. */
export interface BookTop {
  readonly bestBid?: bigint;
  readonly bestAsk?: bigint;
}

export interface Venue {
  readonly mode: VenueMode;
  /** The account whose margin backs the orders (owner in linked mode). */
  readonly account: `0x${string}`;
  /** The key that sends transactions (the bot key in linked mode). */
  readonly sender: `0x${string}`;
  snapshot(markets: readonly string[]): Promise<VenueSnapshot>;
  sizing(market: VenueMarket, intent: OrderIntent): Promise<VenueSizing>;
  place(market: VenueMarket, intent: OrderIntent): Promise<PlaceResult>;
  cancel(market: VenueMarket, order: RestingOrder): Promise<CancelResult>;
  /** Top of book, when the venue can read it. Used to price taker orders tightly. */
  bookTop?(market: VenueMarket): Promise<BookTop | undefined>;
  close(): Promise<void>;
}
