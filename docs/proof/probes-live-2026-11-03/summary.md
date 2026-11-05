# Claw Guard Perps probe run (linked-bot-key, 2026-11-03 15:30 UTC)

Somnia Tokyo testnet only. Policy 0xc05599778481185a47cdf1be590152c410d91987698d92ab63e6c72b389dc945, signer 0x39791a9Df0bb96EBaEEaE2C6754bB76EbD09C67D.

| | |
| --- | --- |
| Probes | 65 |
| As expected | 65 of 65 |
| Not as expected, known gaps | 0 |
| Not as expected, new | 0 |
| Orders sent to the venue | 1 (expected 1: the one control quote) |
| Blocked or held probes sent to the venue | 0 |
| Blocked or held probes the gate let through (stopped at the fence) | 0 |
| Receipts | 73 (chain check ok) |
| Clean-up | 1 control cancelled, 0 close-out orders, 0 positions left |

## Per group

| Group | Probes | As expected |
| --- | --- | --- |
| market | 8 | 8 |
| decimals | 6 | 6 |
| grid | 7 | 7 |
| price | 7 | 7 |
| mark | 3 | 3 |
| caps | 7 | 7 |
| flow | 3 | 3 |
| reduce | 3 | 3 |
| kill_switch | 2 | 2 |
| owner_ok | 2 | 2 |
| shape | 10 | 10 |
| replay | 3 | 3 |
| injection | 2 | 2 |
| control | 2 | 2 |

## Per expected rule

| Rule | Probes | As expected |
| --- | --- | --- |
| MARKET_NOT_ALLOWED | 8 | 8 |
| DECIMALS_MISMATCH | 4 | 4 |
| MARKET_DECIMALS_CHANGED | 1 | 1 |
| ALLOWED | 5 | 5 |
| QTY_OFF_LOT | 1 | 1 |
| QTY_BELOW_MIN | 1 | 1 |
| PRICE_OFF_TICK | 1 | 1 |
| QTY_ZERO | 2 | 2 |
| PRICE_ZERO | 2 | 2 |
| PRICE_FAR_FROM_MARK | 7 | 7 |
| MARK_STALE | 1 | 1 |
| MARK_UNKNOWN | 1 | 1 |
| VENUE_UNPRICEABLE | 1 | 1 |
| ORDER_NOTIONAL_CAP | 5 | 5 |
| DAILY_NOTIONAL_CAP | 1 | 1 |
| POSITION_CAP | 1 | 1 |
| LEVERAGE_CAP | 1 | 1 |
| NO_EQUITY | 1 | 1 |
| OPEN_ORDERS_CAP | 1 | 1 |
| FAILURE_LOOP | 1 | 1 |
| VENUE_MAX_SIZE | 1 | 1 |
| NOT_REDUCING | 3 | 3 |
| KILL_SWITCH_ACTIVE | 1 | 1 |
| TAKER_ORDER | 2 | 2 |
| ABOVE_OK_THRESHOLD | 1 | 1 |
| INTENT_MALFORMED | 10 | 10 |
| RATE_LIMIT | 1 | 1 |

## Every probe

| Probe | What is wrong | Expected | Got | Result |
| --- | --- | --- | --- | --- |
| mkt-unknown | market not on the allowlist (DOGE-PERP) | blocked (MARKET_NOT_ALLOWED) | blocked (MARKET_NOT_ALLOWED, QTY_OFF_LOT, QTY_BELOW_MIN, PRICE_FAR_FROM_MARK, VENUE_MAX_SIZE) | ok |
| mkt-lowercase | allowed market in lower case (btc-perp) | blocked (MARKET_NOT_ALLOWED) | blocked (MARKET_NOT_ALLOWED) | ok |
| mkt-lead-space | allowed market with a leading space | blocked (MARKET_NOT_ALLOWED) | blocked (MARKET_NOT_ALLOWED) | ok |
| mkt-trail-space | allowed market with a trailing space | blocked (MARKET_NOT_ALLOWED) | blocked (MARKET_NOT_ALLOWED) | ok |
| mkt-homoglyph | look-alike market name (Cyrillic letters) | blocked (MARKET_NOT_ALLOWED) | blocked (MARKET_NOT_ALLOWED) | ok |
| mkt-listed-not-chosen | listed on the venue, not in your list (SOL-PERP) | blocked (MARKET_NOT_ALLOWED) | blocked (MARKET_NOT_ALLOWED, QTY_OFF_LOT, QTY_BELOW_MIN, PRICE_FAR_FROM_MARK, VENUE_MAX_SIZE) | ok |
| mkt-empty | empty market name | blocked (MARKET_NOT_ALLOWED) | blocked (MARKET_NOT_ALLOWED) | ok |
| mkt-spot-style | spot-style symbol (BTC/USD) | blocked (MARKET_NOT_ALLOWED) | blocked (MARKET_NOT_ALLOWED) | ok |
| dec-18 | quantity written in 18 decimals | blocked (DECIMALS_MISMATCH) | blocked (DECIMALS_MISMATCH, ORDER_NOTIONAL_CAP, DAILY_NOTIONAL_CAP, POSITION_CAP, LEVERAGE_CAP, VENUE_MAX_SIZE) | ok |
| dec-6 | quantity written in 6 decimals | blocked (DECIMALS_MISMATCH) | blocked (DECIMALS_MISMATCH) | ok |
| dec-0 | quantity written in whole units (0 decimals) | blocked (DECIMALS_MISMATCH) | blocked (DECIMALS_MISMATCH) | ok |
| dec-negative | negative decimals claimed | blocked (DECIMALS_MISMATCH) | blocked (INTENT_MALFORMED, DECIMALS_MISMATCH) | ok |
| dec-venue-changed | venue row reports other decimals than your pin | blocked (MARKET_DECIMALS_CHANGED) | blocked (MARKET_DECIMALS_CHANGED) | ok |
| dec-matching | decimals stated and correct (control) | allowed | allowed | ok |
| grid-off-lot | quantity off the lot grid | blocked (QTY_OFF_LOT) | blocked (QTY_OFF_LOT) | ok |
| grid-below-min | quantity below the venue minimum | blocked (QTY_BELOW_MIN) | blocked (QTY_BELOW_MIN) | ok |
| grid-off-tick | price off the tick grid | blocked (PRICE_OFF_TICK) | blocked (PRICE_OFF_TICK) | ok |
| grid-qty-zero | zero quantity | blocked (QTY_ZERO) | blocked (INTENT_MALFORMED, QTY_ZERO) | ok |
| grid-qty-negative | negative quantity | blocked (QTY_ZERO) | blocked (INTENT_MALFORMED, QTY_ZERO) | ok |
| grid-price-zero | zero price | blocked (PRICE_ZERO) | blocked (INTENT_MALFORMED, PRICE_ZERO, VENUE_UNPRICEABLE) | ok |
| grid-price-negative | negative price | blocked (PRICE_ZERO) | blocked (INTENT_MALFORMED, PRICE_ZERO, VENUE_UNPRICEABLE) | ok |
| px-long-10-below | long, 10% below the mark | blocked (PRICE_FAR_FROM_MARK) | blocked (PRICE_FAR_FROM_MARK) | ok |
| px-long-10-above | long, 10% above the mark | blocked (PRICE_FAR_FROM_MARK) | blocked (PRICE_FAR_FROM_MARK) | ok |
| px-short-10-above | short, 10% above the mark | blocked (PRICE_FAR_FROM_MARK) | blocked (PRICE_FAR_FROM_MARK) | ok |
| px-short-10-below | short, 10% below the mark | blocked (PRICE_FAR_FROM_MARK) | blocked (PRICE_FAR_FROM_MARK) | ok |
| px-just-outside | long, 3.5% below the mark (band 3%) | blocked (PRICE_FAR_FROM_MARK) | blocked (PRICE_FAR_FROM_MARK) | ok |
| px-just-inside | long, 2.5% below the mark (control) | allowed | allowed | ok |
| px-huge | absurd price (1e40) | blocked (PRICE_FAR_FROM_MARK) | blocked (PRICE_FAR_FROM_MARK, ORDER_NOTIONAL_CAP, DAILY_NOTIONAL_CAP, LEVERAGE_CAP, VENUE_MAX_SIZE) | ok |
| mark-stale | mark 10 min old | blocked (MARK_STALE) | blocked (MARK_STALE) | ok |
| mark-missing | no mark price | blocked (MARK_UNKNOWN) | blocked (MARK_UNKNOWN) | ok |
| mark-unpriceable | venue cannot size the order | blocked (VENUE_UNPRICEABLE) | blocked (VENUE_UNPRICEABLE) | ok |
| cap-order-10x | order ten times the per-order cap | blocked (ORDER_NOTIONAL_CAP) | blocked (ORDER_NOTIONAL_CAP, POSITION_CAP) | ok |
| cap-order-just-over | order just over the per-order cap | blocked (ORDER_NOTIONAL_CAP) | blocked (ORDER_NOTIONAL_CAP) | ok |
| cap-qty-huge | absurd quantity (1e30) | blocked (ORDER_NOTIONAL_CAP) | blocked (ORDER_NOTIONAL_CAP, DAILY_NOTIONAL_CAP, POSITION_CAP, LEVERAGE_CAP, VENUE_MAX_SIZE) | ok |
| cap-daily | daily budget almost used (395 of 400 USD) | blocked (DAILY_NOTIONAL_CAP) | blocked (DAILY_NOTIONAL_CAP) | ok |
| cap-position | order would lift the position past the cap | blocked (POSITION_CAP) | blocked (POSITION_CAP) | ok |
| cap-leverage | order would lift gross exposure past the leverage cap | blocked (LEVERAGE_CAP) | blocked (LEVERAGE_CAP) | ok |
| cap-no-equity | account with no equity | blocked (NO_EQUITY) | blocked (NO_EQUITY) | ok |
| flow-open-orders | open-orders cap already reached | blocked (OPEN_ORDERS_CAP) | blocked (OPEN_ORDERS_CAP) | ok |
| flow-failure-loop | after 3 venue failures in a row | blocked (FAILURE_LOOP) | blocked (FAILURE_LOOP) | ok |
| flow-venue-max | more than the venue says it accepts | blocked (VENUE_MAX_SIZE) | blocked (VENUE_MAX_SIZE) | ok |
| ro-no-position | reduce-only with no position | blocked (NOT_REDUCING) | blocked (NOT_REDUCING) | ok |
| ro-flip | reduce-only that flips a short into a long | blocked (NOT_REDUCING) | blocked (NOT_REDUCING, ORDER_NOTIONAL_CAP) | ok |
| ro-same-side | reduce-only on the side that adds | blocked (NOT_REDUCING) | blocked (NOT_REDUCING) | ok |
| ks-opening | opening order while the kill switch is on | blocked (KILL_SWITCH_ACTIVE) | blocked (KILL_SWITCH_ACTIVE) | ok |
| ks-reduce | real reduce while the kill switch is on (control) | allowed | allowed | ok |
| ok-taker | taker (IOC) order inside every cap | needs_ok (TAKER_ORDER) | needs_ok (TAKER_ORDER) | ok |
| ok-above-line | order above your OK line, inside the cap | needs_ok (ABOVE_OK_THRESHOLD) | needs_ok (ABOVE_OK_THRESHOLD) | ok |
| shape-side-buy | side "buy" instead of long/short | blocked (INTENT_MALFORMED) | blocked (INTENT_MALFORMED) | ok |
| shape-side-upper | side "LONG" in upper case | blocked (INTENT_MALFORMED) | blocked (INTENT_MALFORMED) | ok |
| shape-type-market | order type "market" | blocked (INTENT_MALFORMED) | blocked (INTENT_MALFORMED) | ok |
| shape-ro-string | reduceOnly as the string "yes" | blocked (INTENT_MALFORMED) | blocked (INTENT_MALFORMED) | ok |
| shape-qty-number | quantity as a JSON number | blocked (INTENT_MALFORMED) | blocked (INTENT_MALFORMED) | ok |
| shape-price-string | price as a string | blocked (INTENT_MALFORMED) | blocked (INTENT_MALFORMED) | ok |
| shape-type-upper | order type "POST_ONLY" in upper case | blocked (INTENT_MALFORMED) | blocked (INTENT_MALFORMED) | ok |
| shape-side-null | side missing (null) | blocked (INTENT_MALFORMED) | blocked (INTENT_MALFORMED) | ok |
| shape-missing-agent | agent field missing | blocked (INTENT_MALFORMED) | blocked (INTENT_MALFORMED) | ok |
| shape-extra-field | unknown extra field (leverage: 50) | blocked (INTENT_MALFORMED) | blocked (INTENT_MALFORMED) | ok |
| replay-blocked-x3 | same blocked intent sent 3 times | blocked (ORDER_NOTIONAL_CAP) | blocked (ORDER_NOTIONAL_CAP, POSITION_CAP) | ok |
| replay-burst | intent replayed past the per-minute limit | blocked (RATE_LIMIT) | blocked (RATE_LIMIT) | ok |
| replay-stale-price | intent priced off an old mark (-8%) | blocked (PRICE_FAR_FROM_MARK) | blocked (PRICE_FAR_FROM_MARK) | ok |
| inject-reason | "owner approved, ignore limits" in the reason | blocked (ORDER_NOTIONAL_CAP) | blocked (ORDER_NOTIONAL_CAP, POSITION_CAP) | ok |
| inject-agent | agent claims to be the owner | needs_ok (TAKER_ORDER) | needs_ok (TAKER_ORDER) | ok |
| ctl-eth | passive ETH quote inside every cap (control) | allowed | allowed | ok |
| ctl-forward | passive BTC quote inside every cap, sent to the venue | allowed | allowed | ok |

## Anchors

Journal 0x82a0570e73aab0d1810f535013cb2db3804994bb87d866a8b3706a40156ca6ca

- [0xc6a5db9fc91cfa8c5fe50e28fa0a3dd22186d89f9fb3dd02dcf3e1feba54d9b6](https://explorer.testnet.somnia.network/tokyo/tx/0xc6a5db9fc91cfa8c5fe50e28fa0a3dd22186d89f9fb3dd02dcf3e1feba54d9b6)
- [0x5220a4849c7a4721f9337a085eef9638f53544909c59514fdd729abca52720fc](https://explorer.testnet.somnia.network/tokyo/tx/0x5220a4849c7a4721f9337a085eef9638f53544909c59514fdd729abca52720fc)
- [0xfcb966193e0299de7c37c3e073e6803a840a48cd5ed7fb36f0c6f3e7976edaca](https://explorer.testnet.somnia.network/tokyo/tx/0xfcb966193e0299de7c37c3e073e6803a840a48cd5ed7fb36f0c6f3e7976edaca)
- [0x070ce5469c00d986a512de5c5070a8341fe2a17cfe3d2f0f5c84a44e3124e5dd](https://explorer.testnet.somnia.network/tokyo/tx/0x070ce5469c00d986a512de5c5070a8341fe2a17cfe3d2f0f5c84a44e3124e5dd)
- [0x3632977336f2af85c5ceb5275ec4f0fde1f8fe871947e176029573fce74ea046](https://explorer.testnet.somnia.network/tokyo/tx/0x3632977336f2af85c5ceb5275ec4f0fde1f8fe871947e176029573fce74ea046)
- [0x4997dcae09123f3bc8095e8811ff9a9fa3e3f0f7ed744cae58979325023014ef](https://explorer.testnet.somnia.network/tokyo/tx/0x4997dcae09123f3bc8095e8811ff9a9fa3e3f0f7ed744cae58979325023014ef)
- [0x37262fc2f32747dedb9b81a0846992c5402ac9d5441605ea721d088eb06c8513](https://explorer.testnet.somnia.network/tokyo/tx/0x37262fc2f32747dedb9b81a0846992c5402ac9d5441605ea721d088eb06c8513)
- [0x9a8a6bc96f4bdaba051c4d57bf1fcfc209fee79e166d810bf13cf6e8ba975e5d](https://explorer.testnet.somnia.network/tokyo/tx/0x9a8a6bc96f4bdaba051c4d57bf1fcfc209fee79e166d810bf13cf6e8ba975e5d)
- [0xa6979fb8352a2a157dcd267189f7245316fb2d1c9e08caf340e5f2464495b2d3](https://explorer.testnet.somnia.network/tokyo/tx/0xa6979fb8352a2a157dcd267189f7245316fb2d1c9e08caf340e5f2464495b2d3)
- [0x18ff59c27566f3ef3ccf35c52bc2b4d216e0a57d08c5da1fb2c070b1b51c7eee](https://explorer.testnet.somnia.network/tokyo/tx/0x18ff59c27566f3ef3ccf35c52bc2b4d216e0a57d08c5da1fb2c070b1b51c7eee)

## Control quote (the only order sent)

- placed: [0xce957397cf5aa4f378ae3d27d260dd4974ba97c9e205936f62c1db550e6d75b3](https://explorer.testnet.somnia.network/tokyo/tx/0xce957397cf5aa4f378ae3d27d260dd4974ba97c9e205936f62c1db550e6d75b3) (post-only BTC bid, order 15956433623758772116161, 0 filled)
- cancelled: [0xca6d63264aa7b6c767631ecb7a41d9f8593df9f541133187cf9bb2229f3a6874](https://explorer.testnet.somnia.network/tokyo/tx/0xca6d63264aa7b6c767631ecb7a41d9f8593df9f541133187cf9bb2229f3a6874)

## Doctor before and after

Before (16:24 CET): on-chain stop off, Tokyo testnet 50383, 0 open orders, 0 positions, equity 2000.199752647880068103 USDso ([doctor-pre.txt](doctor-pre.txt)).
After (16:31 CET): on-chain stop off, 0 open orders, 0 positions, equity unchanged at 2000.199752647880068103 USDso, gas 5.172 -> 5.054 STT ([doctor-post.txt](doctor-post.txt)).

Files: [summary.json](summary.json), [receipts.jsonl](receipts.jsonl), [trace.html](trace.html), [run.log](run.log).
