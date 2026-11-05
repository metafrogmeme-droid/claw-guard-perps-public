// Append-only JSONL journal of receipts. One receipt per line; the file is the audit trail.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Hex, LocalAccount } from 'viem';

import { signReceipt, type Receipt, type ReceiptKind } from './receipt.js';

export function parseJournal(text: string): Receipt[] {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l, i) => {
      try {
        return JSON.parse(l) as Receipt;
      } catch {
        throw new Error(`journal line ${String(i + 1)} is not JSON`);
      }
    });
}

export async function readJournal(path: string): Promise<Receipt[]> {
  try {
    return parseJournal(await readFile(path, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

export class Journal {
  private head: Receipt | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly path: string,
    private readonly signer: LocalAccount,
    private readonly policyHash: Hex,
    readonly receipts: Receipt[],
  ) {
    this.head = receipts.at(-1);
  }

  static async open(path: string, signer: LocalAccount, policyHash: Hex): Promise<Journal> {
    await mkdir(dirname(path), { recursive: true });
    return new Journal(path, signer, policyHash, await readJournal(path));
  }

  /** Sign and append one receipt. Calls are serialized so the chain never forks. */
  append(kind: ReceiptKind, data: Readonly<Record<string, unknown>>, ts: number): Promise<Receipt> {
    const next = this.queue.then(async () => {
      const r = await signReceipt(this.signer, this.head, { ts, kind, policyHash: this.policyHash, data });
      await appendFile(this.path, `${JSON.stringify(r)}\n`, 'utf8');
      this.head = r;
      this.receipts.push(r);
      return r;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}
