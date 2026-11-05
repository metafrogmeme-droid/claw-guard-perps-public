// Session rule 1: RPC health gate.
//
// On 2 Nov both testnet sessions ended early on a single timed-out RPC read (getPosition at 14:40 CET,
// getAccountState at 15:16 CET). PR #21 made one read retry across two RPCs; this gate sits above that and
// decides what the SESSION does when reads stay slow or failing:
//  - a slow read (over slowReadSec) or an infra failure (timeout, socket, HTTP 5xx / 429) PAUSES trading: no new
//    quotes are asked for while the session cannot see the account, and resting quotes are pulled (best effort);
//  - while paused it re-reads with exponential backoff (backoffBaseSec doubling up to backoffMaxSec);
//  - it resumes only after healthyProbes fast reads in a row;
//  - it ends the session (close-out, never an on-chain stop) once one outage lasts maxOutageSec, or all outages
//    in this session add up to maxTotalOutageSec. The blind time is bounded either way.
// Anything that is not an infra failure (a bug, a bad answer) still ends the session at once, like before.
//
// This only makes the bot stricter: it can stop quoting and end a session, never loosen a guard limit.
import { z } from 'zod';

import { CallTimeoutError, StopRequestedError } from './timeout.js';

export const RpcGateSchema = z
  .object({
    /** false = the old behaviour: the first failed read ends the session. */
    enabled: z.boolean().default(true),
    /** A cycle read slower than this counts as unhealthy, seconds. */
    slowReadSec: z.number().positive().max(600).default(20),
    /** First pause before a re-read, seconds; doubles per unhealthy read. */
    backoffBaseSec: z.number().positive().max(600).default(5),
    /** Longest pause between re-reads, seconds. */
    backoffMaxSec: z.number().positive().max(3600).default(60),
    /** End the session when one outage lasts this long, seconds. */
    maxOutageSec: z.number().positive().max(3600).default(600),
    /** End the session when all outages in it add up to this, seconds. */
    maxTotalOutageSec: z.number().positive().max(7200).default(1200),
    /** Fast reads in a row needed to resume quoting. */
    healthyProbes: z.number().int().min(1).max(10).default(2),
    /** Pull resting quotes (best effort cancels) when a pause starts. */
    cancelOnPause: z.boolean().default(true),
  })
  .strict()
  .refine((c) => c.backoffMaxSec >= c.backoffBaseSec, 'backoffMaxSec must be >= backoffBaseSec')
  .refine((c) => c.maxTotalOutageSec >= c.maxOutageSec, 'maxTotalOutageSec must be >= maxOutageSec');

export type RpcGateConfig = z.output<typeof RpcGateSchema>;
export type RpcGateInput = z.input<typeof RpcGateSchema>;

export const DEFAULT_RPC_GATE: RpcGateConfig = RpcGateSchema.parse({});

export function parseRpcGate(input: unknown): RpcGateConfig {
  return RpcGateSchema.parse(input ?? {});
}

const INFRA =
  /timed? ?out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|socket|websocket|network|fetch failed|HTTP request failed|rpc|\b50[234]\b|\b429\b|rate limit|too many requests|connection/i;

/** True for errors that come from the network or the RPC node, not from our own logic. */
export function isInfraError(e: unknown): boolean {
  if (e instanceof StopRequestedError) return false;
  if (e instanceof CallTimeoutError) return true;
  const m = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return INFRA.test(m);
}

export type GateVerdict =
  | { readonly action: 'trade' }
  /** Do not quote this cycle; wait waitSec and read again. `started` is true on the first unhealthy read. */
  | { readonly action: 'pause'; readonly waitSec: number; readonly why: string; readonly started: boolean }
  | { readonly action: 'end'; readonly why: string };

export interface RpcGateStats {
  readonly pauses: number;
  readonly outageSec: number;
  readonly longestOutageSec: number;
  readonly paused: boolean;
}

/** State machine for one session. Time is in the session clock (seconds). */
export class RpcHealthGate {
  private since: number | undefined;
  private closedTotal = 0;
  private longest = 0;
  private streak = 0;
  private unhealthy = 0;
  private count = 0;

  constructor(readonly cfg: RpcGateConfig = DEFAULT_RPC_GATE) {}

  get paused(): boolean {
    return this.since !== undefined;
  }

  stats(now: number): RpcGateStats {
    const open = this.since === undefined ? 0 : now - this.since;
    return {
      pauses: this.count,
      outageSec: this.closedTotal + open,
      longestOutageSec: Math.max(this.longest, open),
      paused: this.paused,
    };
  }

  /** A cycle read finished in latencySec. */
  onRead(latencySec: number, now: number): GateVerdict {
    if (latencySec > this.cfg.slowReadSec) {
      return this.unhealthyRead(
        now,
        `slow read ${latencySec.toFixed(1)} s > ${String(this.cfg.slowReadSec)} s`,
      );
    }
    if (this.since === undefined) return { action: 'trade' };
    this.streak += 1;
    if (this.streak < this.cfg.healthyProbes) {
      return {
        action: 'pause',
        waitSec: this.cfg.backoffBaseSec,
        why: `RPC healthy ${String(this.streak)}/${String(this.cfg.healthyProbes)}`,
        started: false,
      };
    }
    const d = now - this.since;
    this.closedTotal += d;
    this.longest = Math.max(this.longest, d);
    this.since = undefined;
    this.streak = 0;
    this.unhealthy = 0;
    return { action: 'trade' };
  }

  /** A cycle read failed with e. Non-infra errors end the session; infra errors pause it. */
  onError(e: unknown, now: number): GateVerdict {
    const msg = e instanceof Error ? e.message : String(e);
    if (!this.cfg.enabled || !isInfraError(e)) return { action: 'end', why: `error: ${msg}` };
    return this.unhealthyRead(now, msg);
  }

  private unhealthyRead(now: number, why: string): GateVerdict {
    if (!this.cfg.enabled) return { action: 'trade' };
    const started = this.since === undefined;
    if (started) {
      this.since = now;
      this.count += 1;
    }
    this.streak = 0;
    this.unhealthy += 1;
    const open = now - (this.since ?? now);
    if (open >= this.cfg.maxOutageSec) {
      return {
        action: 'end',
        why: `RPC outage ${String(open)} s >= ${String(this.cfg.maxOutageSec)} s (${why})`,
      };
    }
    if (this.closedTotal + open >= this.cfg.maxTotalOutageSec) {
      return {
        action: 'end',
        why: `RPC outages ${String(this.closedTotal + open)} s in total >= ${String(this.cfg.maxTotalOutageSec)} s (${why})`,
      };
    }
    const waitSec = Math.min(this.cfg.backoffMaxSec, this.cfg.backoffBaseSec * 2 ** (this.unhealthy - 1));
    return { action: 'pause', waitSec, why, started };
  }

  /** Before the first cycle: true while the session may keep waiting for a healthy first read. */
  startBudgetLeft(waitedSec: number): boolean {
    return this.cfg.enabled && waitedSec < this.cfg.maxOutageSec;
  }

  /** Backoff for the n-th failed start read (1-based), seconds. */
  startBackoff(n: number): number {
    return Math.min(this.cfg.backoffMaxSec, this.cfg.backoffBaseSec * 2 ** (n - 1));
  }
}
