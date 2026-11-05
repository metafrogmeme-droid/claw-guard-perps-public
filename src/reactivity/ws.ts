// `somnia_watch` over a WebSocket: JSON-RPC eth_subscribe, push notifications, reconnect with backoff.
// Network I/O only; the logic lives in watch.ts.
//
// Stall detector: a socket can go half-open (no error, no close, no frames) and a push stream on it is then
// silent forever. Every pingMs the transport sends a cheap request (eth_blockNumber); any frame counts as a
// heartbeat. When no frame has arrived for stallMs it reports "stalled", drops that socket and dials a new one,
// which re-subscribes (and the watcher re-reads isStopped on connect). Every heartbeatLogMs it logs how long
// ago the last frame came, so a quiet log still shows the watcher is alive.
import type {
  ReactivityTransport,
  RawNotification,
  Subscription,
  WatchHandlers,
  WatchParams,
} from './watch.js';

interface RpcMessage {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
  readonly method?: string;
  readonly params?: { readonly subscription?: string; readonly result?: RawNotification };
}

export interface WsTransportOptions {
  /** Send a heartbeat request this often, in ms. Default 30 s. 0 = off. */
  readonly pingMs?: number;
  /** Treat the socket as dead after this long without any frame, in ms. Default 90 s. */
  readonly stallMs?: number;
  /** Log a heartbeat line this often, in ms. Default 10 min. 0 = off. */
  readonly heartbeatLogMs?: number;
  readonly log?: (line: string) => void;
  readonly now?: () => number;
}

const SUBSCRIBE_ID = 1;
const UNSUBSCRIBE_ID = 2;
const PING_ID_BASE = 1000;

export class WsReactivityTransport implements ReactivityTransport {
  private readonly pingMs: number;
  private readonly stallMs: number;
  private readonly heartbeatLogMs: number;
  private readonly now: () => number;

  constructor(
    private readonly url: string,
    private readonly maxBackoffMs = 30_000,
    private readonly opts: WsTransportOptions = {},
  ) {
    this.pingMs = opts.pingMs ?? 30_000;
    this.stallMs = opts.stallMs ?? 90_000;
    this.heartbeatLogMs = opts.heartbeatLogMs ?? 600_000;
    this.now = opts.now ?? Date.now;
  }

  subscribe(params: WatchParams, h: WatchHandlers): Promise<Subscription> {
    let closed = false;
    let ws: WebSocket | undefined;
    let subId: string | undefined;
    const base = Math.min(1_000, this.maxBackoffMs);
    let backoff = base;
    let first = true;
    let lastFrame = this.now();
    let lastHeartbeatLog = this.now();
    let pingId = PING_ID_BASE;
    let ticker: ReturnType<typeof setInterval> | undefined;

    const stopTicker = (): void => {
      if (ticker !== undefined) clearInterval(ticker);
      ticker = undefined;
    };

    return new Promise<Subscription>((resolve, reject) => {
      const reconnectLater = (why: string): void => {
        h.onError(new Error(`${why}; reconnecting in ${String(backoff / 1000)}s`));
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, this.maxBackoffMs);
      };

      const tick = (): void => {
        const sock = ws;
        if (closed || sock === undefined) return;
        const quiet = this.now() - lastFrame;
        if (quiet >= this.stallMs) {
          // retire the silent socket: detach it first so its late events cannot trigger a second reconnect
          ws = undefined;
          sock.onopen = null;
          sock.onmessage = null;
          sock.onerror = null;
          sock.onclose = null;
          try {
            sock.close();
          } catch {
            // already dead
          }
          lastFrame = this.now();
          reconnectLater(`stalled: no frames for ${String(Math.round(quiet / 1000))}s`);
          return;
        }
        if (this.heartbeatLogMs > 0 && this.now() - lastHeartbeatLog >= this.heartbeatLogMs) {
          lastHeartbeatLog = this.now();
          this.opts.log?.(`heartbeat: last frame ${String(Math.round(quiet / 1000))}s ago`);
        }
        if (sock.readyState === WebSocket.OPEN && subId !== undefined) {
          pingId += 1;
          sock.send(JSON.stringify({ jsonrpc: '2.0', id: pingId, method: 'eth_blockNumber', params: [] }));
        }
      };

      const connect = (): void => {
        if (closed) return;
        const sock = new WebSocket(this.url);
        ws = sock;
        lastFrame = this.now();
        sock.onopen = () => {
          lastFrame = this.now();
          sock.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: SUBSCRIBE_ID,
              method: 'eth_subscribe',
              params: ['somnia_watch', params],
            }),
          );
        };
        sock.onmessage = (m: MessageEvent) => {
          lastFrame = this.now();
          let msg: RpcMessage;
          try {
            msg = JSON.parse(String(m.data)) as RpcMessage;
          } catch {
            return;
          }
          if (msg.id === SUBSCRIBE_ID) {
            if (msg.error !== undefined || typeof msg.result !== 'string') {
              const e = new Error(`somnia_watch refused: ${msg.error?.message ?? 'no subscription id'}`);
              if (first) reject(e);
              else h.onError(e);
              closed = true;
              stopTicker();
              sock.close();
              return;
            }
            subId = msg.result;
            backoff = base;
            if (first) {
              first = false;
              resolve({
                unsubscribe: async () => {
                  closed = true;
                  stopTicker();
                  if (ws?.readyState === WebSocket.OPEN && subId !== undefined) {
                    ws.send(
                      JSON.stringify({
                        jsonrpc: '2.0',
                        id: UNSUBSCRIBE_ID,
                        method: 'eth_unsubscribe',
                        params: [subId],
                      }),
                    );
                    await new Promise((r) => setTimeout(r, 200));
                  }
                  ws?.close();
                },
              });
            }
            h.onConnect();
            return;
          }
          const push = msg.params?.result;
          if (msg.method === 'eth_subscription' && msg.params?.subscription === subId && push !== undefined) {
            h.onData(push);
          }
        };
        sock.onerror = () => {
          h.onError(new Error('websocket error'));
        };
        sock.onclose = () => {
          if (closed || ws !== sock) return;
          reconnectLater('websocket closed');
        };
      };
      if (this.pingMs > 0) {
        ticker = setInterval(tick, Math.min(this.pingMs, this.stallMs));
        ticker.unref();
      }
      connect();
    });
  }
}
