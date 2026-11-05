import { describe, expect, it } from 'vitest';

import type { Engine } from '../src/engine/engine.js';
import { killStopLine, stoppedMessage } from '../src/cli/stop.js';
import { anchorCode } from '../src/receipts/anchor.js';
import type { Receipt } from '../src/receipts/receipt.js';
import { closeOut } from '../src/runtime/closeout.js';
import type { VenueSnapshot } from '../src/venue/types.js';

const rec = (kind: Receipt['kind'], data: Record<string, unknown>): Receipt =>
  ({ kind, data, seq: 0 }) as unknown as Receipt;

describe('infra stop does not stop on chain', () => {
  it('session_aborted anchors as a non-stopping code; kill_switch trip still stops', () => {
    expect(anchorCode(rec('session_aborted', { action: 'abort' }))).toBe(4);
    expect(anchorCode(rec('kill_switch', { action: 'trip' }))).toBe(5);
    expect(anchorCode(rec('kill_switch', { action: 'rearm' }))).toBe(6);
  });
});

function fakeEngine(o: { hangFirst?: number }) {
  let flat = false;
  const calls: string[] = [];
  let n = 0;
  const snap = (): VenueSnapshot =>
    ({ orders: [], account: { positions: flat ? {} : { 'BTC-PERP': -1n } } }) as unknown as VenueSnapshot;
  const act = (name: string) => (): Promise<void> => {
    calls.push(name);
    n += 1;
    if (n <= (o.hangFirst ?? 0)) return new Promise(() => undefined); // times out
    flat = true;
    return Promise.resolve();
  };
  const engine = {
    snapshot: () => Promise.resolve(snap()),
    kill: act('kill'),
    abort: act('abort'),
  } as unknown as Engine;
  return { engine, calls };
}

describe('close-out', () => {
  it('uses abort (no kill switch) unless stop is set', async () => {
    const a = fakeEngine({});
    expect(
      (await closeOut(a.engine, { reason: 'rpc timeout', budgetMs: 1000, stepMs: 100, attempts: 3 })).flat,
    ).toBe(true);
    expect(a.calls).toEqual(['abort']);
    const b = fakeEngine({});
    await closeOut(b.engine, { reason: 'guard trip', budgetMs: 1000, stepMs: 100, attempts: 3, stop: true });
    expect(b.calls).toEqual(['kill']);
  });

  it('retries with backoff after a timeout, bounded by attempts', async () => {
    const f = fakeEngine({ hangFirst: 2 });
    const t0 = Date.now();
    const r = await closeOut(f.engine, {
      reason: 'x',
      budgetMs: 5000,
      stepMs: 30,
      attempts: 4,
      backoffMs: 40,
    });
    expect(r.flat).toBe(true);
    expect(f.calls).toEqual(['abort', 'abort', 'abort']);
    expect(r.errors).toHaveLength(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2 * 30 + 40 + 80 - 10); // 40 ms then 80 ms backoff
    const g = fakeEngine({ hangFirst: 99 });
    const r2 = await closeOut(g.engine, {
      reason: 'x',
      budgetMs: 5000,
      stepMs: 10,
      attempts: 2,
      backoffMs: 5,
    });
    expect(r2.flat).toBe(false);
    expect(g.calls).toHaveLength(2);
  });
});

describe('on-chain stop messages', () => {
  it('preflight refusal names the rule and the rearm command', () => {
    const m = stoppedMessage('0xabc', '~/.config/claw-guard-perps/env');
    expect(m).toContain('Blocked by your rule');
    expect(m).toContain('pnpm cli rearm <stop-journal.jsonl> --env ~/.config/claw-guard-perps/env');
  });
  it('kill prints the on-chain state', () => {
    expect(killStopLine(true)).toContain('isStopped = true');
    expect(killStopLine(false)).toContain('isStopped = false');
  });
});
