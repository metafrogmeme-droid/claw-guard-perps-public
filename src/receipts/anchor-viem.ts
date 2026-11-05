// Deploys ClawGuardReceipts and anchors a journal on Somnia Tokyo testnet. Network I/O only.
import { readFile } from 'node:fs/promises';

import { createPublicClient, createWalletClient, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  RECEIPT_WAIT_MS,
  httpTransport,
  assertTestnetChainId,
  chainOf,
  type NetworkConfig,
} from '../venue/network.js';
import { journalId, pendingBatches, RECEIPTS_ABI } from './anchor.js';
import type { Receipt } from './receipt.js';

export const ARTIFACT = 'contracts/out/ClawGuardReceipts.sol/ClawGuardReceipts.json';

async function clients(net: NetworkConfig, key: Hex) {
  const chain = chainOf(net);
  const transport = httpTransport(net);
  const pub = createPublicClient({ chain, transport }) as PublicClient;
  assertTestnetChainId(await pub.getChainId(), net);
  const account = privateKeyToAccount(key);
  return { pub, wallet: createWalletClient({ account, chain, transport }), account };
}

export async function deployReceipts(net: NetworkConfig, key: Hex): Promise<{ address: Hex; txHash: Hex }> {
  const art = JSON.parse(await readFile(ARTIFACT, 'utf8')) as { bytecode: { object: Hex } };
  const { pub, wallet } = await clients(net, key);
  const txHash = await wallet.deployContract({ abi: RECEIPTS_ABI, bytecode: art.bytecode.object });
  const rc = await pub.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_WAIT_MS });
  if (rc.status !== 'success' || rc.contractAddress == null) throw new Error(`deploy reverted: ${txHash}`);
  return { address: rc.contractAddress, txHash };
}

export async function anchorJournal(
  net: NetworkConfig,
  key: Hex,
  contract: Hex,
  receipts: readonly Receipt[],
  batchSize = 8,
): Promise<{ journal: Hex; txHashes: Hex[]; nextSeq: bigint }> {
  const { pub, wallet, account } = await clients(net, key);
  const first = receipts[0];
  if (first === undefined) throw new Error('empty journal');
  const signer = first.signer;
  const journal = journalId(receipts);
  const [next] = await pub.readContract({
    address: contract,
    abi: RECEIPTS_ABI,
    functionName: 'headOf',
    args: [signer, journal],
  });
  const txHashes: Hex[] = [];
  for (const batch of pendingBatches(receipts, next, batchSize)) {
    const { request } = await pub.simulateContract({
      address: contract,
      abi: RECEIPTS_ABI,
      functionName: 'anchorBatch',
      args: [signer, journal, batch],
      account,
    });
    const hash = await wallet.writeContract(request);
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: RECEIPT_WAIT_MS });
    if (rc.status !== 'success') throw new Error(`anchor reverted: ${hash}`);
    txHashes.push(hash);
  }
  const [after] = await pub.readContract({
    address: contract,
    abi: RECEIPTS_ABI,
    functionName: 'headOf',
    args: [signer, journal],
  });
  return { journal, txHashes, nextSeq: after };
}

/** isStopped(signer) on ClawGuardReceipts: true after an anchored kill-switch receipt, until a re-arm. */
export async function readStopped(net: NetworkConfig, contract: Hex, signer: Hex): Promise<boolean> {
  const pub = createPublicClient({
    chain: chainOf(net),
    transport: httpTransport(net),
  }) as PublicClient;
  assertTestnetChainId(await pub.getChainId(), net);
  return pub.readContract({
    address: contract,
    abi: RECEIPTS_ABI,
    functionName: 'isStopped',
    args: [signer],
  });
}
