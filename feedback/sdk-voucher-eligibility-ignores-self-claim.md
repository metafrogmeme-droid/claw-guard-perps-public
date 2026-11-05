# getPerpVoucherEligibility returns eligible: true while every claim reverts

Severity: major
Area: SDK

## Steps to reproduce

```ts
const el = await markets.client.getPerpVoucherEligibility(
  '0x478769E1177C0773c43A593DCCc4Ad15F15F1394', // MarginBank
  '0x39791a9Df0bb96EBaEEaE2C6754bB76EbD09C67D',
)
// { eligible: true, grantAmount: 1000000000000000000000n }
await markets.trader.claimPerpVoucher({ marginBank: '0x478769E1177C0773c43A593DCCc4Ad15F15F1394' })
// ContractRevertError: claim reverted: for an unknown reason. data: '0x3e31dcc2'
```

## Expected

The type docs say eligibility checks "in the order VoucherDistributor.claim() checks them, so the reason names the
revert a claim would produce at the same block", and `eligible: true` means "a claim sent now would succeed".
With self-claim off, it should return `{ eligible: false, reason: 'selfClaimDisabled' }` (new reason), or simulate
`claim()` from the account.

## Actual

`eligible: true`, then the claim is mined and reverts with `SelfClaimDisabled()`. A bot that follows the
documented "check, then claim" pattern burns gas on every start.

## Evidence

- Reverted claim tx: [`0x8c84a9e4ebc04a27c87802707ed038758537ed8ee6e95473142f9e4b15c342cf`](https://explorer.testnet.somnia.network/tokyo/tx/0x8c84a9e4ebc04a27c87802707ed038758537ed8ee6e95473142f9e4b15c342cf)
- The distributor config read `0x6c87f4b2()` returns `(604800, true, false, true)`; one of those flags is
  presumably the self-claim switch the eligibility read does not look at.

## Environment

- `@somnia-chain/markets-sdk` 0.32.1, viem 2.57.14, Node 22
- Somnia Tokyo testnet (chain 50383), RPC `https://api.hideki2.infra.testnet.somnia.network`
- Wallet `0x39791a9Df0bb96EBaEEaE2C6754bB76EbD09C67D`
- 1 Nov 2026
