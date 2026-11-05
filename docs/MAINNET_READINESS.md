# Mainnet readiness (the extra $200): plan only, no mainnet action

The MVP track pays $200 more if the MVP **places orders on perps mainnet within 30 days of the perps mainnet launch**. We have not touched mainnet; this lists what it would take.

## What exists today

- The gate, the venue adapter, receipts, the kill switch and the Reactivity watcher run on Tokyo testnet (chain 50383) with a linked bot key (`placeOrderFor` / `cancelOrderFor`).
- `assertTestnetChainId` refuses to start on any chain that is not a known testnet, on purpose.
- `@somnia-chain/markets-sdk` 0.32.1 ships `SOMNIA_MAINNET_ADDRESSES` for chain 5031, but no perps MarginBank or pools yet. Perps mainnet has not launched.

## Needed on launch day (owner actions in bold)

| # | Step | Who | Notes |
| --- | --- | --- | --- |
| 1 | Update the SDK to the release that has the perps mainnet addresses | dev | pin the version; read the changelog for renamed methods |
| 2 | Add a `mainnet` network profile behind an explicit `--network mainnet --i-understand-real-funds` flag | dev | a separate env file and a separate journal dir; the testnet default stays |
| 3 | Rerun `doctor` on mainnet: chain id 5031, markets, decimals, tick and lot, link status | dev | read-only |
| 4 | **Fund the owner wallet with real USDso margin and a little SOMI for the bot key's gas** | **owner** | the smallest amount that covers one order's margin and fees |
| 5 | **Link a fresh bot key to the owner wallet in the dreamDEX app (place and cancel only)** | **owner** | never reuse the testnet key |
| 6 | Deploy ClawGuardReceipts on mainnet, or anchor only, from the bot key | dev, **owner OK** | the contract is small; or skip anchoring for the first order and keep the signed journal |
| 7 | Mainnet policy: one market, $10 per order, $10 per position, $20 per day, 1x, Needs your OK on every order, 100 bps drawdown stop | dev, **owner sets** | tighter than testnet |
| 8 | Place one post-only order far from the mark, cancel it, and record both tx hashes | dev, **owner OK each time** | "places orders" is satisfied by a real placement; no fill needed |
| 9 | Optional: one owner-approved minimal taker fill and a reduce-only close, as on testnet | **owner** | only if they want fill proof |
| 10 | Add `docs/PROOF_MAINNET.md` with the hashes, and update the README and the DoraHacks entry | dev | within the 30 days |

## Risks and guards

- **Real funds:** the bot key can only place and cancel for the owner. It cannot withdraw. The gate caps are the second line.
- **New contracts at launch:** wait for the first day's incidents to settle, then place the order within days 2 to 7.
- **Gas token:** mainnet gas is SOMI. Keep the session gas floor check (`minGas`) with a mainnet value.
- **Secrets:** a new key in a new env file, never committed; gitleaks runs in CI on the full history.

## Effort

About half a day of dev work, plus the owner's funding and linking. Most of it is config and proof, not new code.
