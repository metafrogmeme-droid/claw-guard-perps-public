// Profit-focused maker strategy ("skew"). Opt-in: the band maker stays the default.
//
// - Maker only: every opening quote is post_only, so it never pays the spread (dreamDEX testnet showed no fee
//   in realized P&L on 2 Nov; post-only also keeps us on the maker side if fees appear).
// - Spread capture around the mark, with inventory skew: holding a long moves both quotes down (sell sooner,
//   buy later), holding a short moves them up.
// - Inventory cap below the guard's own position cap; at the cap only the reducing side is quoted.
// - Exits: take-profit is the opposite quote; a hard stop per position (adverse move from entry, bps) and a
//   time exit (max hold) switch to a reduce-only post_only order one tick inside the mark.
// - No taker orders. A taker exit is never sent from here; it would go through the guard's Needs-your-OK path.
// - Profit rules (session rule 2): an opening quote is only asked for when its distance from the mark covers a
//   round trip of maker fees plus a minimum edge (makerFeeBps, minEdgeBps); a per-trade take-profit
//   (takeProfitBps, favourable move from entry) switches to the same reduce-only post_only exit as the stop.
// - Tweaks from the 4 Nov sessions (docs/STRATEGY_RULES.md, "Skew quoting defaults"), quoting only:
//   - volatility-aware spread: when a market's mark moved volJumpBps or more between two of the last volWindow
//     snapshots, its quotes use volHalfSpreadBps instead of halfSpreadBps;
//   - exit quotes keep resting while they stay within exitRequoteBps of the target (no cancel+replace per tick);
//   - focus on the heavy market: once two or more markets hold inventory, no market gets a new opening quote
//     and the heaviest one (largest inventory notional) gets the full skew on its reducing quote.
//
// The guard is unchanged: every intent still goes through evaluate(); this module only decides what to ask for.
import type { OrderIntent } from '../gate/types.js';
import { floorToGrid } from '../gate/units.js';
import type { RestingOrder } from '../killswitch/killswitch.js';
import type { VenueMarket } from '../venue/types.js';
import type { TrackedOrder } from './engine.js';
import { quoteQuantity, type StrategyStep } from './strategy.js';

export interface SkewMakerConfig {
  readonly markets: readonly string[];
  /** Distance of each quote from the (skewed) reference price, bps. */
  readonly halfSpreadBps: number;
  /** Requote only when a resting quote is this far from where it should be, bps (saves daily notional). */
  readonly requoteBps: number;
  /** Target notional per quote, raw USDso. */
  readonly quoteNotional: bigint;
  /** Strategy inventory cap per market, raw USDso. Keep below the guard's maxPositionNotional. */
  readonly maxInventoryNotional: bigint;
  /** Reference shift at full inventory, bps (linear in inventory). */
  readonly skewBps: number;
  /** Hard stop: exit when the mark moved this far against the entry, bps. */
  readonly stopBps: number;
  /** Time exit: exit a position held longer than this, seconds. */
  readonly maxHoldSec: number;
  /** Assumed maker fee per fill, bps of notional (testnet measured 0 on 2 Nov; 2 is a margin). */
  readonly makerFeeBps: number;
  /** Edge an opening quote must keep after a round trip of maker fees, bps. */
  readonly minEdgeBps: number;
  /** Take-profit: exit when the mark moved this far in our favour from the entry, bps. 0 = off. */
  readonly takeProfitBps: number;
  /** Half-spread used while the market is jumpy (see volJumpBps), bps. Never below halfSpreadBps. */
  readonly volHalfSpreadBps: number;
  /** A mark move this large between two snapshots in the window makes the market jumpy, bps. 0 = off. */
  readonly volJumpBps: number;
  /** Snapshots per market the jump check looks back over. */
  readonly volWindow: number;
  /** An exit quote is replaced only when it is this far from its target, bps. 0 = replace on any change. */
  readonly exitRequoteBps: number;
  /** With two or more markets holding inventory: reduce only, full skew on the heaviest market. */
  readonly focusHeavy: boolean;
  readonly agent: string;
}

export const DEFAULT_SKEW: Omit<
  SkewMakerConfig,
  'markets' | 'quoteNotional' | 'maxInventoryNotional' | 'agent'
> = {
  halfSpreadBps: 25,
  // 4 Nov tweaks: requote 20 -> 35, skew 20 -> 35, max hold 1800 -> 1200 s, jumpy half-spread 35
  requoteBps: 35,
  skewBps: 35,
  stopBps: 60,
  maxHoldSec: 1200,
  makerFeeBps: 2,
  minEdgeBps: 3,
  takeProfitBps: 50,
  volHalfSpreadBps: 35,
  volJumpBps: 15,
  volWindow: 5,
  exitRequoteBps: 10,
  focusHeavy: true,
};

/** Edge an opening quote at `price` has against the mark, bps (positive = away from the mark on our side). */
export function quoteEdgeBps(mark: bigint, price: bigint, bid: boolean): number {
  if (mark <= 0n) return 0;
  return Number(((bid ? mark - price : price - mark) * 10_000n) / mark);
}

/** Smallest edge an opening quote needs: a round trip of maker fees plus the minimum edge, bps. */
export function requiredEdgeBps(cfg: Pick<SkewMakerConfig, 'makerFeeBps' | 'minEdgeBps'>): number {
  return 2 * cfg.makerFeeBps + cfg.minEdgeBps;
}

interface Held {
  readonly entry: bigint;
  readonly since: number;
  readonly long: boolean;
}

/** Strategy memory: entry mark and time of each open position (the venue snapshot only has sizes). */
export class SkewState {
  readonly held = new Map<string, Held>();
  /** Positions in exit mode (stop or time), so they keep exiting even if the mark comes back a bit. */
  readonly exiting = new Map<string, string>();
  /** Recent marks per market, newest last (for the jumpy-market check). */
  readonly marks = new Map<string, bigint[]>();
}

/** Records `mark` and returns the largest move between consecutive marks in the window, bps. */
export function recordMark(st: SkewState, name: string, mark: bigint, window: number): number {
  const keep = Math.max(2, window);
  const xs = [...(st.marks.get(name) ?? []), mark].slice(-keep);
  st.marks.set(name, xs);
  let worst = 0;
  for (let i = 1; i < xs.length; i += 1) {
    const a = xs[i - 1] ?? 0n;
    const b = xs[i] ?? 0n;
    if (a > 0n) worst = Math.max(worst, Math.abs(Number(((b - a) * 10_000n) / a)));
  }
  return worst;
}

const bps = (a: bigint, b: bigint): number => (b === 0n ? 0 : Number(((a - b) * 10_000n) / b));
const absB = (x: bigint): bigint => (x < 0n ? -x : x);

function priceAt(m: VenueMarket, ref: bigint, offBps: number, bid: boolean): bigint {
  const raw = (ref * BigInt(10_000 + (bid ? -offBps : offBps))) / 10_000n;
  return bid ? floorToGrid(raw, m.tickSize) : floorToGrid(raw + m.tickSize - 1n, m.tickSize);
}

export function skewMaker(
  cfg: SkewMakerConfig,
  st: SkewState,
  markets: Readonly<Record<string, VenueMarket>>,
  positions: Readonly<Record<string, bigint>>,
  tracked: readonly TrackedOrder[],
  now: number,
  /** Daily notional the guard still allows today, raw USDso. Opening quotes that would not fit are not asked for. */
  budgetLeft?: bigint,
): StrategyStep & { exits: readonly string[]; noEdge: readonly string[] } {
  let budget = budgetLeft;
  const noEdge: string[] = [];
  const needEdge = requiredEdgeBps(cfg);
  const cancels: RestingOrder[] = [];
  const intents: OrderIntent[] = [];
  const exits: string[] = [];
  // focus on the heavy market: which markets hold inventory, and the heaviest by notional
  let heavy: string | undefined;
  let heavyNotional = -1n;
  let holding = 0;
  for (const name of cfg.markets) {
    const m = markets[name];
    const p = positions[name] ?? 0n;
    if (m === undefined || m.markPrice <= 0n || p === 0n) continue;
    holding += 1;
    const n = (m.markPrice * absB(p)) / 10n ** BigInt(m.baseDecimals);
    if (n > heavyNotional) {
      heavyNotional = n;
      heavy = name;
    }
  }
  const focus = cfg.focusHeavy && holding >= 2;
  for (const name of cfg.markets) {
    const m = markets[name];
    if (m === undefined || m.markPrice <= 0n) continue;
    const mark = m.markPrice;
    const pos = positions[name] ?? 0n;
    const scale = 10n ** BigInt(m.baseDecimals);
    const invNotional = (mark * absB(pos)) / scale;
    const jump = recordMark(st, name, mark, cfg.volWindow);
    const jumpy = cfg.volJumpBps > 0 && jump >= cfg.volJumpBps;
    const halfSpread = jumpy ? Math.max(cfg.halfSpreadBps, cfg.volHalfSpreadBps) : cfg.halfSpreadBps;

    // position bookkeeping
    if (pos === 0n) {
      st.held.delete(name);
      st.exiting.delete(name);
    } else {
      const h = st.held.get(name);
      if (h?.long !== pos > 0n) st.held.set(name, { entry: mark, since: now, long: pos > 0n });
    }
    const h = st.held.get(name);
    if (h !== undefined && !st.exiting.has(name)) {
      const move = h.long ? bps(mark, h.entry) : bps(h.entry, mark);
      if (move <= -cfg.stopBps) st.exiting.set(name, `stop ${String(-move)} bps`);
      else if (cfg.takeProfitBps > 0 && move >= cfg.takeProfitBps)
        st.exiting.set(name, `tp ${String(move)} bps`);
      else if (now - h.since >= cfg.maxHoldSec) st.exiting.set(name, `time ${String(now - h.since)} s`);
    }
    const mine = tracked.filter((t) => t.market === name);

    // exit mode: one reduce-only post_only order one tick inside the mark, nothing else
    const why = st.exiting.get(name);
    if (why !== undefined && pos !== 0n) {
      const long = pos > 0n;
      const side = long ? 'short' : 'long';
      const px = long ? mark + m.tickSize : mark - m.tickSize;
      const price = floorToGrid(px, m.tickSize);
      const keep = mine
        .filter(
          (t) => t.side === side && absB(t.price - price) * 10_000n <= price * BigInt(cfg.exitRequoteBps),
        )
        .slice(0, 1);
      for (const t of mine) if (!keep.includes(t)) cancels.push({ market: name, orderId: t.orderId });
      if (keep.length === 0) {
        exits.push(`${name}: ${why}`);
        intents.push({
          market: name,
          side,
          orderType: 'post_only',
          price,
          quantity:
            absB(pos) < m.minQuantity ? absB(pos) + quoteQuantity(m, price, cfg.quoteNotional) : absB(pos),
          reduceOnly: absB(pos) >= m.minQuantity,
          agent: cfg.agent,
          reason: `exit (${why})`,
        });
      }
      continue;
    }

    // skewed reference: long inventory -> lower, short -> higher
    const fill =
      focus && name === heavy
        ? 1
        : cfg.maxInventoryNotional > 0n
          ? Number((invNotional * 1000n) / cfg.maxInventoryNotional) / 1000
          : 0;
    const shift = Math.round(cfg.skewBps * Math.min(1, fill)) * (pos > 0n ? -1 : pos < 0n ? 1 : 0);
    const ref = (mark * BigInt(10_000 + shift)) / 10_000n;
    const atCap = invNotional + cfg.quoteNotional > cfg.maxInventoryNotional;

    for (const bid of [true, false]) {
      const side = bid ? 'long' : 'short';
      const reducing = (bid && pos < 0n) || (!bid && pos > 0n);
      let want = (atCap || focus) && !reducing ? undefined : priceAt(m, ref, halfSpread, bid);
      // a strong skew (skewBps above the half-spread) can push the reducing quote through the mark; keep it
      // post-only one tick inside the mark instead of dropping it
      if (want !== undefined && reducing && (bid ? want >= mark : want <= mark)) {
        want = floorToGrid(bid ? mark - m.tickSize : mark + m.tickSize, m.tickSize);
      }
      const have = mine.filter((t) => t.side === side);
      // keep a resting quote while it is within requoteBps of the target and still on its side of the mark with
      // the edge an opening needs (a wide requoteBps must not leave a stale quote across a moved mark)
      const ok = have.filter(
        (t) =>
          want !== undefined &&
          absB(t.price - want) * 10_000n <= want * BigInt(cfg.requoteBps) &&
          (bid ? t.price < mark : t.price > mark) &&
          (reducing || quoteEdgeBps(mark, t.price, bid) >= needEdge),
      );
      for (const t of have) if (!ok.includes(t)) cancels.push({ market: name, orderId: t.orderId });
      if (want === undefined || ok.length > 0) continue;
      // a post-only quote must not cross the mark
      if ((bid && want >= mark) || (!bid && want <= mark)) continue;
      // profit rule: an opening quote must cover a round trip of maker fees plus the minimum edge
      if (!reducing) {
        const edge = quoteEdgeBps(mark, want, bid);
        if (edge < needEdge) {
          noEdge.push(`${name} ${side}: edge ${String(edge)} bps < ${String(needEdge)} bps`);
          continue;
        }
      }
      const base = quoteQuantity(m, want, cfg.quoteNotional);
      const held = absB(pos);
      // reducing: close it all when the rest would be dust (below the venue minimum); a dust position is
      // folded into a normal-size order on the reducing side so it never gets stuck
      let qty = base;
      let reduceOnly = false;
      if (reducing) {
        if (held < m.minQuantity) qty = base + held;
        else if (held <= base || held - base < m.minQuantity) {
          qty = held;
          reduceOnly = true;
        } else reduceOnly = true;
      }
      if (!reduceOnly && budget !== undefined) {
        const n = (want * qty) / scale;
        if (n > budget) continue; // the guard would say DAILY_NOTIONAL_CAP; do not ask
        budget -= n;
      }
      intents.push({
        market: name,
        side,
        orderType: 'post_only',
        price: want,
        quantity: qty,
        reduceOnly,
        agent: cfg.agent,
        reason: `skew ${String(shift)} bps, half-spread ${String(halfSpread)} bps${jumpy ? ` (jumpy: ${String(jump)} bps move)` : ''}${focus && name === heavy ? ' (heavy market first)' : ''}`,
      });
    }
  }
  return { cancels, intents, exits, noEdge };
}
