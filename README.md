# Claw Guard Perps

A pre-trade firewall between a perps trading agent (AI or rule-based) and its dreamDEX bot key on Somnia Tokyo
testnet (chain 50383). The agent proposes orders; Claw Guard checks every order against the owner's rules before
the key signs anything, writes a signed, hash-chained receipt for each decision, and anchors the receipts on
Somnia so anyone can check what the agent was allowed to do.

Every order gets exactly one of three answers:

- `Allowed: within your limits`
- `Blocked by your rule: <codes>`
- `Needs your OK: <codes>`

## Who it is for

- People who let a bot or an AI agent trade dreamDEX perps with a linked bot key and want hard limits it cannot talk
  its way around.
- Bot builders who want a ready-made risk layer: caps, grid checks and a kill switch, with receipts they can show.

## What it checks

| Group | Rules |
| --- | --- |
| Scope | market allowlist, pinned base decimals per market, decimals changed since pinning |
| Grid | price on tick, quantity on lot, quantity at least the venue minimum, zero price/quantity |
| Price | mark known, mark not stale, venue can price the market, limit price within N bps of mark |
| Size | per-order notional, daily notional, position notional, leverage, equity present, venue max size |
| Flow | open-orders cap, orders per minute, failure loop (N venue rejects in a row), reduce-only really reduces |
| Owner OK | above a notional threshold, first order in a market, taker orders |
| Kill switch | drawdown from peak equity trips it: cancel resting orders, reduce positions, block until re-armed |

Rule codes are in `src/gate/codes.ts`; the demo policy is in `src/gate/policy.ts`.

## Receipts

Each decision, execution, kill and re-arm is a receipt: EIP-191 signed by the gate key, chained by `prevHash`,
stored as JSONL. `ClawGuardReceipts.sol` accepts a journal only in order (no gaps, forks, replays or reorders),
checks every signature, emits `Anchored`, and exposes `isStopped(signer)` while a kill switch is active, so a keeper
or another contract can read the stop on-chain.

## Run it

Requirements: Node 22.13+, pnpm 10, Foundry (for the contract).

```sh
pnpm install
pnpm test                          # unit, fuzz and cross-language tests, no network
pnpm cli demo --sim                # simulated venue: scripted agent + band maker, receipts + HTML trace
cp .env.example ~/.config/claw-guard-perps/env && chmod 600 ~/.config/claw-guard-perps/env  # fill PRIVATE_KEY
pnpm cli doctor                    # network, gas, margin, marks, link status, funding plan
pnpm cli fund                      # gas / margin / voucher check; simulates the voucher claim first
pnpm cli demo --live               # same demo against dreamDEX on Tokyo testnet
pnpm cli fill --live --yes         # one minimal taker order (Needs your OK, approved by --yes), then a reduce-only close
pnpm cli verify runs/<run>.jsonl   # check the hash chain and signatures
pnpm cli trace runs/<run>.jsonl    # HTML trace with explorer links
(cd contracts && forge build) && pnpm cli deploy-receipts
pnpm cli anchor runs/<run>.jsonl --address 0x<ClawGuardReceipts>
pnpm cli kill --reason manual      # trip the kill switch now
pnpm cli watch --react             # Somnia Reactivity: react to on-chain stops and position changes at once
pnpm cli stop --reason r           # remote stop: anchor a kill-switch receipt; every watcher flattens
pnpm cli rearm runs/<stop>.jsonl   # anchor the matching re-arm
pnpm cli rest --live               # one resting post-only bid (Allowed), something for a stop to cancel
```

Linked-wallet mode: in the dreamDEX app, Link a Bot with the key's address, then set `OWNER_ADDRESS` to the app
wallet. The key pays gas and places orders for the owner; it cannot withdraw.

Testnet only: the network module refuses mainnet chain ids.

## Somnia Reactivity

`watch --react` holds two `somnia_watch` subscriptions on Tokyo testnet. The first is ClawGuardReceipts
`Anchored`/`Stopped`/`Rearmed` for the receipt signer, with `isStopped(signer)` evaluated in the same block. The
second is dreamDEX MarginBank `PositionUpdated` for the traded account. An on-chain stop, or a position the rules do
not allow, trips the kill switch without waiting for a poll. Design, live run and tx hashes:
[docs/REACTIVITY.md](docs/REACTIVITY.md).

## Evidence

See [docs/PROOF.md](docs/PROOF.md) for contract address and transaction hashes.

## Docs

- [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)
- [docs/DECISIONS.md](docs/DECISIONS.md)
- [docs/REACTIVITY.md](docs/REACTIVITY.md)
- [feedback/](feedback/): reproducible reports on the perps SDK, contracts and docs

## X posts

Live on [@RUNECLAW_AI](https://x.com/RUNECLAW_AI) (5 Nov 2026):

1. [Blank check](https://x.com/RUNECLAW_AI/status/2118411003675176991) — rule gate between a bot and dreamDEX perps
2. [Proof](https://x.com/RUNECLAW_AI/status/2118411011556336020) — signed, hash-chained receipts anchored on Somnia
3. [Kill switch](https://x.com/RUNECLAW_AI/status/2118411025544286651) — Somnia Reactivity stop cancels resting orders

Demo (2 min): https://youtu.be/LDJDGLHcAAM


## Licence

MIT, Copyright (c) 2026 Patrick Baur (RUNECLAW).
