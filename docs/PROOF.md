# Proof on Somnia Tokyo testnet

Chain 50383. Explorer: https://explorer.testnet.somnia.network/tokyo. Key and gate signer for live runs:
`0x39791a9Df0bb96EBaEEaE2C6754bB76EbD09C67D`. SDK `@somnia-chain/markets-sdk` 0.32.1.

## ClawGuardReceipts

| What | Value |
| --- | --- |
| Contract | `0xeda7071961c518ce154062cb6d8e94219f8c29b3` |
| Deploy (1 Nov 2026) | [`0x3f6cda22…d5e7`](https://explorer.testnet.somnia.network/tokyo/tx/0x3f6cda22ad6905c078f509bc44952cc15cb7c378dd93642c75a9702e3502d5e7) |

### Live-market journal (14 decisions against dreamDEX marks, signed by the bot key)

Journal id `0x5ea7e1904c9b36b8869243bc218151f6f4e6db8ef40c97ec58dee97ae5ad81f9`, head
`0x1dea2c3e5214b2954f526ce1415dd80c9f35016385b9e7c5ee83109508d36355`. The account had no margin yet, so every
order is `Blocked by your rule: … NO_EQUITY, VENUE_MAX_SIZE` on top of the mistake each scripted intent carries
(off-allowlist market, 18-decimal quantity, 10x cap, 10% from mark, reduce-only with no position, off-tick price).

- [`0xa01162e0…b201`](https://explorer.testnet.somnia.network/tokyo/tx/0xa01162e0a4a7f07891c2cbf8af17e4a1958412eef50ecf2b818ef4a5dafeb201)
- [`0x6973836d…4cb4`](https://explorer.testnet.somnia.network/tokyo/tx/0x6973836d71b132f6c53a8b0849cb6238937c173a303b552881d8eefaad094cb4)

### Simulated-venue journal (37 receipts, including a kill switch)

Journal id `0x282d3e30d6795c31b00272a190828384ee85d5b2ad9af6af109141ed89228686`. After anchoring,
`isStopped(0xFe2D6B2f469b53Dff125332e15D1950784e0389A)` reads `true` on-chain.

- [`0x13be500c…a58c`](https://explorer.testnet.somnia.network/tokyo/tx/0x13be500cddfc93facf6da09fb446c0db63d6ac0a6b8505ed96d58e8525fba58c)
- [`0xa71a2d38…b2b1`](https://explorer.testnet.somnia.network/tokyo/tx/0xa71a2d384f6b2aa74e875fad7b502f2047a822cb78ac81f1a3751825faa392b1)
- [`0xaddc7f28…3dd`](https://explorer.testnet.somnia.network/tokyo/tx/0xaddc7f28635ec36eac15d1b304d746d674f18f85293720243ec29d1e86cdb3dd)
- [`0xeb2b8394…3110`](https://explorer.testnet.somnia.network/tokyo/tx/0xeb2b839449ce820af3ee274aab636e47283acc334068ce0c358f02dce7403110)
- [`0x0a0dae70…a26`](https://explorer.testnet.somnia.network/tokyo/tx/0x0a0dae7047583f122effba8f43b140abe1b090c43a71f41d23457884068faa26)

## Perps orders (linked bot key, 1 Nov 2026)

The owner's Perps Arena wallet `0x3C9650bb62e913c33F662D6De2F4C0C5C617a898` linked the bot key
`0x39791a9Df0bb96EBaEEaE2C6754bB76EbD09C67D` (`pnpm cli doctor`: link place=true cancel=true on BTC, ETH and SOL)
and holds 1,000 paper USDso of perps margin. The bot key sends the orders; the owner's margin backs them.

Journal id `0xe7d4f1c1fd93ec6227c37e278f0932a2341bebbc18e658b188eb5bdd46013ebb`, 10 receipts, head
`0xd7d382ed0aec3a73c01efc9250305354a1269cd03f66595581a7d2d2f0d3c283`. Copies:
[journal](proof/live-linked-2026-11-01.jsonl), [trace](proof/live-linked-2026-11-01.html).

| # | Intent (BTC-PERP unless noted) | Verdict | On-chain |
| --- | --- | --- | --- |
| 0 | DOGE-PERP, not on the allowlist | Blocked by your rule: MARKET_NOT_ALLOWED, … | nothing sent |
| 1 | quantity in 18 decimals | Blocked by your rule: DECIMALS_MISMATCH, ORDER_NOTIONAL_CAP, … | nothing sent |
| 2 | ten times the per-order cap | Blocked by your rule: ORDER_NOTIONAL_CAP, POSITION_CAP | nothing sent |
| 3 | limit 10% from the mark | Blocked by your rule: PRICE_FAR_FROM_MARK | nothing sent |
| 4 | reduce-only with no position | Blocked by your rule: NOT_REDUCING | nothing sent |
| 5 | price off the tick grid | Blocked by your rule: PRICE_OFF_TICK | nothing sent |
| 6 | taker (IOC) inside every cap | Needs your OK: TAKER_ORDER | owner did not approve, nothing sent |
| 7 | post-only bid 0.00014 BTC (~10.87 USD) | Allowed: within your limits | place [`0xb84c8a2b…8c07`](https://explorer.testnet.somnia.network/tokyo/tx/0xb84c8a2b4d87a8b65f3feaf424bc6709fab2d7c2a5a21230daf46ea0f5dd8c07) (order 8005886927989954736138) |
| 9 | cancel of order #7 | (execution) | cancel [`0xd446216c…5be8`](https://explorer.testnet.somnia.network/tokyo/tx/0xd446216c7bd4b8f10c965cb8ad3f05f1b5b64968c73f03ed281b0cdd180d5be8) |

Receipts anchored in ClawGuardReceipts (on-chain next seq 10):

- [`0x910a72ee…9bf3`](https://explorer.testnet.somnia.network/tokyo/tx/0x910a72eeba83b38cc5e4582787aea18528e34a97ac1a08ecab85c25047f59bf3)
- [`0x0c829885…0535`](https://explorer.testnet.somnia.network/tokyo/tx/0x0c8298850594e0ce75c703a203b14adb976dc0fbdf9bae039dac563484190535)

After the run: 0 open orders, no positions, equity 1,000 USDso (account flat).

## Filled trade with the owner's OK (linked bot key, 1 Nov 2026 18:14 CET)

`pnpm cli fill --live --yes --market BTC-PERP`: one minimal taker order on the "Needs your OK" path, approved
by the owner in the run (`--yes`) and recorded as approved (`ownerOk: true` in the signed decision receipt),
then a reduce-only close for exactly the filled size. The close adds no exposure, so the gate allows it without
asking. The run refuses to start unless the account is flat, and trips the kill switch if it does not end flat
(it did not need to).

Journal id `0xbeeacf625d485e10bcb9abefaee436b6e9a52b1b490016e63bd6f9f3e91d13ee`, 4 receipts, head
`0xdd8f5a5edfb112d3fbfe6a81f3ddd58efc80a613e883083b8f41a43466d5baac`. Copies:
[journal](proof/fill-linked-2026-11-01.jsonl), [trace](proof/fill-linked-2026-11-01.html).

| # | Intent | Verdict | On-chain |
| --- | --- | --- | --- |
| 0 | IOC long 0.00014 BTC, limit 78,276.0 (best ask + 10 bps) | Needs your OK: TAKER_ORDER, owner said yes | |
| 1 | (execution of #0) | | fill [`0x007f82ac…6656`](https://explorer.testnet.somnia.network/tokyo/tx/0x007f82ac722a01e1de18f012dd4ff04aca6aa539379b130a8bdd99d2dbbc6656): 0.00014 BTC bought at 78,197.2 |
| 2 | reduce-only IOC short 0.00014 BTC, limit 78,119.0 | Allowed: within your limits | |
| 3 | (execution of #2) | | close [`0xad4b87f9…d3e2`](https://explorer.testnet.somnia.network/tokyo/tx/0xad4b87f9ed47f26a79a505aaadeed77aff258dcf74e009ffd33f261e892cd3e2): 0.00014 BTC sold at 78,203.6 |

Both orders filled completely against resting maker orders in the same transaction (taker remaining 0).

Receipts anchored in ClawGuardReceipts (on-chain next seq 4):

- [`0xccdb3982…bf23`](https://explorer.testnet.somnia.network/tokyo/tx/0xccdb398296acd0038e40aa1086c64f4daf1d5864638c1acda106860a39acbf23)

After the run: 0 open orders, no positions, equity 1,000.000896 USDso (account flat).

dreamDEX has no reduce-only flag on a direct perp order, so "reduce-only" is enforced by the gate: it reads the
on-chain position first and blocks (`NOT_REDUCING`) any order marked reduce-only that would not shrink it.

## Somnia Reactivity: on-chain stop and position pushes (1 Nov 2026 18:25–18:28 CET)

`watch --react` received the `Stopped` push for the remote-stop tx
[`0x1b3c32cd…3ef4`](https://explorer.testnet.somnia.network/tokyo/tx/0x1b3c32cdae6daa6dbe4f0563616c575dba61fdee59109ab6e17b591599af3ef4)
within the block's second and cancelled the resting bid
([`0xb0baccda…f0c7`](https://explorer.testnet.somnia.network/tokyo/tx/0xb0baccda4c4f4843c5543a3d6d88899fe6c37a08a8999cdaf02a72e78372f0c7)).
It then logged the re-arm and the `PositionUpdated` pushes of a second owner-approved fill and its close. The account
ended flat. The full table and the anchors are in [REACTIVITY.md](REACTIVITY.md), and the raw files are in
[proof/reactivity-2026-11-01/](proof/reactivity-2026-11-01/).

## Probe run, live (3 Nov 2026)

65 deliberately wrong orders through the gate on dreamDEX Tokyo testnet, after the `INTENT_MALFORMED` fix:
65 of 65 as expected, 0 known gaps, 0 new. One order went to the venue (the post-only control quote, cancelled
right away, 0 filled); 0 blocked or held probes were sent. 73 signed receipts, chain ok, anchored in 10 batches
(journal `0x82a0570e73aab0d1810f535013cb2db3804994bb87d866a8b3706a40156ca6ca`). Doctor before and after: stop
off, 0 orders, 0 positions, equity unchanged. Summary with explorer links:
[proof/probes-live-2026-11-03/summary.md](proof/probes-live-2026-11-03/summary.md).
