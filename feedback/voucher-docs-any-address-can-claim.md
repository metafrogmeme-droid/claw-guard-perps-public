# Paper USDso: docs say any address can claim, but claim() reverts SelfClaimDisabled for every caller

Severity: major
Area: docs

## Steps to reproduce

1. Follow "Perps on Testnet for Developers" → "Get test funds" → "Paper USDso" with a fresh key that holds STT and
   no perp positions or orders.
2. `await markets.client.getPerpVoucherEligibility(btc.marginBank, account)` returns `{ eligible: true, grantAmount: 1000000000000000000000n }`.
3. `await markets.trader.claimPerpVoucher({ marginBank: btc.marginBank })`.

Shorter repro, any sender, no key needed:

```sh
cast call 0x2ACD9EFdA721450906bfE1bef3edE269636E42C4 "claim()" \
  --from 0x000000000000000000000000000000000000dEaD \
  --rpc-url https://api.hideki2.infra.testnet.somnia.network
# execution reverted, data: "0x3e31dcc2"   (= SelfClaimDisabled())
```

## Expected

The docs: "Any address can claim the 1,000 USDso perps credit once, as long as it holds no perp positions or
orders", with the snippet above. A bot key built from the developer docs gets margin this way.

## Actual

The VoucherDistributor (proxy `0x2ACD9EFdA721450906bfE1bef3edE269636E42C4`, implementation
`0x9657f0fd53efc01cd108d93c835bb4b517732b43`) reverts `SelfClaimDisabled()` (`0x3e31dcc2`) about 870 gas into
`claim()`, for every caller. The only way to paper USDso seems to be joining Perps Arena in the app, which the
developer page does not say. Budget is not the cause: `getPerpVoucherCampaign` reports 105,906 claims remaining and
the campaign window is open.

## Evidence

- Mined, reverted claim: [`0x8c84a9e4ebc04a27c87802707ed038758537ed8ee6e95473142f9e4b15c342cf`](https://explorer.testnet.somnia.network/tokyo/tx/0x8c84a9e4ebc04a27c87802707ed038758537ed8ee6e95473142f9e4b15c342cf)
- `debug_traceCall` of `claim()`: proxy DELEGATECALL to `0x9657f0fd…2b43`, output `0x3e31dcc2`, gasUsed `0x367` in the implementation.
- `cast sig "SelfClaimDisabled()"` = `0x3e31dcc2`.
- Re-checked 1 Nov 2026 18:49 CET (17:49 UTC): `eth_call` of `claim()` from `0x…dEaD` still returns `0x3e31dcc2`.

Suggested fix: update the developer page (claim through Perps Arena, or how a bot key gets margin: Link a Bot to an
Arena wallet), and remove the direct-claim snippet while self-claim is off.

## Environment

- `@somnia-chain/markets-sdk` 0.32.1, viem 2.57.14, Node 22
- Somnia Tokyo testnet (chain 50383), RPC `https://api.hideki2.infra.testnet.somnia.network`
- Wallet `0x39791a9Df0bb96EBaEEaE2C6754bB76EbD09C67D`
- 1 Nov 2026
