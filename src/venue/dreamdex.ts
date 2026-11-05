// dreamDEX perps venue on Somnia Tokyo testnet.
//
// Two modes:
//  - own-account: the key is the account. Writes go through the SDK trader (placePerpOrder / cancelOrder).
//  - linked-bot-key: the account linked this key in the dreamDEX app (wallet -> Link a bot -> Perps), which
//    grants placeOrderFor / cancelOrderFor / reduceOrderFor on each pool. The SDK has no perp ...For
//    writes, so those go through viem (simulate first, then send), and the SDK is pointed at the owner for
//    reads. The key pays gas and cannot withdraw.
//
// Network I/O only; every decision is made by the gate before place() is called.
import {
  SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  SomniaMarkets,
  contractErrorsAbi,
  decodePlaceOrder,
} from '@somnia-chain/markets-sdk';
import {
  createPublicClient,
  createWalletClient,
  parseAbi,
  zeroAddress,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

import type { OrderIntent, VenueSizing } from '../gate/types.js';
import type { RestingOrder } from '../killswitch/killswitch.js';
import { BENIGN_ERRORS, errorName, errorText } from './errors.js';
import type { FundingFacts, VoucherFact } from './funding.js';
import { displayName, isBidSide, orderTypeCode, farFutureNs, toVenueMarket, type MarketRow } from './map.js';
import {
  RECEIPT_WAIT_MS,
  assertTestnetChainId,
  chainOf,
  httpTransport,
  type NetworkConfig,
} from './network.js';
import { readWithRetry, type ReadRetry } from './retry.js';
import type {
  BookTop,
  CancelResult,
  PlaceResult,
  Venue,
  VenueMarket,
  VenueMode,
  VenueSnapshot,
} from './types.js';

export const LINKED_SELECTORS = {
  placeOrderFor: '0x80054449',
  cancelOrderFor: '0xe37b444b',
  reduceOrderFor: '0x364c2587',
} as const;

const OPERATOR_ABI = [
  ...parseAbi([
    'function placeOrderFor(address owner, bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) payable returns (bool success, uint128 orderId)',
    'function cancelOrderFor(address owner, uint128 orderId)',
    'function isOperatorAuthorized(address owner, address operator, bytes4 selector) view returns (bool)',
  ]),
  ...contractErrorsAbi,
] as const;

/** Gas limit the SDK uses for a perp order. Somnia bills gas used, not the limit. */
const ORDER_GAS = 10_000_000n;

export interface DreamdexOptions {
  readonly privateKey: `0x${string}`;
  /** Set to trade FOR a linked account; leave unset to trade the key's own account. */
  readonly owner?: `0x${string}`;
  readonly network: NetworkConfig;
  readonly now: () => number;
  /** Per-attempt timeout, attempts and backoff for SDK account reads (getPosition, getAccountState, orders). */
  readonly readRetry?: ReadRetry;
}

type Sdk = InstanceType<typeof SomniaMarkets>;

export class DreamdexVenue implements Venue {
  readonly mode: VenueMode;
  readonly account: `0x${string}`;
  readonly sender: `0x${string}`;
  private rows = new Map<string, MarketRow>();
  private rowsAt = 0;
  /** Market rows (grid, decimals) change rarely; marks come from the pool snapshot, not the row. */
  private static readonly ROWS_TTL_SEC = 60;

  private wsIndex = 0;

  private constructor(
    private sdk: Sdk,
    private readonly key: PrivateKeyAccount,
    private readonly pub: PublicClient,
    private readonly wallet: WalletClient,
    private readonly opts: DreamdexOptions,
  ) {
    const linked = opts.owner !== undefined && opts.owner.toLowerCase() !== key.address.toLowerCase();
    this.mode = linked ? 'linked-bot-key' : 'own-account';
    this.account = linked ? opts.owner : key.address;
    this.sender = key.address;
  }

  static async create(opts: DreamdexOptions): Promise<DreamdexVenue> {
    const chain = chainOf(opts.network);
    const transport = httpTransport(opts.network);
    const pub = createPublicClient({ chain, transport }) as PublicClient;
    assertTestnetChainId(await pub.getChainId(), opts.network);
    const key = privateKeyToAccount(opts.privateKey);
    const wallet = createWalletClient({ account: key, chain, transport });
    const sdk = DreamdexVenue.makeSdk(opts, opts.network.wsRpcUrl);
    return new DreamdexVenue(sdk, key, pub, wallet, opts);
  }

  private static makeSdk(opts: DreamdexOptions, wsRpcUrl: string): Sdk {
    const linked =
      opts.owner !== undefined &&
      opts.owner.toLowerCase() !== privateKeyToAccount(opts.privateKey).address.toLowerCase();
    const base = {
      chain: chainOf(opts.network),
      indexerUrl: opts.network.indexerUrl,
      wsRpcUrl,
      addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES,
    };
    return new SomniaMarkets(
      linked ? { ...base, account: opts.owner } : { ...base, privateKey: opts.privateKey },
    );
  }

  /** After a timed-out read: move the SDK to the next WebSocket RPC (no-op with a single URL). */
  private rotate(): void {
    const urls = this.opts.network.wsRpcUrls;
    if (urls.length < 2) return;
    const old = this.sdk;
    this.wsIndex = (this.wsIndex + 1) % urls.length;
    this.sdk = DreamdexVenue.makeSdk(this.opts, urls[this.wsIndex] ?? this.opts.network.wsRpcUrl);
    const c = (old as { close?: () => unknown }).close;
    void Promise.resolve(c?.call(old)).catch(() => undefined);
  }

  private read<T>(label: string, f: () => Promise<T>): Promise<T> {
    return readWithRetry(f, label, this.opts.readRetry, () => {
      this.rotate();
    });
  }

  private async loadRows(force = false): Promise<void> {
    const now = this.opts.now();
    if (!force && this.rows.size > 0 && now - this.rowsAt < DreamdexVenue.ROWS_TTL_SEC) return;
    const markets = await this.sdk.loadMarkets(true);
    const rows = new Map<string, MarketRow>();
    for (const m of Object.values(markets)) {
      if (m.type !== 'swap' || !m.active) continue;
      rows.set(displayName(m.symbol), m.info as unknown as MarketRow);
    }
    this.rows = rows;
    this.rowsAt = now;
  }

  async listMarkets(): Promise<VenueMarket[]> {
    await this.loadRows(true);
    const now = this.opts.now();
    return [...this.rows.entries()].map(([n, r]) => toVenueMarket(n, r, undefined, now));
  }

  async snapshot(names: readonly string[]): Promise<VenueSnapshot> {
    await this.loadRows();
    const now = this.opts.now();
    const markets: Record<string, VenueMarket> = {};
    for (const n of names) {
      const row = this.rows.get(n);
      if (row === undefined) continue;
      let live: { priceable: boolean; markPrice?: bigint } | undefined;
      try {
        const h = await this.sdk.client.getPerpHealthSnapshot(row.poolAddress as `0x${string}`);
        live = h.priceable ? { priceable: true, markPrice: h.markPrice } : { priceable: false };
      } catch {
        live = undefined;
      }
      markets[n] = toVenueMarket(n, row, live, now);
    }
    const list = Object.values(markets);
    const bank =
      list[0]?.marginBank ?? (SOMNIA_HIDEKI_TESTNET_ADDRESSES as { marginBank?: `0x${string}` }).marginBank;
    let equity = 0n;
    if (bank !== undefined) {
      // MarginBank `equity` leaves out collateral locked by resting orders (initial margin), so a fresh quote
      // would look like a loss to the drawdown rule. Total equity = equity + lockedCollateral.
      const ma = await this.read('getAccountState', () =>
        this.sdk.client.getMarginAccount(bank, this.account),
      );
      equity = ma.equity + ma.lockedCollateral;
    }
    const positions: Record<string, bigint> = {};
    let gross = 0n;
    for (const m of list) {
      const p = await this.read('getPosition', () =>
        this.sdk.client.getPerpPosition({ marginBank: m.marginBank, account: this.account, pool: m.pool }),
      );
      if (p.size !== 0n) {
        positions[m.market] = p.size;
        const abs = p.size < 0n ? -p.size : p.size;
        gross += (m.markPrice * abs) / 10n ** BigInt(m.baseDecimals);
      }
    }
    const orders: RestingOrder[] = [];
    if (list.length > 0) {
      const open = await this.read('getOpenOrders', () =>
        this.sdk.client.getOpenOrdersOnchain(
          list.map((m) => m.pool),
          this.account,
        ),
      );
      const byPool = new Map(list.map((m) => [m.pool.toLowerCase(), m.market]));
      for (const o of open.orders) {
        const name = byPool.get(o.pool.toLowerCase());
        if (name !== undefined) orders.push({ market: name, orderId: o.orderId });
      }
    }
    return {
      account: { equity, positions, grossNotional: gross, openOrders: orders.length },
      markets,
      orders,
      at: now,
    };
  }

  async sizing(market: VenueMarket, intent: OrderIntent): Promise<VenueSizing> {
    const s = await this.sdk.client.getMaxPerpOrderSize({
      pool: market.pool,
      marginBank: market.marginBank,
      account: this.account,
      isBid: isBidSide(intent.side),
      price: intent.price,
    });
    return {
      priceable: s.priceable,
      placeable: s.priceable && s.placeable,
      maxQuantity: s.priceable ? s.maxQuantity : 0n,
      ...(s.priceable ? { limitedBy: s.limitedBy } : {}),
    };
  }

  /** What the pool says this key may do for the owner (linked mode). */
  async linkStatus(market: VenueMarket): Promise<{ place: boolean; cancel: boolean }> {
    const ask = (selector: `0x${string}`) =>
      this.pub.readContract({
        address: market.pool,
        abi: OPERATOR_ABI,
        functionName: 'isOperatorAuthorized',
        args: [this.account, this.sender, selector],
      });
    const [place, cancel] = await Promise.all([
      ask(LINKED_SELECTORS.placeOrderFor),
      ask(LINKED_SELECTORS.cancelOrderFor),
    ]);
    return { place, cancel };
  }

  async place(market: VenueMarket, intent: OrderIntent): Promise<PlaceResult> {
    const orderType = orderTypeCode(intent.orderType);
    const isBid = isBidSide(intent.side);
    try {
      if (this.mode === 'own-account') {
        const r = await this.sdk.trader.placePerpOrder({
          pool: market.pool,
          isBid,
          price: intent.price,
          quantity: intent.quantity,
          orderType,
        });
        const filled = r.fills.reduce((s, f) => s + f.quantityFilled, 0n);
        return {
          ok: true,
          txHash: r.hash,
          filled,
          ...(r.orderId === undefined ? {} : { orderId: r.orderId }),
        };
      }
      const { request } = await this.pub.simulateContract({
        address: market.pool,
        abi: OPERATOR_ABI,
        functionName: 'placeOrderFor',
        args: [
          this.account,
          isBid,
          0n,
          intent.price,
          intent.quantity,
          farFutureNs(this.opts.now()),
          orderType,
          0,
          zeroAddress,
          0n,
        ],
        account: this.key,
        gas: ORDER_GAS,
      });
      const hash = await this.wallet.writeContract(request);
      const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: RECEIPT_WAIT_MS });
      if (receipt.status !== 'success')
        return { ok: false, txHash: hash, filled: 0n, error: 'reverted on-chain' };
      const d = decodePlaceOrder(receipt, market.pool);
      const filled = d.fills.reduce((s, f) => s + f.quantityFilled, 0n);
      return { ok: true, txHash: hash, filled, ...(d.orderId === undefined ? {} : { orderId: d.orderId }) };
    } catch (err) {
      const name = errorName(err);
      const hash = (err as { hash?: `0x${string}` }).hash;
      return {
        ok: false,
        filled: 0n,
        error: errorText(err).slice(0, 300),
        ...(name === undefined ? {} : { errorName: name }),
        ...(hash === undefined ? {} : { txHash: hash }),
        ...(name !== undefined && BENIGN_ERRORS.has(name) ? { benign: true } : {}),
      };
    }
  }

  /** Best bid and ask read from the pool itself at chain head (not the indexer). */
  async bookTop(market: VenueMarket): Promise<BookTop | undefined> {
    const r = await this.sdk.client.getBookTopsOnchain([{ id: market.pool, poolAddress: market.pool }]);
    const t = r.tops[market.pool.toLowerCase()];
    if (t === undefined) return undefined;
    return {
      ...(t.bestBid === null ? {} : { bestBid: BigInt(t.bestBid) }),
      ...(t.bestAsk === null ? {} : { bestAsk: BigInt(t.bestAsk) }),
    };
  }

  async cancel(market: VenueMarket, order: RestingOrder): Promise<CancelResult> {
    try {
      if (this.mode === 'own-account') {
        const r = await this.sdk.trader.cancelOrder({ pool: market.pool, orderId: order.orderId });
        return { ok: true, txHash: r.hash };
      }
      const { request } = await this.pub.simulateContract({
        address: market.pool,
        abi: OPERATOR_ABI,
        functionName: 'cancelOrderFor',
        args: [this.account, order.orderId],
        account: this.key,
        gas: ORDER_GAS,
      });
      const hash = await this.wallet.writeContract(request);
      const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: RECEIPT_WAIT_MS });
      return receipt.status === 'success'
        ? { ok: true, txHash: hash }
        : { ok: false, txHash: hash, error: 'reverted' };
    } catch (err) {
      return { ok: false, error: errorText(err).slice(0, 300) };
    }
  }

  private bank(): `0x${string}` {
    const first = [...this.rows.values()][0];
    const b = first?.marginBank ?? (SOMNIA_HIDEKI_TESTNET_ADDRESSES as { marginBank?: string }).marginBank;
    if (b === undefined) throw new Error('no margin bank known');
    return b as `0x${string}`;
  }

  /** Gas, margin and voucher facts for the funding check. Reads only. */
  async fundingFacts(): Promise<FundingFacts> {
    await this.loadRows();
    const bank = this.bank();
    const [gas, ma] = await Promise.all([
      this.gasBalance(),
      this.sdk.client.getMarginAccount(bank, this.account),
    ]);
    let voucher: VoucherFact = { kind: 'off' };
    const camp = await this.sdk.client.getPerpVoucherCampaign(bank);
    if (camp !== null) {
      const el = await this.sdk.client.getPerpVoucherEligibility(bank, this.account);
      if (!el.eligible) {
        voucher =
          el.reason === 'alreadyClaimed' ? { kind: 'claimed' } : { kind: 'ineligible', reason: el.reason };
      } else {
        let preflight = 'ok';
        try {
          // claim() takes no arguments; simulate it from the sending key so a revert costs no gas.
          await this.pub.call({ account: this.key.address, to: camp.distributor, data: '0x4e71d92d' });
        } catch (err) {
          preflight = errorName(err) ?? errorText(err).slice(0, 120);
        }
        voucher = { kind: 'eligible', grant: el.grantAmount, preflight };
      }
    }
    return {
      mode: this.mode,
      account: this.account,
      sender: this.sender,
      gas,
      equity: ma.equity + ma.lockedCollateral,
      voucher,
    };
  }

  /** Claim the one-time paper USDso voucher for the key's own account. Call only after a passing preflight. */
  async claimVoucher(): Promise<`0x${string}`> {
    if (this.mode !== 'own-account')
      throw new Error('a voucher is claimed by the account itself, not a linked key');
    await this.loadRows();
    const r = await this.sdk.trader.claimPerpVoucher({ marginBank: this.bank() });
    return r.hash;
  }

  /** Native gas balance of the sending key. */
  gasBalance(): Promise<bigint> {
    return this.pub.getBalance({ address: this.sender });
  }

  async close(): Promise<void> {
    const c = (this.sdk as { close?: () => unknown }).close;
    await Promise.race([Promise.resolve(c?.call(this.sdk)), new Promise((r) => setTimeout(r, 3000))]);
  }
}
