// Simulated venue: an in-memory perps account with a mark price per market, resting orders that fill when
// the mark crosses them, IOC/post-only semantics, an initial-margin check and the same named errors the
// dreamDEX pool raises. Deterministic: marks move only through setMark() or step() with a seeded walk.
import { keccak256, stringToBytes } from 'viem';

import type { OrderIntent, VenueSizing } from '../gate/types.js';
import { floorToGrid, notional, onGrid } from '../gate/units.js';
import type { RestingOrder } from '../killswitch/killswitch.js';
import type { BookTop, CancelResult, PlaceResult, Venue, VenueMarket, VenueSnapshot } from './types.js';
import { isBidSide, orderTypeCode } from './map.js';

interface SimOrder {
  readonly id: bigint;
  readonly market: string;
  readonly isBid: boolean;
  readonly price: bigint;
  remaining: bigint;
}

interface SimPosition {
  size: bigint;
  entry: bigint;
}

export interface SimOptions {
  readonly account?: `0x${string}`;
  /** Starting collateral, raw USDso (18 dp). */
  readonly collateral: bigint;
  readonly now: () => number;
  /** Seed for step(). */
  readonly seed?: number;
  /** Seconds after which a mark counts as stale for sizing (the pool's own staleness). */
  readonly markMaxAgeSec?: number;
  /**
   * Cap on how much of a crossing IOC fills. The rest is cancelled, as an IOC does. Tests use this for a
   * partial close. Unset means the whole crossing quantity fills.
   */
  readonly maxIocFill?: bigint;
}

const SIM_ACCOUNT = '0x00000000000000000000000000000000005e1a7e';

export class SimVenue implements Venue {
  readonly mode = 'sim' as const;
  readonly account: `0x${string}`;
  readonly sender: `0x${string}`;
  private readonly markets = new Map<string, VenueMarket>();
  private readonly orders = new Map<bigint, SimOrder>();
  private readonly positions = new Map<string, SimPosition>();
  private collateral: bigint;
  private nextId = 1n;
  private txCount = 0;
  private rng: number;
  /** Every fill, for tests and the trace. */
  readonly fills: { market: string; orderId: bigint; isBid: boolean; price: bigint; quantity: bigint }[] = [];

  constructor(
    markets: readonly VenueMarket[],
    private readonly opts: SimOptions,
  ) {
    for (const m of markets) this.markets.set(m.market, m);
    this.collateral = opts.collateral;
    this.account = opts.account ?? SIM_ACCOUNT;
    this.sender = this.account;
    this.rng = opts.seed ?? 1;
  }

  market(name: string): VenueMarket {
    const m = this.markets.get(name);
    if (m === undefined) throw new Error(`sim: unknown market ${name}`);
    return m;
  }

  /** Install a signed position the account already holds. Zero clears it. No order is sent. */
  setPosition(market: string, size: bigint): void {
    const m = this.market(market);
    if (size === 0n) this.positions.delete(market);
    else this.positions.set(market, { size, entry: m.markPrice });
  }

  /** Move a mark and fill any resting order it crosses. */
  setMark(name: string, price: bigint, at = this.opts.now()): void {
    const m = this.market(name);
    this.markets.set(name, { ...m, markPrice: price, markUpdatedAt: at });
    for (const o of [...this.orders.values()]) {
      if (o.market !== name) continue;
      if ((o.isBid && price <= o.price) || (!o.isBid && price >= o.price)) {
        this.fill(o.market, o.id, o.isBid, o.price, o.remaining);
        this.orders.delete(o.id);
      }
    }
  }

  /** Seeded random walk of every mark by up to `maxBps`, kept on the tick grid. */
  step(maxBps = 20): void {
    for (const m of [...this.markets.values()]) {
      this.rng = (this.rng * 1_103_515_245 + 12_345) % 2_147_483_648;
      const bps = BigInt(Math.floor((this.rng / 2_147_483_648) * (2 * maxBps + 1)) - maxBps);
      const next = floorToGrid((m.markPrice * (10_000n + bps)) / 10_000n, m.tickSize);
      this.setMark(m.market, next > 0n ? next : m.tickSize);
    }
  }

  equity(): bigint {
    let eq = this.collateral;
    for (const [name, p] of this.positions) {
      const m = this.market(name);
      eq += (p.size * (m.markPrice - p.entry)) / 10n ** BigInt(m.baseDecimals);
    }
    return eq;
  }

  private gross(): bigint {
    let g = 0n;
    for (const [name, p] of this.positions) {
      const m = this.market(name);
      g += notional(m.markPrice, p.size < 0n ? -p.size : p.size, m.baseDecimals);
    }
    return g;
  }

  private requiredMargin(extraNotional: bigint, imfBps: number): bigint {
    return ((this.gross() + extraNotional) * BigInt(imfBps)) / 10_000n;
  }

  snapshot(names: readonly string[]): Promise<VenueSnapshot> {
    const markets: Record<string, VenueMarket> = {};
    for (const n of names) {
      const m = this.markets.get(n);
      if (m !== undefined) markets[n] = m;
    }
    const positions: Record<string, bigint> = {};
    for (const [n, p] of this.positions) if (p.size !== 0n) positions[n] = p.size;
    const orders: RestingOrder[] = [...this.orders.values()].map((o) => ({
      market: o.market,
      orderId: o.id,
    }));
    return Promise.resolve({
      account: { equity: this.equity(), positions, grossNotional: this.gross(), openOrders: orders.length },
      markets,
      orders,
      at: this.opts.now(),
    });
  }

  sizing(market: VenueMarket, intent: OrderIntent): Promise<VenueSizing> {
    const m = this.market(market.market);
    const fresh = m.markPrice > 0n && this.opts.now() - m.markUpdatedAt <= (this.opts.markMaxAgeSec ?? 60);
    if (!fresh) return Promise.resolve({ priceable: false, placeable: false, maxQuantity: 0n });
    const imf = BigInt(m.initialMarginBps > 0 ? m.initialMarginBps : 10_000);
    const headroom = (this.equity() * 10_000n) / imf - this.gross();
    const price = intent.price > 0n ? intent.price : m.markPrice;
    const maxQuantity =
      headroom <= 0n ? 0n : floorToGrid((headroom * 10n ** BigInt(m.baseDecimals)) / price, m.lotSize);
    const placeable = maxQuantity >= m.minQuantity;
    return Promise.resolve({
      priceable: true,
      placeable,
      maxQuantity,
      ...(placeable ? {} : { limitedBy: 'collateral' }),
    });
  }

  private tx(): `0x${string}` {
    this.txCount += 1;
    return keccak256(stringToBytes(`sim-tx-${String(this.txCount)}`));
  }

  private reject(errorName: string, benign = false): PlaceResult {
    return { ok: false, filled: 0n, errorName, error: `sim: ${errorName}`, ...(benign ? { benign } : {}) };
  }

  place(market: VenueMarket, intent: OrderIntent): Promise<PlaceResult> {
    const m = this.market(market.market);
    orderTypeCode(intent.orderType);
    const isBid = isBidSide(intent.side);
    if (!onGrid(intent.price, m.tickSize) || intent.price <= 0n)
      return Promise.resolve(this.reject('InvalidPrice'));
    if (!onGrid(intent.quantity, m.lotSize) || intent.quantity < m.minQuantity)
      return Promise.resolve(this.reject('InvalidQuantity'));
    const crosses = isBid ? intent.price >= m.markPrice : intent.price <= m.markPrice;
    if (intent.orderType === 'post_only' && crosses)
      return Promise.resolve(this.reject('PostOnlyWouldCross', true));
    if (intent.orderType === 'ioc' && !crosses)
      return Promise.resolve(this.reject('ImmediateOrCancelNoFill', true));
    const pos = this.positions.get(m.market)?.size ?? 0n;
    const delta = isBid ? intent.quantity : -intent.quantity;
    const after = pos + delta;
    const growth = (after < 0n ? -after : after) - (pos < 0n ? -pos : pos);
    if (growth > 0n) {
      const need = this.requiredMargin(notional(intent.price, growth, m.baseDecimals), m.initialMarginBps);
      if (need > this.equity()) return Promise.resolve(this.reject('InsufficientCollateral'));
    }
    const txHash = this.tx();
    const id = this.nextId++;
    if (crosses) {
      let qty = intent.quantity;
      if (intent.orderType === 'ioc' && this.opts.maxIocFill !== undefined && qty > this.opts.maxIocFill)
        qty = this.opts.maxIocFill;
      if (qty <= 0n) return Promise.resolve(this.reject('ImmediateOrCancelNoFill', true));
      this.fill(m.market, id, isBid, m.markPrice, qty);
      return Promise.resolve({ ok: true, txHash, filled: qty });
    }
    this.orders.set(id, { id, market: m.market, isBid, price: intent.price, remaining: intent.quantity });
    return Promise.resolve({ ok: true, txHash, orderId: id, filled: 0n });
  }

  /** One tick either side of the mark. */
  bookTop(market: VenueMarket): Promise<BookTop | undefined> {
    const m = this.market(market.market);
    return Promise.resolve({ bestBid: m.markPrice - m.tickSize, bestAsk: m.markPrice + m.tickSize });
  }

  cancel(_market: VenueMarket, order: RestingOrder): Promise<CancelResult> {
    if (!this.orders.delete(order.orderId))
      return Promise.resolve({ ok: false, error: 'sim: OrderNotFound' });
    return Promise.resolve({ ok: true, txHash: this.tx() });
  }

  private fill(market: string, orderId: bigint, isBid: boolean, price: bigint, quantity: bigint): void {
    const m = this.market(market);
    const scale = 10n ** BigInt(m.baseDecimals);
    const p = this.positions.get(market) ?? { size: 0n, entry: 0n };
    const delta = isBid ? quantity : -quantity;
    const sameDir = p.size === 0n || p.size > 0n === delta > 0n;
    if (sameDir) {
      const newSize = p.size + delta;
      const absOld = p.size < 0n ? -p.size : p.size;
      p.entry = (p.entry * absOld + price * quantity) / (absOld + quantity);
      p.size = newSize;
    } else {
      const absOld = p.size < 0n ? -p.size : p.size;
      const closed = quantity < absOld ? quantity : absOld;
      const sign = p.size > 0n ? 1n : -1n;
      this.collateral += (sign * closed * (price - p.entry)) / scale;
      p.size += delta;
      if (p.size === 0n) p.entry = 0n;
      else if (closed < quantity) p.entry = price;
    }
    this.positions.set(market, p);
    this.fills.push({ market, orderId, isBid, price, quantity });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
