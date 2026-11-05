// Session rule 3: loss cooldown. After `lossStreak` losing trades in a row the strategy may only reduce for
// `cooldownSec`: opening quotes are dropped and resting ones pulled; reducing quotes go out reduce-only. Bot-side
// and stricter only; the guard policy and on-chain limits are untouched.
//
// Trades are inferred from snapshots, the same way live and in the replay: a trade opens when a market's
// position leaves zero and closes when it returns to zero or flips. Fill prices come from our own tracked
// orders that vanished between snapshots on the matching side, else the mark. P&L is average-entry accounting
// minus an estimated maker fee per fill. It is an estimate of the trade, not the venue's realized P&L.
import { z } from 'zod';

import type { OrderIntent } from '../gate/types.js';
import { notional } from '../gate/units.js';
import type { RestingOrder } from '../killswitch/killswitch.js';
import type { VenueMarket } from '../venue/types.js';
import type { TrackedOrder } from './engine.js';

export const CooldownSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Losing trades in a row that start a cooldown. */
    lossStreak: z.number().int().min(1).max(20).default(2),
    /** How long the cooldown lasts, seconds. */
    cooldownSec: z.number().int().min(0).max(86_400).default(600),
    /** A trade counts as losing when its estimated P&L is below minus this, USD cents (0 = any loss). */
    lossToleranceCents: z.number().int().min(0).max(10_000).default(0),
  })
  .strict();

export type CooldownConfig = z.output<typeof CooldownSchema>;

export const DEFAULT_COOLDOWN: CooldownConfig = CooldownSchema.parse({});

export function parseCooldown(input: unknown): CooldownConfig {
  return CooldownSchema.parse(input ?? {});
}

export interface ClosedTrade {
  readonly market: string;
  readonly side: 'long' | 'short';
  /** Estimated P&L after fees, raw USDso (18 dp). */
  readonly pnl: bigint;
  readonly openedAt: number;
  readonly closedAt: number;
}

interface Open {
  size: bigint;
  entry: bigint;
  pnl: bigint;
  openedAt: number;
}

const abs = (x: bigint): bigint => (x < 0n ? -x : x);

/** Infers closed trades from successive position snapshots. */
export class TradeTracker {
  private readonly open = new Map<string, Open>();
  private readonly last = new Map<string, bigint>();

  constructor(private readonly feeBps: number) {}

  private fee(price: bigint, qty: bigint, m: VenueMarket): bigint {
    return (notional(price, qty, m.baseDecimals) * BigInt(Math.round(this.feeBps * 100))) / 1_000_000n;
  }

  /**
   * Feed one snapshot. `vanished` are our tracked orders that disappeared since the last snapshot (filled or
   * gone); their price is used as the fill price when the side matches the position change.
   */
  observe(
    positions: Readonly<Record<string, bigint>>,
    markets: Readonly<Record<string, VenueMarket>>,
    vanished: readonly TrackedOrder[],
    now: number,
  ): ClosedTrade[] {
    const closed: ClosedTrade[] = [];
    const names = new Set([...Object.keys(positions), ...this.last.keys()]);
    for (const name of names) {
      const m = markets[name];
      const now0 = positions[name] ?? 0n;
      const prev = this.last.get(name) ?? 0n;
      this.last.set(name, now0);
      if (m === undefined || now0 === prev) continue;
      const d = now0 - prev;
      const side = d > 0n ? 'long' : 'short';
      const hint = vanished.find((v) => v.market === name && v.side === side);
      const price = hint?.price ?? m.markPrice;
      let t = this.open.get(name);
      let left = abs(d);
      // reduce first (up to the open size), then open the remainder in the new direction
      if (t !== undefined && t.size !== 0n && t.size > 0n !== d > 0n) {
        const q = left < abs(t.size) ? left : abs(t.size);
        const sign = t.size > 0n ? 1n : -1n;
        const scale = 10n ** BigInt(m.baseDecimals);
        t.pnl += (sign * (price - t.entry) * q) / scale - this.fee(price, q, m);
        t.size += sign > 0n ? -q : q;
        left -= q;
        if (t.size === 0n) {
          closed.push({
            market: name,
            side: sign > 0n ? 'long' : 'short',
            pnl: t.pnl,
            openedAt: t.openedAt,
            closedAt: now,
          });
          this.open.delete(name);
          t = undefined;
        }
      }
      if (left > 0n) {
        t ??= { size: 0n, entry: 0n, pnl: 0n, openedAt: now };
        const a = abs(t.size);
        t.entry = (t.entry * a + price * left) / (a + left);
        t.size += d > 0n ? left : -left;
        t.pnl -= this.fee(price, left, m);
        this.open.set(name, t);
      }
    }
    return closed;
  }
}

export interface CooldownStats {
  readonly trades: number;
  readonly losses: number;
  readonly cooldowns: number;
  readonly droppedOpenings: number;
}

/** Losing-streak cooldown. */
export class LossCooldown {
  private streak = 0;
  private until = -Infinity;
  private s = { trades: 0, losses: 0, cooldowns: 0, droppedOpenings: 0 };

  constructor(private readonly cfg: CooldownConfig) {}

  /** Record closed trades; returns a reason string when a cooldown starts. */
  record(trades: readonly ClosedTrade[], now: number): string | undefined {
    let started: string | undefined;
    const tol = BigInt(this.cfg.lossToleranceCents) * 10n ** 16n;
    for (const t of trades) {
      this.s.trades += 1;
      if (t.pnl < -tol) {
        this.s.losses += 1;
        this.streak += 1;
      } else this.streak = 0;
      if (this.cfg.enabled && this.streak >= this.cfg.lossStreak) {
        this.streak = 0;
        this.until = now + this.cfg.cooldownSec;
        this.s.cooldowns += 1;
        started = `${String(this.cfg.lossStreak)} losing trades in a row: only reducing until ${new Date(this.until * 1000).toISOString()}`;
      }
    }
    return started;
  }

  active(now: number): boolean {
    return now < this.until;
  }

  /** Resting orders that would add to a position (or open one), to pull when a cooldown starts. */
  openingOrders(
    tracked: readonly TrackedOrder[],
    positions: Readonly<Record<string, bigint>>,
  ): RestingOrder[] {
    return tracked
      .filter((t) => {
        const p = positions[t.market] ?? 0n;
        return p === 0n || p > 0n === (t.side === 'long');
      })
      .map((t) => ({ market: t.market, orderId: t.orderId }));
  }

  /**
   * During a cooldown: keep reduce-only intents, turn quotes on the reducing side into reduce-only ones capped
   * at the position, drop the rest. Outside a cooldown the intents pass unchanged.
   */
  filter(
    intents: readonly OrderIntent[],
    positions: Readonly<Record<string, bigint>>,
    now: number,
  ): OrderIntent[] {
    if (!this.active(now)) return [...intents];
    const out: OrderIntent[] = [];
    for (const i of intents) {
      if (i.reduceOnly) {
        out.push(i);
        continue;
      }
      const p = positions[i.market] ?? 0n;
      const reduces = p !== 0n && p > 0n === (i.side === 'short');
      if (!reduces) {
        this.s.droppedOpenings += 1;
        continue;
      }
      out.push({
        ...i,
        reduceOnly: true,
        quantity: i.quantity < abs(p) ? i.quantity : abs(p),
        reason: `${i.reason}; cooldown: reduce only`,
      });
    }
    return out;
  }

  stats(): CooldownStats {
    return { ...this.s };
  }
}

/** Our tracked orders that vanished between two views of engine.tracked. */
export function vanishedOrders(
  before: ReadonlyMap<bigint, TrackedOrder>,
  after: ReadonlyMap<bigint, TrackedOrder>,
): TrackedOrder[] {
  return [...before.values()].filter((t) => !after.has(t.orderId));
}
