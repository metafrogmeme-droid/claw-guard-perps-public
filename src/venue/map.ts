// Pure conversions between dreamDEX market rows and the gate's MarketSpec.
import type { OrderType } from '../gate/types.js';
import type { VenueMarket } from './types.js';

/** dreamDEX ORDER_TYPE codes: 0 limit, 2 IOC ("market"), 3 post-only. */
export const ORDER_TYPE_CODE: Readonly<Record<OrderType, number>> = { limit: 0, ioc: 2, post_only: 3 };

/** Fail closed: only exactly "long" is a bid and only exactly "short" is an ask. Anything else throws. */
export function isBidSide(side: unknown): boolean {
  if (side === 'long') return true;
  if (side === 'short') return false;
  throw new Error(
    `refusing order: side must be "long" or "short", got ${typeof side === 'string' ? `"${side.slice(0, 40)}"` : typeof side}`,
  );
}

/** Fail closed: an order type without a venue code throws instead of sending a default. */
export function orderTypeCode(t: unknown): number {
  if (t === 'limit' || t === 'ioc' || t === 'post_only') return ORDER_TYPE_CODE[t];
  throw new Error(
    `refusing order: unknown order type ${typeof t === 'string' ? `"${t.slice(0, 40)}"` : typeof t}`,
  );
}

/** "BTC/USDso:USDso" -> "BTC-PERP". */
export function displayName(symbol: string): string {
  return `${symbol.split('/')[0] ?? symbol}-PERP`;
}

export interface MarketRow {
  readonly poolAddress: string;
  readonly marginBank: string;
  readonly baseDecimals: number | string;
  readonly tickSize: string | bigint;
  readonly lotSize: string | bigint;
  readonly minQuantity: string | bigint;
  readonly markPrice?: string | bigint | null;
  readonly markPriceUpdatedAt?: string | number | null;
  readonly initialMarginBps?: string | number | null;
}

export interface LiveMark {
  readonly priceable: boolean;
  readonly markPrice?: bigint;
}

/**
 * Build the gate's view of a market. The indexer row's mark lags the chain, so when the pool's own health
 * snapshot is priceable its mark is used and stamped `now` (the pool will act on that number). Otherwise the
 * row's mark and its own timestamp are kept, and the gate's staleness rule decides.
 */
export function toVenueMarket(
  name: string,
  row: MarketRow,
  live: LiveMark | undefined,
  now: number,
): VenueMarket {
  const useLive = live?.priceable === true && live.markPrice !== undefined && live.markPrice > 0n;
  const rowMark = row.markPrice === null || row.markPrice === undefined ? 0n : BigInt(row.markPrice);
  const rowAt =
    row.markPriceUpdatedAt === null || row.markPriceUpdatedAt === undefined
      ? 0
      : Number(row.markPriceUpdatedAt);
  return {
    market: name,
    pool: row.poolAddress.toLowerCase() as `0x${string}`,
    marginBank: row.marginBank.toLowerCase() as `0x${string}`,
    baseDecimals: Number(row.baseDecimals),
    tickSize: BigInt(row.tickSize),
    lotSize: BigInt(row.lotSize),
    minQuantity: BigInt(row.minQuantity),
    markPrice: useLive ? (live.markPrice ?? 0n) : rowMark,
    markUpdatedAt: useLive ? now : rowAt,
    initialMarginBps: Number(row.initialMarginBps ?? 0),
  };
}

/** The SDK's resting-order expiry: fifty years out, in nanoseconds. */
export function farFutureNs(nowSec: number): bigint {
  return BigInt(nowSec + 50 * 365 * 24 * 3600) * 1_000_000_000n;
}
