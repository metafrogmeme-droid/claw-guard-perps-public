import { encodeAbiParameters, encodeEventTopics, pad, type Hex } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RECEIPTS_ABI } from '../src/receipts/anchor.js';
import {
  decodeNotification,
  IS_STOPPED_SELECTOR,
  StopWatcher,
  TOPIC,
  watchParams,
  type RawNotification,
  type ReactivityTransport,
  type StopCause,
  type WatchHandlers,
} from '../src/reactivity/watch.js';
import { WsReactivityTransport } from '../src/reactivity/ws.js';

const CONTRACT: Hex = '0xeda7071961c518ce154062cb6d8e94219f8c29b3';
const SIGNER: Hex = '0x39791a9Df0bb96EBaEEaE2C6754bB76EbD09C67D';
const OTHER: Hex = '0x000000000000000000000000000000000000dEaD';
const JOURNAL: Hex = `0x${'ab'.repeat(32)}`;
const RECEIPT: Hex = `0x${'cd'.repeat(32)}`;
const bool = (b: boolean): Hex => encodeAbiParameters([{ type: 'bool' }], [b]);

function log(
  name: 'Anchored' | 'Stopped' | 'Rearmed',
  opts: { signer?: Hex; seq?: bigint; verdict?: number; stopped?: boolean } = {},
): RawNotification {
  const signer = opts.signer ?? SIGNER;
  const seq = opts.seq ?? 0n;
  const topics = encodeEventTopics({
    abi: RECEIPTS_ABI,
    eventName: name,
    args: { signer, journal: JOURNAL },
  }) as Hex[];
  const data =
    name === 'Anchored'
      ? encodeAbiParameters(
          [{ type: 'uint64' }, { type: 'bytes32' }, { type: 'uint8' }],
          [seq, RECEIPT, opts.verdict ?? 1],
        )
      : encodeAbiParameters([{ type: 'uint64' }], [seq]);
  return {
    address: CONTRACT,
    topics,
    data,
    ...(opts.stopped === undefined ? {} : { simulationResults: [bool(opts.stopped)] }),
  };
}

class FakeTransport implements ReactivityTransport {
  h: WatchHandlers | undefined;
  params: unknown;
  unsubscribed = false;
  subscribe(params: unknown, h: WatchHandlers) {
    this.params = params;
    this.h = h;
    h.onConnect();
    return Promise.resolve({
      unsubscribe: () => {
        this.unsubscribed = true;
        return Promise.resolve();
      },
    });
  }
}

function setup(initiallyStopped = false) {
  const t = new FakeTransport();
  const stops: StopCause[] = [];
  const rearms: unknown[] = [];
  const lines: string[] = [];
  let chainStopped = initiallyStopped;
  const w = new StopWatcher({
    transport: t,
    contract: CONTRACT,
    signer: SIGNER,
    readStopped: () => Promise.resolve(chainStopped),
    onStop: (c) => {
      stops.push(c);
      return Promise.resolve();
    },
    onRearm: (e) => {
      rearms.push(e);
      return Promise.resolve();
    },
    log: (l) => lines.push(l),
  });
  return {
    t,
    w,
    stops,
    rearms,
    lines,
    setChain: (b: boolean) => {
      chainStopped = b;
    },
  };
}

describe('somnia_watch subscription', () => {
  it('filters on the three receipt events and this signer, and simulates isStopped(topic2)', () => {
    const p = watchParams(CONTRACT, SIGNER);
    expect(p.address).toBe(CONTRACT);
    expect(p.topics[0]).toEqual([TOPIC.Anchored, TOPIC.Stopped, TOPIC.Rearmed]);
    expect(p.topics[1]).toBe(pad(SIGNER.toLowerCase() as Hex));
    expect(p.eth_calls).toEqual([{ to: CONTRACT, data: IS_STOPPED_SELECTOR }]);
    expect(IS_STOPPED_SELECTOR).toMatch(/^0x[0-9a-f]{8}$/);
    expect(p.context).toEqual(['topic2']);
  });

  it('decodes each event and the simulated stop flag', () => {
    const a = decodeNotification(log('Anchored', { seq: 3n, verdict: 2, stopped: false }));
    expect(a).toMatchObject({
      name: 'Anchored',
      seq: 3n,
      verdict: 2,
      receiptHash: RECEIPT,
      stoppedAfter: false,
    });
    expect(decodeNotification(log('Stopped', { seq: 4n, stopped: true }))).toMatchObject({
      name: 'Stopped',
      seq: 4n,
      stoppedAfter: true,
    });
    expect(decodeNotification(log('Rearmed'))?.stoppedAfter).toBeUndefined();
    expect(
      decodeNotification({ address: CONTRACT, topics: [`0x${'00'.repeat(32)}`], data: '0x' }),
    ).toBeUndefined();
  });
});

describe('StopWatcher', () => {
  it('trips once on an on-chain stop, ignores other signers, and re-arms', async () => {
    const s = setup();
    await s.w.start();
    await s.w.idle();
    expect(s.w.stopped).toBe(false);
    s.w.push(log('Anchored', { signer: OTHER, verdict: 5, stopped: true }));
    s.w.push(log('Anchored', { seq: 0n, verdict: 1, stopped: false }));
    await s.w.idle();
    expect(s.stops).toHaveLength(0);
    s.w.push(log('Anchored', { seq: 1n, verdict: 5, stopped: true }));
    s.w.push(log('Stopped', { seq: 1n, stopped: true }));
    await s.w.idle();
    expect(s.stops).toHaveLength(1);
    expect(s.stops[0]).toMatchObject({ source: 'event', event: { name: 'Anchored', seq: 1n } });
    expect(s.w.reactions).toBe(1);
    s.w.push(log('Rearmed', { seq: 2n }));
    await s.w.idle();
    expect(s.w.stopped).toBe(false);
    expect(s.rearms).toHaveLength(1);
    expect(s.w.events).toHaveLength(4);
    await s.w.stop();
    expect(s.t.unsubscribed).toBe(true);
  });

  it('falls back to the event name when the node sends no simulation result', async () => {
    const s = setup();
    await s.w.start();
    s.w.push(log('Stopped', { seq: 7n }));
    await s.w.idle();
    expect(s.stops).toHaveLength(1);
  });

  it('reacts on connect when the stop is already on, and re-checks after a reconnect', async () => {
    const s = setup(true);
    await s.w.start();
    await s.w.idle();
    expect(s.stops).toEqual([{ source: 'state', at: 'connect' }]);
    // a re-arm happened while the socket was down; the reconnect read catches it
    s.setChain(false);
    s.t.h?.onConnect();
    await s.w.idle();
    expect(s.rearms).toEqual([undefined]);
    s.setChain(true);
    s.t.h?.onConnect();
    await s.w.idle();
    expect(s.stops).toHaveLength(2);
  });

  it('logs a failed reaction and keeps watching', async () => {
    const t = new FakeTransport();
    const lines: string[] = [];
    let n = 0;
    const w = new StopWatcher({
      transport: t,
      contract: CONTRACT,
      signer: SIGNER,
      readStopped: () => Promise.resolve(false),
      onStop: () => {
        n += 1;
        return n === 1 ? Promise.reject(new Error('venue down')) : Promise.resolve();
      },
      log: (l) => lines.push(l),
    });
    await w.start();
    t.h?.onError(new Error('websocket closed'));
    w.push(log('Stopped', { stopped: true }));
    await w.idle();
    expect(lines.some((l) => l.includes('reaction failed: venue down'))).toBe(true);
    expect(lines.some((l) => l.includes('websocket closed'))).toBe(true);
    w.push(log('Rearmed', { stopped: false }));
    w.push(log('Stopped', { seq: 2n, stopped: true }));
    await w.idle();
    expect(n).toBe(2);
  });
});

// A scripted stand-in for the global WebSocket.
class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  static readonly defaultReply = (m: { id: number; method: string }): unknown =>
    m.method === 'eth_subscribe' ? { id: m.id, result: '0xsub' } : { id: m.id, result: true };
  static reply = FakeSocket.defaultReply;
  readyState = 0;
  sent: { id: number; method: string; params: unknown[] }[] = [];
  onopen: (() => void) | undefined;
  onmessage: ((m: { data: string }) => void) | undefined;
  onerror: (() => void) | undefined;
  onclose: (() => void) | undefined;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }
  send(s: string) {
    const m = JSON.parse(s) as { id: number; method: string; params: unknown[] };
    this.sent.push(m);
    const r = FakeSocket.reply(m);
    if (r !== undefined) setTimeout(() => this.onmessage?.({ data: JSON.stringify(r) }), 0);
  }
  emit(raw: string) {
    this.onmessage?.({ data: raw });
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

function sock(i: number): FakeSocket {
  const s = FakeSocket.all[i];
  if (s === undefined) throw new Error(`no socket ${String(i)}`);
  return s;
}

describe('WsReactivityTransport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    FakeSocket.all = [];
    FakeSocket.reply = FakeSocket.defaultReply;
  });

  it('subscribes with somnia_watch, delivers pushes for its subscription only, reconnects, unsubscribes', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const data: RawNotification[] = [];
    const errors: string[] = [];
    let connects = 0;
    const t = new WsReactivityTransport('wss://example.invalid/ws', 10);
    const sub = await t.subscribe(watchParams(CONTRACT, SIGNER), {
      onData: (n) => data.push(n),
      onConnect: () => (connects += 1),
      onError: (e) => errors.push(e.message),
    });
    const s = sock(0);
    expect(s.sent[0]).toMatchObject({
      method: 'eth_subscribe',
      params: ['somnia_watch', { address: CONTRACT }],
    });
    const push = log('Stopped', { stopped: true });
    s.emit(JSON.stringify({ method: 'eth_subscription', params: { subscription: '0xsub', result: push } }));
    s.emit(JSON.stringify({ method: 'eth_subscription', params: { subscription: '0xother', result: push } }));
    s.emit('not json');
    expect(data).toEqual([push]);
    expect(connects).toBe(1);
    s.onerror?.();
    s.close();
    await vi.waitFor(() => {
      expect(connects).toBe(2);
    });
    expect(errors[0]).toBe('websocket error');
    expect(errors[1]).toMatch(/reconnecting/);
    await sub.unsubscribe();
    const s2 = sock(1);
    expect(s2.sent.at(-1)).toMatchObject({ method: 'eth_unsubscribe', params: ['0xsub'] });
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('rejects when the node refuses the subscription', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    FakeSocket.reply = (m) => ({ id: m.id, error: { message: 'method not found' } });
    const t = new WsReactivityTransport('wss://example.invalid/ws');
    await expect(
      t.subscribe(watchParams(CONTRACT, SIGNER), { onData: vi.fn(), onConnect: vi.fn(), onError: vi.fn() }),
    ).rejects.toThrow('somnia_watch refused: method not found');
  });

  it('reports a refusal after a reconnect as an error instead of rejecting', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    let calls = 0;
    FakeSocket.reply = (m) => {
      if (m.method !== 'eth_subscribe') return undefined;
      calls += 1;
      return calls === 1 ? { id: m.id, result: '0xsub' } : { id: m.id };
    };
    const errors: string[] = [];
    const t = new WsReactivityTransport('wss://example.invalid/ws', 10);
    const sub = await t.subscribe(watchParams(CONTRACT, SIGNER), {
      onData: vi.fn(),
      onConnect: vi.fn(),
      onError: (e) => errors.push(e.message),
    });
    sock(0).close();
    await vi.waitFor(() => {
      expect(errors).toContain('somnia_watch refused: no subscription id');
    });
    await sub.unsubscribe();
  });

  it('stall detector: pings keep a quiet socket alive, a silent one is dropped and re-dialled', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    const errors: string[] = [];
    const logs: string[] = [];
    let connects = 0;
    const t = new WsReactivityTransport('wss://example.invalid/ws', 10, {
      pingMs: 100,
      stallMs: 300,
      heartbeatLogMs: 150,
      log: (l) => logs.push(l),
    });
    const p = t.subscribe(watchParams(CONTRACT, SIGNER), {
      onData: vi.fn(),
      onConnect: () => (connects += 1),
      onError: (e) => errors.push(e.message),
    });
    await vi.advanceTimersByTimeAsync(5);
    const sub = await p;
    // quiet but alive: heartbeat requests are answered, so no stall
    await vi.advanceTimersByTimeAsync(600);
    expect(sock(0).sent.some((m) => m.method === 'eth_blockNumber')).toBe(true);
    expect(errors).toEqual([]);
    expect(logs.some((l) => /^heartbeat: last frame \d+s ago$/.test(l))).toBe(true);
    // half-open: the node stops answering anything on this socket
    FakeSocket.reply = (m) => (m.method === 'eth_subscribe' ? { id: m.id, result: '0xsub' } : undefined);
    await vi.advanceTimersByTimeAsync(500);
    expect(errors.some((e) => /^stalled: no frames for \d+s; reconnecting/.test(e))).toBe(true);
    expect(FakeSocket.all).toHaveLength(2);
    expect(connects).toBe(2);
    // a late close from the dropped socket does not start a second reconnect
    sock(0).close();
    await vi.advanceTimersByTimeAsync(50);
    expect(FakeSocket.all).toHaveLength(2);
    const u = sub.unsubscribe();
    await vi.advanceTimersByTimeAsync(250);
    await u;
  });
});
