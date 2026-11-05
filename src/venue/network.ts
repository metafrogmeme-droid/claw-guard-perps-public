// Network settings. Somnia Tokyo testnet only (the SDK and the dreamDEX docs call it "Hideki"); there is
// deliberately no mainnet entry, and the live venue refuses to start on any other chain id.
import { defineChain, fallback, http, type Chain, type Transport } from 'viem';

export interface NetworkConfig {
  readonly name: 'tokyo-testnet';
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly wsRpcUrl: string;
  /** All HTTP RPCs, primary first. Plain reads/writes fall back across them; the venue rotates on a timeout. */
  readonly rpcUrls: readonly string[];
  /** All WebSocket RPCs, primary first (the dreamDEX SDK reads over WebSocket). */
  readonly wsRpcUrls: readonly string[];
  readonly indexerUrl: string;
  readonly explorerTx: string;
  readonly explorerAddress: string;
}

export const TOKYO_TESTNET: NetworkConfig = {
  name: 'tokyo-testnet',
  chainId: 50383,
  rpcUrl: 'https://api.hideki2.infra.testnet.somnia.network',
  wsRpcUrl: 'wss://api.hideki2.infra.testnet.somnia.network/ws',
  // second public Tokyo RPC (docs.somnia.network network-info), same chain 50383
  rpcUrls: [
    'https://api.hideki2.infra.testnet.somnia.network',
    'https://api.hideki.infra.testnet.somnia.network/',
  ],
  wsRpcUrls: [
    'wss://api.hideki2.infra.testnet.somnia.network/ws',
    'wss://api.hideki.infra.testnet.somnia.network/ws',
  ],
  indexerUrl: 'https://hideki-dev.smk.somnia.host/v1/graphql',
  explorerTx: 'https://explorer.testnet.somnia.network/tokyo/tx/',
  explorerAddress: 'https://explorer.testnet.somnia.network/tokyo/address/',
};

/** Bounds for plain JSON-RPC over HTTP: per request timeout and retries, and how long to wait for a receipt. */
export const RPC_HTTP = { timeout: 15_000, retryCount: 1 } as const;
export const RECEIPT_WAIT_MS = 60_000;

/** ClawGuardReceipts on Tokyo testnet (deployed by this repo, see docs/PROOF.md). Override with RECEIPTS_ADDRESS. */
export const TOKYO_RECEIPTS = '0xeda7071961c518ce154062cb6d8e94219f8c29b3' as const;

/** Chain ids this tool refuses outright (Somnia mainnet). */
export const REFUSED_CHAIN_IDS: ReadonlySet<number> = new Set([5031]);

export function resolveNetwork(env: Readonly<Record<string, string | undefined>>): NetworkConfig {
  const name = env['NETWORK'] ?? 'tokyo-testnet';
  if (name !== 'tokyo-testnet' && name !== 'hideki' && name !== 'tokyo') {
    throw new Error(`NETWORK=${name} is not supported. This tool runs on Somnia Tokyo testnet only.`);
  }
  const list = (one: string | undefined, many: string | undefined, dflt: readonly string[]): string[] => {
    const extra = (many ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x !== '');
    const all = one === undefined ? [...extra, ...dflt] : [one, ...extra, ...dflt];
    return [...new Set(all)];
  };
  const rpcUrls = list(env['RPC_URL'], env['RPC_URLS'], TOKYO_TESTNET.rpcUrls);
  const wsRpcUrls = list(env['WS_RPC_URL'], env['WS_RPC_URLS'], TOKYO_TESTNET.wsRpcUrls);
  return {
    ...TOKYO_TESTNET,
    rpcUrl: rpcUrls[0] ?? TOKYO_TESTNET.rpcUrl,
    wsRpcUrl: wsRpcUrls[0] ?? TOKYO_TESTNET.wsRpcUrl,
    rpcUrls,
    wsRpcUrls,
    indexerUrl: env['INDEXER_URL'] ?? TOKYO_TESTNET.indexerUrl,
  };
}

export function assertTestnetChainId(actual: number, net: NetworkConfig): void {
  if (REFUSED_CHAIN_IDS.has(actual))
    throw new Error(`RPC is on chain ${String(actual)} (mainnet). Refusing to run.`);
  if (actual !== net.chainId) {
    throw new Error(
      `RPC is on chain ${String(actual)}, expected Tokyo testnet ${String(net.chainId)}. Refusing to run.`,
    );
  }
}

/** HTTP transport over every configured RPC: on a timeout or error viem moves on to the next one. */
export function httpTransport(net: NetworkConfig): Transport {
  const urls = net.rpcUrls.length > 0 ? net.rpcUrls : [net.rpcUrl];
  return fallback(urls.map((u) => http(u, RPC_HTTP)));
}

export function chainOf(net: NetworkConfig): Chain {
  return defineChain({
    id: net.chainId,
    name: 'Somnia Tokyo testnet',
    nativeCurrency: { name: 'Somnia Test Token', symbol: 'STT', decimals: 18 },
    rpcUrls: { default: { http: [net.rpcUrl], webSocket: [net.wsRpcUrl] } },
    testnet: true,
  });
}

export function txUrl(net: NetworkConfig, hash: string): string {
  return `${net.explorerTx}${hash}`;
}
