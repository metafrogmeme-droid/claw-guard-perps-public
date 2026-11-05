// Somnia Reactivity watcher for ClawGuardReceipts (off-chain reactivity, `somnia_watch`).
//
// The node pushes every Anchored / Stopped / Rearmed log for one receipt signer the moment its block lands, and
// runs isStopped(signer) against the same block state, so each push carries the event AND the stop flag it
// produced. When the flag turns on, the watcher calls onStop (the CLI trips the engine's kill switch: cancel
// every resting order, reduce every position). When it turns off again (a re-arm receipt), onRearm runs.
//
// A push subscription lives on one WebSocket and misses whatever happens while it is down, so on every
// (re)connect the watcher re-reads isStopped over plain RPC before trusting the stream again.
import {
  decodeAbiParameters,
  decodeEventLog,
  encodeFunctionData,
  pad,
  toEventSelector,
  type Hex,
} from 'viem';

import { RECEIPTS_ABI } from '../receipts/anchor.js';

export const TOPIC = {
  Anchored: toEventSelector('Anchored(address,bytes32,uint64,bytes32,uint8)'),
  Stopped: toEventSelector('Stopped(address,bytes32,uint64)'),
  Rearmed: toEventSelector('Rearmed(address,bytes32,uint64)'),
} as const;

/** `isStopped(address)` selector; the node appends the log's signer topic to it (context "topic2"). */
export const IS_STOPPED_SELECTOR = encodeFunctionData({
  abi: RECEIPTS_ABI,
  functionName: 'isStopped',
  args: ['0x0000000000000000000000000000000000000000'],
}).slice(0, 10) as Hex;

/** Parameters of `eth_subscribe("somnia_watch", …)`. */
export interface WatchParams {
  readonly address: Hex;
  readonly topics: readonly (readonly Hex[] | Hex | null)[];
  readonly eth_calls: readonly { readonly to: Hex; readonly data: Hex }[];
  readonly context: readonly string[];
  readonly push_changes_only: boolean;
}

/** The `result` of one `eth_subscription` push. */
export interface RawNotification {
  readonly address: Hex;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly simulationResults?: readonly Hex[];
}

export function watchParams(contract: Hex, signer: Hex): WatchParams {
  return {
    address: contract,
    topics: [[TOPIC.Anchored, TOPIC.Stopped, TOPIC.Rearmed], pad(signer.toLowerCase() as Hex)],
    eth_calls: [{ to: contract, data: IS_STOPPED_SELECTOR }],
    context: ['topic2'],
    push_changes_only: false,
  };
}

export interface WatchEvent {
  readonly name: 'Anchored' | 'Stopped' | 'Rearmed';
  readonly signer: Hex;
  readonly journal: Hex;
  readonly seq: bigint;
  readonly verdict?: number;
  readonly receiptHash?: Hex;
  /** isStopped(signer) right after the log, as simulated by the node in the same block. */
  readonly stoppedAfter?: boolean;
}

export function decodeNotification(n: RawNotification): WatchEvent | undefined {
  let ev;
  try {
    ev = decodeEventLog({
      abi: RECEIPTS_ABI,
      topics: n.topics as [Hex, ...Hex[]],
      data: n.data,
    });
  } catch {
    return undefined;
  }
  const sim = n.simulationResults?.[0];
  let stoppedAfter: boolean | undefined;
  if (sim?.length === 66) {
    [stoppedAfter] = decodeAbiParameters([{ type: 'bool' }], sim);
  }
  const extra = stoppedAfter === undefined ? {} : { stoppedAfter };
  switch (ev.eventName) {
    case 'Anchored':
      return {
        name: 'Anchored',
        signer: ev.args.signer,
        journal: ev.args.journal,
        seq: ev.args.seq,
        verdict: ev.args.verdict,
        receiptHash: ev.args.receiptHash,
        ...extra,
      };
    case 'Stopped':
    case 'Rearmed':
      return {
        name: ev.eventName,
        signer: ev.args.signer,
        journal: ev.args.journal,
        seq: ev.args.seq,
        ...extra,
      };
    default:
      return undefined;
  }
}

export interface Subscription {
  unsubscribe(): Promise<void>;
}

export interface WatchHandlers {
  onData(n: RawNotification): void;
  /** Called after every successful (re)subscribe. */
  onConnect(): void;
  onError(e: Error): void;
}

export interface ReactivityTransport {
  subscribe(params: WatchParams, h: WatchHandlers): Promise<Subscription>;
}

export type StopCause =
  | { readonly source: 'event'; readonly event: WatchEvent }
  | { readonly source: 'state'; readonly at: 'connect' };

export interface WatcherOptions {
  readonly transport: ReactivityTransport;
  readonly contract: Hex;
  readonly signer: Hex;
  /** Plain RPC read of isStopped(signer), used on every (re)connect. */
  readonly readStopped: () => Promise<boolean>;
  readonly onStop: (cause: StopCause) => Promise<void>;
  readonly onRearm?: (event: WatchEvent | undefined) => Promise<void>;
  readonly onEvent?: (event: WatchEvent) => void;
  readonly log?: (line: string) => void;
}

export class StopWatcher {
  /** undefined until the first read or push. */
  stopped: boolean | undefined;
  readonly events: WatchEvent[] = [];
  reactions = 0;
  private sub: Subscription | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: WatcherOptions) {}

  async start(): Promise<void> {
    this.sub = await this.o.transport.subscribe(watchParams(this.o.contract, this.o.signer), {
      onData: (n) => {
        this.push(n);
      },
      onConnect: () => {
        this.enqueue(async () => {
          const s = await this.o.readStopped();
          this.o.log?.(`[watch] subscribed; isStopped(${this.o.signer}) = ${String(s)}`);
          await this.transition(s, { source: 'state', at: 'connect' }, undefined);
        });
      },
      onError: (e) => this.o.log?.(`[watch] ${e.message}`),
    });
  }

  async stop(): Promise<void> {
    await this.sub?.unsubscribe();
    await this.idle();
  }

  /** Resolves when every queued reaction has finished. */
  idle(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  /** Feed one push. Exposed for tests and replays. */
  push(n: RawNotification): void {
    const ev = decodeNotification(n);
    if (ev?.signer.toLowerCase() !== this.o.signer.toLowerCase()) return;
    this.events.push(ev);
    this.o.onEvent?.(ev);
    const next =
      ev.stoppedAfter ?? (ev.name === 'Stopped' ? true : ev.name === 'Rearmed' ? false : undefined);
    if (next === undefined) return;
    this.enqueue(() => this.transition(next, { source: 'event', event: ev }, ev));
  }

  private enqueue(f: () => Promise<void>): void {
    const run = this.queue.then(f);
    this.queue = run.catch((e: unknown) => {
      this.o.log?.(`[watch] reaction failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  private async transition(next: boolean, cause: StopCause, ev: WatchEvent | undefined): Promise<void> {
    const prev = this.stopped;
    this.stopped = next;
    if (next && prev !== true) {
      this.reactions += 1;
      await this.o.onStop(cause);
    } else if (!next && prev === true) {
      await this.o.onRearm?.(ev);
    }
  }
}
