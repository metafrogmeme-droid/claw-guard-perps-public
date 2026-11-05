# Strategy rules (session rules 2 and 3)

Bot-side rules for the quoting strategy. They sit on top of the skew maker from #22 and can only make a session
stricter: they decide which quotes are worth asking for, when a trade ends, and when a session has lost enough.
They never change the guard policy (`SESSION_POLICY`), the on-chain limits or the contracts; every intent still
goes through `evaluate()` and the kill switch exactly as before.

The runtime rules (1, RPC health gate, and 4, flatten budget) live on the `main` stack in
`docs/SESSION_RULES.md`. All four share one file, passed with `session --rules <file.json>`; each loader reads its
own sections and refuses unknown top-level keys. Example with the defaults: [`strategy-rules.example.json`](strategy-rules.example.json).
With no `--rules` file the defaults below apply.

## Rule 2: profit rules (`profit`)

| Knob | Default | What it does |
| --- | --- | --- |
| `makerFeeBps` | `2` | Assumed maker fee per fill, bps. Testnet measured 0 on 2 Nov; 2 is a margin. |
| `minEdgeBps` | `3` | Edge an opening quote keeps after a round trip of maker fees, bps. |
| `takeProfitBps` | `50` | Per-trade take-profit: favourable move from entry, bps. `0` = off. |
| `maxSessionLossUsd` | `"1"` | Session stops quoting and closes out once equity is this far below its start, USD. |
| `postOnly` | `true` | Drop any opening intent that is not `post_only` before the guard sees it. |

The per-trade stop-loss is the skew maker's `stopBps` (default 60) and the time exit is `maxHoldSec` (default
1200 since the 4 Nov tweaks, was 1800), both from #22, set with `--skew-config` (validated strictly: unknown keys
and out-of-range values are refused). See "Skew quoting defaults" below.

- **Quote only with edge.** An opening quote at distance `d` bps from the mark is asked for only when
  `d >= 2 * makerFeeBps + minEdgeBps` (7 bps by default; the default half-spread is 25). Reducing quotes are
  never held back by this rule, so it cannot trap a position. Skipped quotes are logged as `[no edge]` and
  counted in the session result (`profit.noEdge`).
- **Post-only maker.** The skew maker only builds `post_only` orders; `makerOnly()` is a second, independent
  filter in the session runner and the replay. Reduce-only intents pass (close-outs must work).
- **Take-profit and stop-loss per trade.** When the mark has moved `takeProfitBps` in our favour (or `stopBps`
  against us) from the entry, the market switches to exit mode: a reduce-only `post_only` quote one tick inside
  the mark, requoted each cycle until flat. No taker exits from the strategy.
- **Max loss per session.** Checked on every snapshot (mark-to-market equity vs the session start). On a hit
  the session ends with reason `session loss limit: -X USDso (limit Y)` and runs the normal close-out
  (`session_aborted`, no kill-switch trip, no on-chain stop). The default $1 is about 10 bps of the testnet
  equity, far inside the guard's 200 bps drawdown kill switch.

## Skew quoting defaults (4 Nov tweaks)

Quoting only, picked from the 4 Nov daily and evening journals. No guard limit, `SESSION_POLICY` cap, kill switch
or on-chain stop changed. Every knob can be set back with `--skew-config` (the old values are in the table).

| Knob | Old | New | What it does |
| --- | --- | --- | --- |
| `maxHoldSec` | `1800` | `1200` | Time exit after 20 min instead of 30 (the daily sat in exit mode from ~2047 s). |
| `skewBps` | `20` | `35` | Reference shift at full strategy inventory: lean against inventory harder and sooner. |
| `halfSpreadBps` | `25` | `25` | Half-spread while calm (unchanged). |
| `volHalfSpreadBps` | (none) | `35` | Half-spread while the market is jumpy. Never below `halfSpreadBps`. |
| `volJumpBps` | (none) | `15` | Jumpy = a mark step of this many bps between two of the last `volWindow` snapshots. `0` = off. |
| `volWindow` | (none) | `5` | Snapshots per market the jump check looks back over (about 10 min at 120 s cycles). |
| `requoteBps` | `20` | `35` | A resting quote is replaced only when it is this far from its target (fewer cancels). |
| `exitRequoteBps` | exact | `10` | An exit quote keeps resting while within this of its target, instead of cancel + replace on every tick (13 requote cancels on 4 Nov were exit churn). `0` = the old exact match. |
| `focusHeavy` | (none) | `true` | Once two or more markets hold inventory: no new opening quotes anywhere, and the heaviest market (largest inventory notional) gets the full skew on its reducing quote. One market holding: unchanged. |

Two details that come with the wider settings:

- A resting quote is kept only while it is still on its side of the mark and (for an opening) keeps the
  `2 * makerFeeBps + minEdgeBps` edge. With `requoteBps` above the half-spread, a move of the mark could
  otherwise leave an old quote across the mark.
- With `skewBps` above the half-spread, the reducing quote at full inventory would land on the far side of the
  mark; it is placed one tick inside the mark instead (still `post_only`), never dropped.

Replay (72 h of 2 Nov testnet 1-minute candles, BTC + ETH, `scripts/backtest.ts`, penalty 1 tick; optimistic,
cents, no profit claim): old settings +$0.71 (fee 0) / +$0.58 (fee 2 bps), max drawdown $0.15; new settings
+$0.73 / +$0.57, max drawdown $0.09, 0 stop exits. One at a time, `requoteBps 35` without the stale-quote check
and `focusHeavy` alone both did worse; together with the other tweaks the result was about equal P&L at lower
drawdown. The next live 1 h runs are the real test.

## Rule 3: loss cooldown (`cooldown`)

| Knob | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Switch the rule off with `false`. |
| `lossStreak` | `2` | Losing trades in a row that start a cooldown. |
| `cooldownSec` | `600` | Cooldown length, seconds (10 minutes). |
| `lossToleranceCents` | `0` | A trade counts as losing below minus this many cents (0 = any loss). |

- **What a trade is.** Inferred from snapshots, the same code live and in the replay (`TradeTracker`): a trade
  opens when a market's position leaves zero and closes when it returns to zero or flips. The fill price is our
  own tracked order that vanished since the last cycle on the matching side, else the mark. P&L is average-entry
  accounting minus `profit.makerFeeBps` per fill (the replay uses its `--fee`). It is an estimate, not the
  venue's realized P&L; a closed trade is logged as `[trade] ... est. pnl`.
- **What the cooldown does.** When it starts (`[cooldown]` in the log), resting quotes that would open or add to
  a position are pulled. Until it ends, opening intents are dropped and quotes on the reducing side go out as
  reduce-only, capped at the position, so the bot can still get flat. The status file shows
  `running (cooldown: reduce only)`. The streak resets after each cooldown and on any winning trade.
- The session keeps running through a cooldown; the deadline, the loss stop and the guard are unchanged.

## Replay: before and after the rules

`pnpm exec tsx scripts/backtest.ts /workspace/cgp-candles-1m.json --strategy skew [...]`, 72 h of recorded
dreamDEX 1-minute candles (BTC, ETH), `SESSION_POLICY`, penalty 1 tick unless noted. "Before" is `--no-rules`
(the #22 maker as it was). Real replay output, 2 Nov 2026:

| Run | P&L USD | Round trips | Win rate | Max DD USD | Exits | Loss stops |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| before, fee 0 | +0.760967 | 45 | 80.0% | 0.152673 | stop 2, time 11 | n/a |
| after, fee 0 | +0.707843 | 45 | 80.0% | 0.152673 | stop 2, tp 2, time 11 | 0 |
| before, fee 2 bps | +0.559300 | 45 | 80.0% | 0.152673 | stop 2, time 11 | n/a |
| after, fee 2 bps | +0.506038 | 45 | 80.0% | 0.152673 | stop 2, tp 2, time 11 | 0 |
| after, fee 2, 1 h sessions | +0.506038 | 45 | 80.0% | 0.152673 | stop 2, tp 2, time 11 | 0 of 72 |
| after, fee 2, `takeProfitBps` 0 | +0.559300 | 45 | 80.0% | 0.152673 | stop 2, time 11 | 0 |
| after, fee 2, 1 h sessions, loss limit $0.05 | +0.437730 | 45 | 75.6% | 0.152673 | stop 2, tp 2, time 8 | 2 of 72 |
| after, fee 2, `makerFeeBps` 12 | 0 | 0 | n/a | 0 | none | 0 |
| before, fee 2, penalty 2 | +0.590988 | 45 | 82.2% | 0.152673 | stop 2, time 11 | n/a |
| after, fee 2, penalty 2 | +0.507876 | 44 | 81.8% | 0.152673 | stop 2, tp 2, time 11 | 0 |

Reading it:

- At the defaults the edge floor and the $1 loss limit never bind on this window (the worst drawdown is $0.15).
  They are guard rails for worse markets and higher fees, not a P&L lever.
- The take-profit fired twice and cost about $0.05 (fee 0 and fee 2) to $0.08 (penalty 2): on this data the
  skewed opposite quote captured more than an exit one tick inside the mark. Turning it off restores the #22
  numbers exactly. Default kept at 50 bps as asked; see "Decisions" below.
- With `makerFeeBps` 12 the floor (27 bps) is above the 25 bps half-spread, so the maker quotes nothing: the rule
  works as a hard "no edge, no quote".
- A tight $0.05 per-hour loss limit stopped 2 of 72 sessions and cost $0.07: it cuts losers and the recoveries
  that would have followed.

### With rule 3 added (rules 2 + 3, all defaults)

| Run | P&L USD | Round trips | Win rate | Max DD USD | Exits | Trades seen | Cooldowns | Openings dropped |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| before, fee 0 | +0.760967 | 45 | 80.0% | 0.152673 | stop 2, time 11 | n/a | n/a | n/a |
| rules 2 + 3, fee 0 | +0.727859 | 45 | 80.0% | 0.152673 | stop 2, tp 2, time 9 | 36 | 2 | 40 |
| before, fee 2 bps | +0.559300 | 45 | 80.0% | 0.152673 | stop 2, time 11 | n/a | n/a | n/a |
| rules 2 + 3, fee 2 bps | +0.560623 | 46 | 78.3% | 0.130526 | stop 2, time 9 | 36 | 4 | 59 |
| rules 2 + 3, fee 2, 1 h sessions | +0.560623 | 46 | 78.3% | 0.130526 | stop 2, time 9 | 36 | 4 | 59 |
| before, fee 2, penalty 2 | +0.590988 | 45 | 82.2% | 0.152673 | stop 2, time 11 | n/a | n/a | n/a |
| rules 2 + 3, fee 2, penalty 2 | +0.560623 | 46 | 78.3% | 0.130526 | stop 2, time 9 | 36 | 4 | 59 |

- At fee 2 bps the cooldown pays back the take-profit cost (+$0.5606 vs +$0.5593 before, +$0.5060 with rule 2
  alone) and cuts the worst drawdown from $0.153 to $0.131. At fee 0 it costs $0.033 vs before.
- With rules 2 + 3 at fee 2 the result did not change between penalty 0, 1, 2 and 5 ticks (checked): the fills
  the penalty removes fall inside cooldown windows on this data. Before the rules, penalty 2 was +$0.591.
- "Trades seen" (36) is the cooldown's snapshot estimate; "round trips" (45) counts every reducing fill.
- Win rate here counts reducing fills, so dropped re-entries during a cooldown change it slightly.

Replay caveats from #22 apply: fills are optimistic (no queue), 72 h is a short window, testnet markets are thin.

## Threat-model notes

| Threat | Rule | Effect |
| --- | --- | --- |
| Fees or a fee change eat the spread, the bot pays to trade | edge floor | no opening quote below `2*fee + minEdge` |
| A bug or config produces a taker opening order | `postOnly` filter | dropped before the guard, logged `[maker only]` |
| A winner turns into a loser while held | take-profit | reduce-only post-only exit once up `takeProfitBps` |
| A trending market bleeds a session slowly, under the kill switch | session loss stop | session ends at `maxSessionLossUsd`, close-out, no on-chain stop |
| A rules file loosens the guard | design | rules only feed the strategy and the session loop; the guard policy, on-chain limits and contracts are untouched and not reachable from the file |
| A losing streak keeps reloading into a bad market | cooldown | after 2 losers, 10 minutes of reduce-only |
| Cooldown traps a position | design | reducing quotes still go out (reduce-only); close-out and kill switch unaffected |
| Misjudged trade P&L (estimate from snapshots) | design | the error only changes when the bot pauses, never what the guard allows |
| Typo in a rules or skew file silently ignored | strict schemas | unknown keys and out-of-range values refuse to start |

## Decisions for the owner

- `takeProfitBps` default 50 vs 0 (off): on this replay it costs about $0.05 to $0.08.
- `maxSessionLossUsd` default $1 per session.
- `makerFeeBps` assumes 2 bps; testnet measured 0.
- The cooldown's trade P&L is an estimate from snapshots (no venue fill feed); good enough to pause, not for
  accounting.
