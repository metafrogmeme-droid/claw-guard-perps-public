// Mapping receipts to ClawGuardReceipts.anchor() arguments. Pure; the sender lives in anchor-viem.ts.
import { parseAbi, type Hex } from 'viem';

import { VERDICT_CODE, type Receipt } from './receipt.js';

/** On-chain code for a re-arm receipt (kill_switch receipt with action "rearm"). */
export const REARM_CODE = 6;

export const RECEIPTS_ABI = parseAbi([
  'struct Anchor { uint64 seq; bytes32 receiptHash; bytes32 prevHash; uint8 verdict; bytes sig; }',
  'function anchor(address signer, bytes32 journal, Anchor a)',
  'function anchorBatch(address signer, bytes32 journal, Anchor[] batch)',
  'function headOf(address signer, bytes32 journal) view returns (uint64 nextSeq, bytes32 head)',
  'function isStopped(address signer) view returns (bool)',
  'function countsOf(address signer) view returns (uint256 allowed, uint256 blocked, uint256 needsOk, uint256 other)',
  'event Anchored(address indexed signer, bytes32 indexed journal, uint64 seq, bytes32 receiptHash, uint8 verdict)',
  'event Stopped(address indexed signer, bytes32 indexed journal, uint64 seq)',
  'event Rearmed(address indexed signer, bytes32 indexed journal, uint64 seq)',
  'error BadVerdict(uint8 verdict)',
  'error BadSignature()',
  'error OutOfOrder(uint64 expectedSeq, uint64 gotSeq)',
  'error WrongPrev(bytes32 expectedPrev, bytes32 gotPrev)',
  'error WrongJournal()',
  'error EmptyBatch()',
]);

export interface AnchorArgs {
  readonly seq: bigint;
  readonly receiptHash: Hex;
  readonly prevHash: Hex;
  readonly verdict: number;
  readonly sig: Hex;
}

export function anchorCode(r: Receipt): number {
  switch (r.kind) {
    case 'decision': {
      const v = r.data['verdict'];
      if (v === 'allowed' || v === 'blocked' || v === 'needs_ok') return VERDICT_CODE[v];
      throw new Error(`receipt ${String(r.seq)}: decision without a verdict`);
    }
    case 'execution':
      return VERDICT_CODE.execution;
    case 'session_aborted':
      // anchored as a non-stopping "other" code: only a real guard trip or a manual kill sets the on-chain stop
      return VERDICT_CODE.execution;
    case 'kill_switch':
      return r.data['action'] === 'rearm' ? REARM_CODE : VERDICT_CODE.kill_switch;
  }
}

export function toAnchor(r: Receipt): AnchorArgs {
  return {
    seq: BigInt(r.seq),
    receiptHash: r.hash,
    prevHash: r.prevHash,
    verdict: anchorCode(r),
    sig: r.sig,
  };
}

/** A journal's on-chain id: the hash of its first receipt. */
export function journalId(receipts: readonly Receipt[]): Hex {
  const first = receipts[0];
  if (first?.seq !== 0) throw new Error('journal must start at receipt 0');
  return first.hash;
}

/** Receipts still to anchor given the on-chain next sequence number, in batches. */
export function pendingBatches(receipts: readonly Receipt[], nextSeq: bigint, size: number): AnchorArgs[][] {
  const todo = receipts.filter((r) => BigInt(r.seq) >= nextSeq).map(toAnchor);
  const out: AnchorArgs[][] = [];
  for (let i = 0; i < todo.length; i += size) out.push(todo.slice(i, i + size));
  return out;
}
