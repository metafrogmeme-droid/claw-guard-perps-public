// Shared types for the pre-trade gate. The gate is pure: same inputs, same decision, no I/O.

export type Side = 'long' | 'short';
/** limit rests the remainder; post_only never takes; ioc takes what it can now and cancels the rest. */
export type OrderType = 'limit' | 'post_only' | 'ioc';

/** What an agent (LLM or rule-based) asks to do. Raw units only: price 18 dp, quantity in base dp. */
export interface OrderIntent {
  /** App-canonical market name, e.g. "BTC-PERP". */
  readonly market: string;
  readonly side: Side;
  readonly orderType: OrderType;
  /** Raw quote units (18 dp) per whole base asset. */
  readonly price: bigint;
  /** Raw base units (market.baseDecimals). */
  readonly quantity: bigint;
  /** The agent says this only shrinks an existing position. The gate verifies it against the position. */
  readonly reduceOnly: boolean;
  /** Who asked (agent id or strategy name), recorded in the receipt. */
  readonly agent: string;
  /** Optional free text from the agent, recorded but never trusted. */
  readonly reason?: string;
  /**
   * Decimals the agent assumed for quantity. When set and different from the market's baseDecimals, the
   * order is blocked as a scale mistake before any other math runs.
   */
  readonly assumedBaseDecimals?: number;
}

/** Market facts read from the venue (dreamDEX market row + pool parameters). */
export interface MarketSpec {
  readonly market: string;
  readonly baseDecimals: number;
  readonly tickSize: bigint;
  readonly lotSize: bigint;
  readonly minQuantity: bigint;
  /** Mark price, 18 dp. 0n when unknown. */
  readonly markPrice: bigint;
  /** Unix seconds of the last mark update. */
  readonly markUpdatedAt: number;
}

/** The venue's own sizing answer (getMaxPerpOrderSize) for this exact order, when available. */
export interface VenueSizing {
  readonly priceable: boolean;
  readonly placeable: boolean;
  readonly maxQuantity: bigint;
  readonly limitedBy?: string;
}

/** Account facts the gate needs. Positions are signed base quantities (long > 0, short < 0). */
export interface AccountState {
  /** Account equity in raw USDso (18 dp). */
  readonly equity: bigint;
  /** Signed position in raw base units, per market. */
  readonly positions: Readonly<Record<string, bigint>>;
  /** Gross notional of all open positions in raw USDso, across markets (for the leverage check). */
  readonly grossNotional: bigint;
  /** Number of resting orders across all markets. */
  readonly openOrders: number;
}

/** Gate-local memory: what this gate has already let through, so caps hold across calls. */
export interface GateMemory {
  /** UTC day (YYYY-MM-DD) the daily counter belongs to. */
  readonly day: string;
  /** Allowed opening notional so far this UTC day, raw USDso. */
  readonly dailyNotional: bigint;
  /** Unix seconds of recently allowed orders (for the rate limit). */
  readonly recentOrders: readonly number[];
  /** Venue failures in a row (reverts, rejections). Reset by a success. */
  readonly consecutiveFailures: number;
  /** Set by the kill switch. Only reducing orders pass while it is set. */
  readonly killSwitch: boolean;
  /** Markets that have had at least one approved order. */
  readonly seenMarkets: readonly string[];
}

export type Verdict = 'allowed' | 'blocked' | 'needs_ok';

export interface Decision {
  readonly verdict: Verdict;
  /** Every rule that fired, blocking ones first. Empty when allowed. */
  readonly codes: readonly string[];
  /** User-facing line: exactly one of the three verdict wordings. */
  readonly message: string;
  /** Opening notional this order adds (0 for a verified reduce), raw USDso. */
  readonly notional: bigint;
  /** Human-readable detail per code, for the trace viewer. */
  readonly details: Readonly<Record<string, string>>;
}
