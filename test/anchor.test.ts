import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import {
  anchorCode,
  journalId,
  pendingBatches,
  REARM_CODE,
  RECEIPTS_ABI,
  toAnchor,
} from '../src/receipts/anchor.js';
import { signReceipt, type Receipt } from '../src/receipts/receipt.js';

// anvil key 0 (public, allowlisted)
const a = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const P = `0x${'11'.repeat(32)}` as const;

async function chain(): Promise<Receipt[]> {
  const r0 = await signReceipt(a, undefined, {
    ts: 1793000000,
    kind: 'decision',
    policyHash: P,
    data: { verdict: 'blocked', codes: ['MARKET_NOT_ALLOWED'] },
  });
  const r1 = await signReceipt(a, r0, {
    ts: 1793000001,
    kind: 'decision',
    policyHash: P,
    data: { verdict: 'allowed' },
  });
  const r2 = await signReceipt(a, r1, {
    ts: 1793000002,
    kind: 'kill_switch',
    policyHash: P,
    data: { action: 'trip' },
  });
  return [r0, r1, r2];
}

describe('anchor', () => {
  it('produces exactly the bytes the Foundry cross-language test anchors', async () => {
    const rs = await chain();
    expect(rs.map((r) => r.hash)).toEqual([
      '0x1e6d6fce5cb028370106e98625b322248a97535fb5789ac6ae5bc7010c658432',
      '0xf437c0c108d316017ec148156d47077e8d57ac54dd2f231f3c70e81b738af6ba',
      '0x48a9fba9c96e5ff82d0dfc08410adc76bd3574583dd5d0e640e0e742725036bc',
    ]);
    expect(rs.map((r) => r.sig)).toEqual([
      '0xb293c8804a73db00a83a5fdd04d94b117bd6ad57fdd9ba86f304e4b1e3574dd95878646ff71e65f929649d7904e93248936f92283258571fc7da3659b1f18c9a1c',
      '0x812e186c7502aec47b5c03741c9dd56c6b35280afe6da086fed02ef29478e9cd2e982fc81524947c4a799ca6c6121c25e71c28b24fbef8b1a1d4e5d8495fcbee1b',
      '0x2d62b0c657c3763923631d0a9d9adf9eacbe7f5892afbad403fb8dc4bedadbe147ec5e90a8e4476fa3698ff26956e1a2f1add33c2fd1ba3128f2abd42ec64aa01b',
    ]);
    expect(rs.map(anchorCode)).toEqual([2, 1, 5]);
    expect(journalId(rs)).toBe(rs[0]?.hash);
  });
  it('maps kinds and batches what is left', async () => {
    const rs = await chain();
    const last = rs[2];
    if (last === undefined) throw new Error('chain');
    expect(anchorCode({ ...last, data: { action: 'rearm' } })).toBe(REARM_CODE);
    expect(anchorCode({ ...last, kind: 'execution' })).toBe(4);
    expect(anchorCode({ ...last, kind: 'decision', data: { verdict: 'needs_ok' } })).toBe(3);
    expect(() => anchorCode({ ...last, kind: 'decision', data: {} })).toThrow(/without a verdict/);
    expect(toAnchor(last).seq).toBe(2n);
    expect(pendingBatches(rs, 0n, 2).map((b) => b.length)).toEqual([2, 1]);
    expect(pendingBatches(rs, 2n, 8).map((b) => b.map((x) => x.seq))).toEqual([[2n]]);
    expect(pendingBatches(rs, 3n, 8)).toEqual([]);
    expect(() => journalId([])).toThrow(/receipt 0/);
    expect(() => journalId(rs.slice(1))).toThrow(/receipt 0/);
    expect(RECEIPTS_ABI.some((x) => x.type === 'function' && x.name === 'anchorBatch')).toBe(true);
  });
});
