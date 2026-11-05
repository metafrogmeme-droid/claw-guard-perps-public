// Signed, hash-chained decision receipts.
//
// Every gate decision, venue result and kill-switch action becomes one receipt. A receipt's hash is
// keccak256 of the canonical JSON of its body; the body carries the previous receipt's hash, so editing,
// dropping or reordering any record breaks the chain. The gate signer signs the hash (EIP-191), so a
// verifier only needs the signer address to check a whole journal.
import { keccak256, recoverMessageAddress, stringToBytes, zeroHash, type Hex, type LocalAccount } from 'viem';

import { canonicalJson } from '../gate/policy.js';

export const RECEIPT_VERSION = 1;
export const GENESIS_HASH: Hex = zeroHash;

/** session_aborted: an infra/error or end-of-session close-out. It is journaled honestly but never stops on chain. */
export type ReceiptKind = 'decision' | 'execution' | 'kill_switch' | 'session_aborted';

/** On-chain verdict byte, shared with ClawGuardReceipts.sol. */
export const VERDICT_CODE = { allowed: 1, blocked: 2, needs_ok: 3, execution: 4, kill_switch: 5 } as const;

export interface ReceiptBody {
  readonly v: number;
  readonly seq: number;
  /** Unix seconds. */
  readonly ts: number;
  readonly kind: ReceiptKind;
  readonly prevHash: Hex;
  readonly policyHash: Hex;
  readonly signer: Hex;
  /** Kind-specific payload. Bigints are stored as decimal strings by canonicalJson. */
  readonly data: Readonly<Record<string, unknown>>;
}

export interface Receipt extends ReceiptBody {
  readonly hash: Hex;
  readonly sig: Hex;
}

export function bodyOf(r: Receipt): ReceiptBody {
  return {
    v: r.v,
    seq: r.seq,
    ts: r.ts,
    kind: r.kind,
    prevHash: r.prevHash,
    policyHash: r.policyHash,
    signer: r.signer,
    data: r.data,
  };
}

export function hashBody(body: ReceiptBody): Hex {
  return keccak256(stringToBytes(canonicalJson(body)));
}

/** Plain JSON copy of a payload: bigints become decimal strings, key order is canonical. */
export function normalizeData(data: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return JSON.parse(canonicalJson(data)) as Record<string, unknown>;
}

export async function signReceipt(
  signer: LocalAccount,
  prev: { readonly seq: number; readonly hash: Hex } | undefined,
  fields: {
    readonly ts: number;
    readonly kind: ReceiptKind;
    readonly policyHash: Hex;
    readonly data: Readonly<Record<string, unknown>>;
  },
): Promise<Receipt> {
  const body: ReceiptBody = {
    v: RECEIPT_VERSION,
    seq: prev === undefined ? 0 : prev.seq + 1,
    ts: fields.ts,
    kind: fields.kind,
    prevHash: prev?.hash ?? GENESIS_HASH,
    policyHash: fields.policyHash,
    signer: signer.address,
    data: normalizeData(fields.data),
  };
  const hash = hashBody(body);
  const sig = await signer.signMessage({ message: { raw: hash } });
  return { ...body, hash, sig };
}

export interface VerifyProblem {
  readonly seq: number;
  readonly problem: string;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly count: number;
  readonly head: Hex;
  readonly problems: readonly VerifyProblem[];
}

/**
 * Check a full journal: versions, sequence numbers, the hash of each body, the link to the previous
 * hash, and each signature. When `expectedSigner` is given, every receipt must be signed by it.
 */
export async function verifyChain(receipts: readonly Receipt[], expectedSigner?: Hex): Promise<VerifyResult> {
  const problems: VerifyProblem[] = [];
  let prev: Hex = GENESIS_HASH;
  for (const [i, r] of receipts.entries()) {
    const seq = i;
    if (r.v !== RECEIPT_VERSION) problems.push({ seq, problem: `unknown version ${String(r.v)}` });
    if (r.seq !== i) problems.push({ seq, problem: `sequence gap: expected ${String(i)}` });
    if (r.prevHash !== prev) problems.push({ seq, problem: 'previous hash does not match' });
    const want = hashBody(bodyOf(r));
    if (r.hash !== want) problems.push({ seq, problem: 'body hash does not match' });
    try {
      const who = await recoverMessageAddress({ message: { raw: want }, signature: r.sig });
      if (who.toLowerCase() !== r.signer.toLowerCase())
        problems.push({ seq, problem: 'signature is not from the listed signer' });
      if (expectedSigner !== undefined && who.toLowerCase() !== expectedSigner.toLowerCase())
        problems.push({ seq, problem: 'signed by an unexpected key' });
    } catch {
      problems.push({ seq, problem: 'signature does not parse' });
    }
    prev = r.hash;
  }
  return { ok: problems.length === 0, count: receipts.length, head: prev, problems };
}
