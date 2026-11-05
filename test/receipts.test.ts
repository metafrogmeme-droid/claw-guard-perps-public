import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fc from 'fast-check';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { evaluate, policyHash } from '../src/gate/index.js';
import {
  GENESIS_HASH,
  Journal,
  hashBody,
  bodyOf,
  parseJournal,
  readJournal,
  signReceipt,
  verifyChain,
  type Receipt,
} from '../src/receipts/index.js';
import { NOW, input, policy } from './fixtures.js';

// Well-known local dev keys (anvil accounts 0 and 1). Never funded on any real network.
const A = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const B = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const PH = policyHash(policy);

async function chain(n: number, signer = A): Promise<Receipt[]> {
  const out: Receipt[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      await signReceipt(signer, out.at(-1), {
        ts: NOW + i,
        kind: 'decision',
        policyHash: PH,
        data: { i, n: 10n ** 20n },
      }),
    );
  }
  return out;
}

describe('receipts', () => {
  it('chains from genesis, signs, and verifies', async () => {
    const rs = await chain(4);
    expect(rs[0]?.prevHash).toBe(GENESIS_HASH);
    expect(rs[1]?.prevHash).toBe(rs[0]?.hash);
    expect(rs[3]?.seq).toBe(3);
    expect(rs[0]?.data).toEqual({ i: 0, n: '100000000000000000000' });
    const v = await verifyChain(rs, A.address);
    expect(v).toMatchObject({ ok: true, count: 4, head: rs[3]?.hash, problems: [] });
    expect((await verifyChain([])).head).toBe(GENESIS_HASH);
  });

  it('hash is independent of key order in the payload', async () => {
    const a = await signReceipt(A, undefined, {
      ts: 1,
      kind: 'decision',
      policyHash: PH,
      data: { x: 1, y: 2 },
    });
    const b = await signReceipt(A, undefined, {
      ts: 1,
      kind: 'decision',
      policyHash: PH,
      data: { y: 2, x: 1 },
    });
    expect(a.hash).toBe(b.hash);
    expect(hashBody(bodyOf(a))).toBe(a.hash);
  });

  it('detects edits, drops, reorders, foreign signers and bad signatures', async () => {
    const rs = await chain(4);
    const [r0, r1, r2, r3] = rs as [Receipt, Receipt, Receipt, Receipt];
    const edited = [r0, { ...r1, data: { i: 99 } }, r2, r3];
    expect((await verifyChain(edited)).problems).toContainEqual({
      seq: 1,
      problem: 'body hash does not match',
    });
    const dropped = [r0, r2, r3];
    const pd = (await verifyChain(dropped)).problems.map((p) => p.problem);
    expect(pd).toContain('previous hash does not match');
    expect(pd).toContain('sequence gap: expected 1');
    expect((await verifyChain([r1, r0])).ok).toBe(false);
    expect((await verifyChain(rs, B.address)).problems[0]).toEqual({
      seq: 0,
      problem: 'signed by an unexpected key',
    });
    const resigned = { ...r0, sig: (await signReceipt(B, undefined, bodyOf(r0))).sig };
    expect((await verifyChain([resigned])).problems.map((p) => p.problem)).toContain(
      'signature is not from the listed signer',
    );
    expect((await verifyChain([{ ...r0, sig: '0x1234' }])).problems).toContainEqual({
      seq: 0,
      problem: 'signature does not parse',
    });
    expect((await verifyChain([{ ...r0, v: 2 }])).problems.map((p) => p.problem)).toContain(
      'unknown version 2',
    );
  });

  it('property: changing any single data field breaks verification', async () => {
    const rs = await chain(3);
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 2 }), fc.string(), async (idx, val) => {
        const copy = rs.map((r, i) => (i === idx ? { ...r, data: { ...r.data, extra: val } } : r));
        expect((await verifyChain(copy)).ok).toBe(false);
      }),
      { numRuns: 30 },
    );
  });
});

describe('journal', () => {
  it('appends JSONL, resumes the chain after reopen, and verifies', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cgp-'));
    const path = join(dir, 'sub', 'receipts.jsonl');
    expect(await readJournal(path)).toEqual([]);
    const j = await Journal.open(path, A, PH);
    const d = evaluate(input());
    await Promise.all([
      j.append('decision', { decision: d }, NOW),
      j.append('execution', { ok: true, tx: '0xabc' }, NOW + 1),
    ]);
    const j2 = await Journal.open(path, A, PH);
    await j2.append('kill_switch', { reason: 'drawdown' }, NOW + 2);
    const all = await readJournal(path);
    expect(all.map((r) => [r.seq, r.kind])).toEqual([
      [0, 'decision'],
      [1, 'execution'],
      [2, 'kill_switch'],
    ]);
    expect((await verifyChain(all, A.address)).ok).toBe(true);
    expect((await readFile(path, 'utf8')).split('\n').filter(Boolean)).toHaveLength(3);
  });

  it('a failed append does not fork the chain', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cgp-'));
    const j = await Journal.open(join(dir, 'r.jsonl'), A, PH);
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    await expect(j.append('decision', circular, NOW)).rejects.toThrow();
    const r = await j.append('decision', { ok: 1 }, NOW);
    expect(r.seq).toBe(0);
  });

  it('reports a corrupt line and rethrows other read errors', async () => {
    expect(() => parseJournal('{"a":1}\nnot json\n')).toThrow('journal line 2 is not JSON');
    const dir = await mkdtemp(join(tmpdir(), 'cgp-'));
    await expect(readJournal(dir)).rejects.toThrow();
    await writeFile(join(dir, 'x.jsonl'), '\n\n', 'utf8');
    expect(await readJournal(join(dir, 'x.jsonl'))).toEqual([]);
  });
});
