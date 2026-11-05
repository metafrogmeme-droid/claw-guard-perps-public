# getMarginAccount: `equity` drops by the collateral locked for resting orders, and `activePerpPools` lists pools with no position

Severity: normal
Area: SDK

## Steps to reproduce

1. Use an account with 1,000 USDso of perps margin, no positions and no orders.
2. Rest four post-only orders of about 10.5 USD each, on BTC-PERP and ETH-PERP (one bid and one ask per market), well away from the mark so they do not fill.
3. Read the account:

```ts
const ma = await markets.client.getMarginAccount('0x478769E1177C0773c43A593DCCc4Ad15F15F1394', account)
```

## Expected

The `MarginAccount` type docs say:

- `equity`: "Equity = collateral + unrealized PnL − pending funding (signed)."
- `activePerpPools`: "Perp pools where the account holds an open position."

With no position, no unrealized PnL and nothing filled, `equity` should stay at the collateral, 1,000.001008 USDso, and `activePerpPools` should be empty.

## Actual

Values at block 39019836:

| field | value |
| --- | --- |
| `unlockedCollateralBalance` | 997.842925 |
| `lockedCollateral` | 2.158083 |
| `equity` | 997.842925 (equal to unlocked, not to the collateral) |
| `equity + lockedCollateral` | 1000.001008 |
| `imReq` | 0 (no position) |
| `activePerpPools` | `[0x4181dd08…94C0 (BTC), 0xD6Cb1DD5…edDf (ETH)]` |

So `equity` is free collateral, the way `accountEquity.ts` describes the MarginBank figure ("free collateral + unrealized PnL − …", with `totalEquity = equity + lockedCollateral` as "the figure to score an account on"), but the `MarginAccount` doc says otherwise. `activePerpPools` also includes pools where the account has only resting orders.

Why it matters: a bot that follows the field doc and measures drawdown or PnL on `equity` sees every new quote as a loss of about 5% of its notional. In our live session, four resting quotes looked like 2.16 USD of drawdown with zero fills. A tight drawdown stop would trip on quoting alone. We now use `equity + lockedCollateral`.

Suggested fix: change the `equity` doc to "free collateral (after order locks) + unrealized PnL − pending funding". Point to `lockedCollateral` / `getAccountEquity` for the total. Describe `activePerpPools` as "pools with a position or a resting order".

## Evidence

- The four resting orders were placed by our bot key (`placeOrderFor`) at 18:32–18:33 CET (17:32–17:33 UTC) on 1 Nov 2026. Session journal decisions #0, #2, #4 and #6 show the equity reading falling about 0.54 USD per order: 1000.001008, then 999.458043, then 998.908523, then 998.378922.
- The watcher subscribed to `PositionUpdated` for the account over the same period and got no push, so nothing filled.
- Read-only repro script (no key):

```ts
import { SomniaMarkets, SOMNIA_HIDEKI_TESTNET_ADDRESSES } from '@somnia-chain/markets-sdk'
const m = new SomniaMarkets({ chain, indexerUrl, wsRpcUrl, addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES, account })
const ma = await m.client.getMarginAccount('0x478769E1177C0773c43A593DCCc4Ad15F15F1394', account)
console.log(ma.equity, ma.lockedCollateral, ma.unlockedCollateralBalance, ma.activePerpPools)
```

## Environment

- `@somnia-chain/markets-sdk` 0.32.1, viem 2.57.14, Node 22
- Somnia Tokyo testnet (chain 50383), RPC `https://api.hideki2.infra.testnet.somnia.network`
- Account (Perps Arena wallet) `0x3C9650bb62e913c33F662D6De2F4C0C5C617a898`, linked bot key `0x39791a9Df0bb96EBaEEaE2C6754bB76EbD09C67D`
- 1 Nov 2026
