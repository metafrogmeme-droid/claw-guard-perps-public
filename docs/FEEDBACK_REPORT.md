# Feedback report (draft, not sent)

Found while building Claw Guard Perps on Somnia Tokyo testnet, 31 Oct to 1 Nov 2026. Each item is one file in [`feedback/`](../feedback/), in the bounty template, with a repro and evidence. We filed only what we hit and could reproduce. Nothing here is a security vulnerability; if we find one, it goes privately to security@dreamdex.io and never into this repo.

| # | Item | Severity | Area | Repro in one line |
| --- | --- | --- | --- | --- |
| 1 | [Docs say any address can claim paper USDso; `claim()` reverts `SelfClaimDisabled` for every caller](../feedback/voucher-docs-any-address-can-claim.md) | major | docs | `eth_call claim()` from any address returns `0x3e31dcc2` (re-checked 1 Nov 18:49 CET) |
| 2 | [`getPerpVoucherEligibility` returns `eligible: true` while every claim reverts](../feedback/sdk-voucher-eligibility-ignores-self-claim.md) | major | SDK | eligibility then claim; reverted tx `0x8c84a9e4…42cf` |
| 3 | [SDK error ABI has no `SelfClaimDisabled`, so the claim fails "for an unknown reason"](../feedback/sdk-error-abi-missing-self-claim-disabled.md) | normal | SDK | `grep 3e31dcc2 dist/contractErrorsAbi.js` finds nothing |
| 4 | [`SignerRequiredError` says to pass an account, but an address still fails](../feedback/sdk-signer-required-account-hint.md) | normal | SDK | `new SomniaMarkets({ account: '0x…' }).trader.claimPerpVoucher(…)` |
| 5 | [`getMarginAccount().equity` drops by the collateral locked for resting orders; `activePerpPools` lists pools with no position](../feedback/sdk-margin-account-equity-excludes-locked-collateral.md) | normal | SDK | 4 resting quotes, no fills: `equity` 997.84, `equity + lockedCollateral` 1000.00 |
| 6 | [Bounty lists Somnia Agents as a plus, but the Agents platform is not on Tokyo](../feedback/docs-somnia-agents-not-on-tokyo.md) | normal | docs | `eth_getCode 0x037Bb9…6776` on 50383 returns `0x` |

Items 1 to 3 have the same root cause (direct claims are off) but different fixes: the docs page, the eligibility read and the error ABI. Each one alone would have saved a builder the gas and the time.

## Seen, not filed

- **Reactivity payload nesting.** Upstream Reactivity docs put the push payload at `notification.params.result`. Through viem it arrives at `notification.result`. The markets SDK already documents this in `@somnia-chain/markets-sdk/reactivity`, so it is known. Our raw WebSocket transport reads `params.result` from the JSON-RPC envelope, which matches the node.
- **On-chain Reactivity needs 32 STT in the subscribing contract.** This is documented, so we don't file it as a bug. We went off-chain instead (DECISIONS #10).
- **Our own bugs.** We measured drawdown on free equity (fixed in #14, thanks to item 5), and `fill --out X` writes `X.jsonl`. These are ours, not the venue's.

## How to send (when Patrick says go)

Submit the `feedback/` folder with the Build on DoraHacks. The files are already in the template, so nothing needs to be sent separately.
