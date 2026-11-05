# Somnia Reactivity in Claw Guard Perps

Claw Guard reacts to on-chain events the moment their block lands. It does not poll for them. It uses Somnia's
off-chain Reactivity: `eth_subscribe("somnia_watch", …)` on the Tokyo testnet WebSocket
(`wss://api.hideki2.infra.testnet.somnia.network/ws`). Each push carries the matched log **and** the results of
view calls that the node ran against the same block state.

## Two subscriptions, one guard (`pnpm cli watch --react`)

| Subscription | Filter | Same-block `eth_calls` | Reaction |
| --- | --- | --- | --- |
| Kill-switch stop (`src/reactivity/watch.ts`) | ClawGuardReceipts `0xeda7…29b3`, topic0 ∈ {`Anchored`, `Stopped`, `Rearmed`}, topic1 = receipt signer | `isStopped(signer)` (context `topic2`, so the node appends the log's signer) | the stop flag turns on → trip the local kill switch: cancel every resting order, reduce every position; the flag turns off → log the re-arm |
| Positions (`src/reactivity/positions.ts`) | dreamDEX MarginBank `0x4787…1394`, topic0 = `PositionUpdated`, topic1 = traded account | none (the log carries `newSize`, `avgEntryPrice`, `realizedPnl`) | re-check the new position against the policy: `UNKNOWN_MARKET`, `WHILE_STOPPED`, `POSITION_CAP` → `Blocked by your rule: …` and trip the kill switch |

The position watch catches what a pre-trade gate alone cannot see:

- a resting maker order that fills while nobody polls
- a trade sent by another key on the same account
- a position that appears while the stop is on

Missed pushes are handled. A push stream lives on one socket, so on every reconnect the watcher re-reads
`isStopped` over plain RPC before it trusts the stream again, and the transport reconnects with backoff (1 s up to
30 s). A test covers a re-arm that happened while the socket was down.

## The remote stop button (`stop`, `rearm`)

`pnpm cli stop --reason …` anchors one signed kill-switch receipt in ClawGuardReceipts. It needs only the receipt
key, not the venue. Every watcher on that signer sees `Stopped` in the same block and flattens its account.
`pnpm cli rearm <stop-journal>` anchors the matching re-arm. `demo --live`, `fill --live`, `rest --live` and
`session --live` refuse to start while `isStopped(signer)` is true.

## Live run on Tokyo testnet (1 Nov 2026, times in CET)

| Step | What happened | Tx |
| --- | --- | --- |
| 18:25:06 | `watch --react` subscribed to both streams; `isStopped` = false | — |
| 18:25 | `rest --live`: one post-only BTC bid 150 bps under the mark, `Allowed: within your limits` | [`0x17894189…6c82`](https://explorer.testnet.somnia.network/tokyo/tx/0x178941894bd4156c9f273ce622eab06f1bf656f83d3d33e41881bfbc4dbd6c82) |
| 18:26:04 (block 39006738) | `stop` anchored a kill-switch receipt | [`0x1b3c32cd…3ef4`](https://explorer.testnet.somnia.network/tokyo/tx/0x1b3c32cdae6daa6dbe4f0563616c575dba61fdee59109ab6e17b591599af3ef4) |
| 18:26:04.306 | push: `Anchored` verdict 5 with `isStopped after = true`, then `Stopped`. This arrived inside the block's own second, 0.8 s before the `stop` command had its receipt back | — |
| 18:26:20 (block 39006904) | the watcher's kill switch cancelled the resting bid: open orders 1 → 0 | [`0xb0baccda…f0c7`](https://explorer.testnet.somnia.network/tokyo/tx/0xb0baccda4c4f4843c5543a3d6d88899fe6c37a08a8999cdaf02a72e78372f0c7) |
| 18:26:57 | `rearm` anchored; push `Rearmed` with `isStopped after = false` | [`0xe9ff1301…6c57`](https://explorer.testnet.somnia.network/tokyo/tx/0xe9ff1301844b32c26d39600129772cc72e14c195f4e176fd8c83113d0a166c57) |
| 18:27:33 | `fill --live --yes` (Needs your OK, owner said yes) bought 0.00014 BTC; push `PositionUpdated size 14000` → `Allowed: within your limits (BTC-PERP 10.92 USD)` | [`0x33b3ad9b…b335`](https://explorer.testnet.somnia.network/tokyo/tx/0x33b3ad9be351080b8da59c196201104144872da0400bb37a66c2e42bdb0fb335) |
| 18:27:46 | reduce-only close; push `PositionUpdated size 0` → `Allowed: within your limits (flat)` | [`0x84b1e30d…ae20`](https://explorer.testnet.somnia.network/tokyo/tx/0x84b1e30d46bf0b965ddd987cd4cdc292931205ac99398e1eefac605d9657ae20) |

Journals were anchored afterwards:

- rest: [`0x42ead333…5e21e`](https://explorer.testnet.somnia.network/tokyo/tx/0x42ead333b9ec4610d5ec8e5d4bd4db25517b78be52b91877a65ee5f87569c21e)
- watcher (kill + cancel receipts): [`0x72235daa…5dea`](https://explorer.testnet.somnia.network/tokyo/tx/0x72235daade8d404090df0c09100af52f4f79a9699445bb778be1f98bb57e5dea)
- fill: [`0x325c5c8b…ce3a`](https://explorer.testnet.somnia.network/tokyo/tx/0x325c5c8bf32b3ef5988ab762787b0a42f15a437c687c141ebf0fb3df2de1ce3a)

The watcher saw its own journal's `Stopped` while it was already stopped and did nothing, as designed. In total the
run had 15 pushes and 1 reaction, and the account ended flat. The raw log and all four journals are in
[docs/proof/reactivity-2026-11-01/](proof/reactivity-2026-11-01/) (`pnpm cli verify` passes on each).

Notes on the numbers:

- The push takes under a second from the block. The cancel then took 16 s, because the kill switch re-reads the
  full account before cancelling.
- A faster path that cancels the orders the engine already tracks, before the re-read, is the next step. It is noted
  in [DECISIONS.md](DECISIONS.md) #11.

## Why off-chain Reactivity and not a Solidity handler

On-chain Reactivity works like this: a `SomniaEventHandler` contract subscribes through the precompile at `0x0100`,
and the validators call `_onEvent`. That model needs the subscribing contract to hold at least 32 STT. The bot key
holds about 5.7 STT on Tokyo. The reaction we need also has to send venue transactions with the bot key (cancel,
reduce), and a handler contract cannot hold that key.

So the handler would only move the stop from one contract to another, and `isStopped` already gives other contracts
that read. `somnia_watch` keeps the same-block guarantee, because the event and `isStopped` come from one state. It
costs nothing per event and reaches the process that holds the key. If the owner funds 32 STT, a handler that mirrors
`Stopped` into a venue-side circuit breaker is the natural on-chain extension.

## Bonus fit (dreamDEX Perps Bounty, MVP track: "Reactivity or Somnia Agents is a plus")

- Uses Somnia Reactivity on Tokyo testnet, on both our own contract (kill switch) and the dreamDEX MarginBank
  (positions).
- Uses the primitive's distinctive feature: same-block `eth_calls` (`isStopped`), not just a log stream.
- Reacts with real venue transactions, and the run above is anchored on-chain.
- Tests use no network: `test/reactivity.test.ts`, `test/positions.test.ts` and `test/rest.test.ts`. They cover
  decoding, filters, the state machine, reconnect re-reads, the WebSocket transport (against a scripted socket), and
  an end-to-end stop that cancels a resting order on the sim venue.
