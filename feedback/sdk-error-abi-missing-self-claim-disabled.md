# SDK error ABI has no SelfClaimDisabled, so a voucher claim fails "for an unknown reason"

Severity: normal
Area: SDK

## Steps to reproduce

1. `markets.trader.claimPerpVoucher({ marginBank: '0x478769E1177C0773c43A593DCCc4Ad15F15F1394' })` on Tokyo testnet.
2. Read the thrown `ContractRevertError`.

## Expected

`errorName: 'SelfClaimDisabled'` and a message that says direct claims are off, the way other distributor errors
(`AlreadyClaimed`, `BudgetExhausted`, …) are named.

## Actual

```
ContractRevertError: @somnia-chain/markets-sdk: claim reverted: for an unknown reason.
  errorName: undefined, data: '0x3e31dcc2', address: '0x2ACD9EFdA721450906bfE1bef3edE269636E42C4', functionName: 'claim'
```

`grep 3e31dcc2` finds nothing in `dist/contractErrorsAbi.js` (537 errors). The selector is `SelfClaimDisabled()`.

## Evidence

- Tx [`0x8c84a9e4ebc04a27c87802707ed038758537ed8ee6e95473142f9e4b15c342cf`](https://explorer.testnet.somnia.network/tokyo/tx/0x8c84a9e4ebc04a27c87802707ed038758537ed8ee6e95473142f9e4b15c342cf)
- `cast sig "SelfClaimDisabled()"` → `0x3e31dcc2`

## Environment

- `@somnia-chain/markets-sdk` 0.32.1, viem 2.57.14, Node 22
- Somnia Tokyo testnet (chain 50383), RPC `https://api.hideki2.infra.testnet.somnia.network`
- Wallet `0x39791a9Df0bb96EBaEEaE2C6754bB76EbD09C67D`
- 1 Nov 2026
