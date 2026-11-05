import { encodeAbiParameters, encodeEventTopics, pad, parseAbi, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { DEMO_POLICY, parsePolicy } from '../src/gate/policy.js';
import { usd } from '../src/gate/units.js';
import {
  decodePosition,
  judgePosition,
  POSITION_UPDATED,
  PositionGuard,
  positionWatchParams,
  type PositionVerdict,
} from '../src/reactivity/positions.js';
import type { RawNotification, ReactivityTransport, WatchHandlers } from '../src/reactivity/watch.js';

const BANK: Hex = '0x478769E1177C0773c43A593DCCc4Ad15F15F1394';
const ACCOUNT: Hex = '0x3C9650bb62e913c33F662D6De2F4C0C5C617a898';
const BTC_POOL: Hex = '0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0';
const ODD_POOL: Hex = '0x00000000000000000000000000000000000000aa';
const policy = parsePolicy(DEMO_POLICY);
const ABI = parseAbi([
  'event PositionUpdated(address indexed account, address indexed perpPool, int128 newSize, uint128 avgEntryPrice, int256 realizedPnl, int256 entryFundingIndex)',
]);
const BTC = { market: 'BTC-PERP', baseDecimals: 8, markPrice: usd('78000') };

function upd(size: bigint, opts: { account?: Hex; pool?: Hex; pnl?: bigint } = {}): RawNotification {
  return {
    address: BANK,
    topics: encodeEventTopics({
      abi: ABI,
      eventName: 'PositionUpdated',
      args: { account: opts.account ?? ACCOUNT, perpPool: opts.pool ?? BTC_POOL },
    }) as Hex[],
    data: encodeAbiParameters(
      [{ type: 'int128' }, { type: 'uint128' }, { type: 'int256' }, { type: 'int256' }],
      [size, usd('78197.2'), opts.pnl ?? 0n, 0n],
    ),
  };
}

describe('PositionUpdated watch', () => {
  it('filters MarginBank PositionUpdated on topic1 = account', () => {
    const p = positionWatchParams(BANK, ACCOUNT);
    expect(p.address).toBe(BANK);
    expect(p.topics).toEqual([[POSITION_UPDATED], pad(ACCOUNT.toLowerCase() as Hex)]);
  });

  it('decodes the event (and ignores anything else)', () => {
    const d = decodePosition(upd(14_000n, { pnl: 896n }));
    expect(d?.pool.toLowerCase()).toBe(BTC_POOL);
    expect(d).toMatchObject({
      newSize: 14_000n,
      realizedPnl: 896n,
    });
    expect(decodePosition({ address: BANK, topics: [`0x${'00'.repeat(32)}`], data: '0x' })).toBeUndefined();
  });

  it('judges each case with the gate wording', () => {
    const j = (size: bigint, m: typeof BTC | undefined = BTC, stopped = false) =>
      judgePosition(decodePosition(upd(size)) ?? (undefined as never), m, policy, stopped);
    expect(j(0n).code).toBe('OK');
    expect(j(14_000n)).toMatchObject({
      code: 'OK',
      message: 'Allowed: within your limits (BTC-PERP 10.92 USD)',
    });
    expect(j(-100_000n).code).toBe('POSITION_CAP'); // 0.001 BTC = 78 USD > 60
    expect(j(-100_000n).message).toBe(
      'Blocked by your rule: POSITION_CAP (BTC-PERP position 78.00 USD, limit 60.00 USD)',
    );
    expect(
      judgePosition(decodePosition(upd(14_000n)) ?? (undefined as never), undefined, policy, false).code,
    ).toBe('UNKNOWN_MARKET');
    expect(j(14_000n, { ...BTC, market: 'DOGE-PERP' }).code).toBe('UNKNOWN_MARKET');
    expect(j(14_000n, BTC, true).code).toBe('WHILE_STOPPED');
    expect(j(14_000n, { ...BTC, markPrice: 0n }).code).toBe('OK');
  });
});

describe('PositionGuard', () => {
  function setup(stopped = false) {
    let h: WatchHandlers | undefined;
    let unsub = false;
    const transport: ReactivityTransport = {
      subscribe: (_p, handlers) => {
        h = handlers;
        handlers.onConnect();
        return Promise.resolve({
          unsubscribe: () => {
            unsub = true;
            return Promise.resolve();
          },
        });
      },
    };
    const breaches: PositionVerdict[] = [];
    const lines: string[] = [];
    const g = new PositionGuard({
      transport,
      marginBank: BANK,
      account: ACCOUNT,
      policy,
      market: (pool) => (pool.toLowerCase() === BTC_POOL ? BTC : undefined),
      stopped: () => stopped,
      onBreach: (v) => {
        breaches.push(v);
        return v.code === 'UNKNOWN_MARKET' ? Promise.reject(new Error('venue down')) : Promise.resolve();
      },
      log: (l) => lines.push(l),
    });
    return { g, breaches, lines, h: () => h, unsub: () => unsub };
  }

  it('reacts to a breach pushed on-chain and ignores in-limit updates and other accounts', async () => {
    const s = setup();
    await s.g.start();
    s.g.push(upd(14_000n));
    s.g.push(upd(500_000n, { account: '0x000000000000000000000000000000000000dEaD' }));
    s.g.push(upd(0n));
    await s.g.idle();
    expect(s.breaches).toHaveLength(0);
    s.g.push(upd(100_000n));
    await s.g.idle();
    expect(s.breaches.map((b) => b.code)).toEqual(['POSITION_CAP']);
    expect(s.g.events).toHaveLength(3);
    s.h()?.onError(new Error('websocket closed'));
    expect(s.lines.some((l) => l.includes('subscribed'))).toBe(true);
    expect(s.lines.some((l) => l.includes('websocket closed'))).toBe(true);
    await s.g.stop();
    expect(s.unsub()).toBe(true);
  });

  it('logs a failed reaction and keeps guarding; a position while stopped is a breach', async () => {
    const s = setup(true);
    await s.g.start();
    s.g.push(upd(14_000n, { pool: ODD_POOL }));
    s.g.push(upd(14_000n));
    await s.g.idle();
    expect(s.breaches.map((b) => b.code)).toEqual(['UNKNOWN_MARKET', 'WHILE_STOPPED']);
    expect(s.lines.some((l) => l.includes('reaction failed: venue down'))).toBe(true);
    expect(s.g.breaches).toBe(2);
  });
});
