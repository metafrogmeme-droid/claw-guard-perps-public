import { EMPTY_MEMORY, parsePolicy, DEMO_POLICY, type GateInput } from '../src/gate/index.js';
import type { AccountState, MarketSpec, OrderIntent, VenueSizing } from '../src/gate/index.js';

export const NOW = 1_793_000_000; // 2026-10-26T..Z, fixed
export const policy = parsePolicy(DEMO_POLICY);

/** BTC-PERP as read from Somnia Tokyo testnet on 1 Nov 2026 (tick 0.1 USD, lot 1000, min 13000, 8 dp). */
export const BTC: MarketSpec = {
  market: 'BTC-PERP',
  baseDecimals: 8,
  tickSize: 100_000_000_000_000_000n,
  lotSize: 1000n,
  minQuantity: 13000n,
  markPrice: 77_890_000_000_000_000_000_000n,
  markUpdatedAt: NOW - 5,
};

export const account: AccountState = {
  equity: 1000n * 10n ** 18n,
  positions: {},
  grossNotional: 0n,
  openOrders: 0,
};

export const sizing: VenueSizing = {
  priceable: true,
  placeable: true,
  maxQuantity: 10n ** 12n,
  limitedBy: 'collateral',
};

/** 0.00013 BTC limit bid at 77,800 = ~10.11 USD. */
export const intent: OrderIntent = {
  market: 'BTC-PERP',
  side: 'long',
  orderType: 'post_only',
  price: 77_800n * 10n ** 18n,
  quantity: 13000n,
  reduceOnly: false,
  agent: 'test',
};

export function input(over: Partial<GateInput> = {}): GateInput {
  return {
    intent,
    policy,
    market: BTC,
    account,
    memory: { ...EMPTY_MEMORY, day: '2026-10-26' },
    sizing,
    now: NOW,
    ...over,
  };
}
