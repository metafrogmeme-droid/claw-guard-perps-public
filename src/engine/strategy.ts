// Demo strategy: a rule-based band maker. It quotes one post-only bid below the mark and one post-only ask
// above it, at the venue's minimum size rounded up to a target notional, and requotes when the mark walks
// away. It makes no forecast; it exists to give the gate realistic traffic.
import type { OrderIntent } from '../gate/types.js';
import { floorToGrid, notional } from '../gate/units.js';
import type { RestingOrder } from '../killswitch/killswitch.js';
import type { VenueMarket } from '../venue/types.js';
import type { TrackedOrder } from './engine.js';

export interface BandMakerConfig {
  readonly markets: readonly string[];
  /** Distance of each quote from the mark, bps. */
  readonly bandBps: number;
  /** Requote when a resting quote is further than this from the mark, bps. */
  readonly requoteBps: number;
  /** Target notional per quote, raw USDso. Rounded up to the lot, never below the venue minimum. */
  readonly quoteNotional: bigint;
  readonly agent: string;
}

export interface StrategyStep {
  readonly cancels: readonly RestingOrder[];
  readonly intents: readonly OrderIntent[];
}

/** Smallest on-lot quantity at or above both minQuantity and the target notional. */
export function quoteQuantity(m: VenueMarket, price: bigint, target: bigint): bigint {
  const scale = 10n ** BigInt(m.baseDecimals);
  const raw = price > 0n ? (target * scale + price - 1n) / price : 0n;
  const onLot = floorToGrid(raw + m.lotSize - 1n, m.lotSize);
  return onLot > m.minQuantity ? onLot : floorToGrid(m.minQuantity + m.lotSize - 1n, m.lotSize);
}

export function quotePrice(m: VenueMarket, bid: boolean, bandBps: number): bigint {
  const b = BigInt(bandBps);
  if (bid) return floorToGrid((m.markPrice * (10_000n - b)) / 10_000n, m.tickSize);
  const raw = (m.markPrice * (10_000n + b) + 9_999n) / 10_000n;
  return floorToGrid(raw + m.tickSize - 1n, m.tickSize);
}

export function bandMaker(
  cfg: BandMakerConfig,
  markets: Readonly<Record<string, VenueMarket>>,
  tracked: readonly TrackedOrder[],
): StrategyStep {
  const cancels: RestingOrder[] = [];
  const intents: OrderIntent[] = [];
  for (const name of cfg.markets) {
    const m = markets[name];
    if (m === undefined || m.markPrice <= 0n) continue;
    const mine = tracked.filter((t) => t.market === name);
    for (const bid of [true, false]) {
      const side = bid ? 'long' : 'short';
      const have = mine.filter((t) => t.side === side);
      const stale = have.filter((t) => {
        const d = t.price > m.markPrice ? t.price - m.markPrice : m.markPrice - t.price;
        return d * 10_000n > m.markPrice * BigInt(cfg.requoteBps);
      });
      for (const s of stale) cancels.push({ market: name, orderId: s.orderId });
      if (have.length - stale.length > 0) continue;
      const price = quotePrice(m, bid, cfg.bandBps);
      const quantity = quoteQuantity(m, price, cfg.quoteNotional);
      intents.push({
        market: name,
        side,
        orderType: 'post_only',
        price,
        quantity,
        reduceOnly: false,
        agent: cfg.agent,
        reason: `band ${String(cfg.bandBps)} bps, ~${(notional(price, quantity, m.baseDecimals) / 10n ** 16n).toString()} cents`,
      });
    }
  }
  return { cancels, intents };
}
