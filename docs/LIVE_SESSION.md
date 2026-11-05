# Live session, 1 Nov 2026 (Tokyo testnet)

A three-hour guarded session on dreamDEX Perps (Somnia Tokyo testnet) with the linked bot key
`0x39791a9Df0bb96EBaEEaE2C6754bB76EbD09C67D` trading for the app account
`0x3C9650bb62e913c33F662D6De2F4C0C5C617a898`. Testnet only, paper USDso from Perps Arena.

Command: `claw-guard session --live --hours 3 --cycle 120 --probe 5`, run next to
`claw-guard watch --react --policy session`.

## What happened

| | |
|---|---|
| Start | 18:32:20 CET, equity 1000.001008 USDso |
| Cycles | 69 (one every 2 min), a rule probe every 5th cycle |
| Allowed and sent | 5 post-only band quotes (BTC and ETH, bid and ask, plus one ETH re-quote), all accepted by the venue |
| Blocked by a rule | 12 probes |
| Needs your OK | 1 (taker order inside every cap; no owner answer, so not sent) |
| Fill | ETH bid 0.0047 @ 2253.62 filled as maker at 20:09 CET; the watcher saw `PositionUpdated` within its push and judged it within limits (10.65 USD) |
| End | flat: 0 open orders, 0 positions, equity 1000.035993 USDso, on-chain stop off |

Blocked codes (a probe can hit several): PRICE_FAR_FROM_MARK 4, VENUE_MAX_SIZE 4, ORDER_NOTIONAL_CAP 4,
POSITION_CAP 4, MARKET_NOT_ALLOWED 2, QTY_OFF_LOT 2, QTY_BELOW_MIN 2, DECIMALS_MISMATCH 2,
DAILY_NOTIONAL_CAP 2, LEVERAGE_CAP 2, NOT_REDUCING 2, PRICE_OFF_TICK 2.

## Incident: the runner stalled before its end

After the last probe (21:02 CET) the session runner stopped writing; its last status was 21:11 CET and it did
not flatten at its 21:32 deadline. The watcher kept reconnecting its websocket every ~4.5 minutes but also
stopped logging after 21:08 CET. Both were stopped by the operator at 21:53 CET (the runner had just logged
"ending (time is up); flattening" but had not journaled or sent anything yet).

The account still had the 4 resting band quotes and the 0.0047 ETH long. The operator flattened with
`claw-guard kill` into a separate journal: 4 cancels and one reduce-only IOC close of the ETH position.
Both journals verify and are anchored on chain.

### Root cause

Cycle 70 started at about 21:13 CET and made only reads (gas balance, kill switch check, snapshot: SDK
websocket reads, indexer and HTTP RPC). One of them did not settle for about 40 minutes. It came back at
21:52:55 CET, 12 seconds after the provider dropped every websocket (the watcher logged "websocket error" on
both its sockets at 21:52:43 CET). The loop then saw its deadline had passed and started the flatten, and the
operator's SIGTERM landed seconds later. The runner awaited every call with no bound of its own, checked the
deadline only at the top of each cycle, did not handle SIGTERM, and a close-out failure would have thrown
before any report. The watcher's sockets went half-open the same way (no frames, no close), so it logged
nothing; its `--seconds` end then waited on a `stop()` that had no bound either and never printed
"watch ended".

### Fix (`fix/session-watchdog`)

- Every venue call is bounded (`--call-timeout`, default 30 s for reads, 60 s for writes). A read that times
  out stops the loop; a write that times out is journaled as a venue failure (it may still land, so the
  close-out re-reads). HTTP RPC has a 15 s timeout and 1 retry; receipt waits are 60 s.
- A deadline watchdog timer, independent of the loop, stops it `--grace` seconds (default 60) after the
  deadline even while it is stuck on an await. SIGTERM, SIGINT and SIGHUP do the same at once; a second
  signal exits with 130.
- The close-out cancels every open order and closes every position reduce-only, each step bounded, up to 3
  attempts inside `--closeout` seconds (default 180), then re-reads the account. Flat: re-arm, exit 0. Not
  flat: the kill switch stays on, the status file says `done, NOT flat: run pnpm cli kill`, the summary is
  still written and the process exits 2. On a flat account it sends and journals nothing.
- A hard backstop in a worker thread fires at deadline + grace + close-out + 120 s even if the main thread
  is blocked: it appends a line to the status file and ends the process with SIGKILL (exit 137).
- Watcher: each socket sends a heartbeat request every 30 s; no frame for 90 s means stalled, the socket is
  dropped and re-dialled (and isStopped is re-read). A heartbeat line is logged every 10 minutes. Shutdown
  steps are bounded, SIGTERM is handled, and a backstop ends it 120 s after `--seconds`.

### 4 Nov evening: the box was paused (`fix/skew-tweaks-watchdog`)

The 4 Nov evening session (20:51 CET, 1 h) logged its cycle-5 probe at 21:03:31 CET and then nothing until the
operator's SIGTERM at 22:19:03 CET, 76 min later and 28 min past its 21:51 deadline. `watchdogFired: false`.
The watcher, a separate process, also went silent: its 30 s socket ticker logged a heartbeat at 21:01:30 CET and
its next tick ran at 22:18:28 CET, reporting `stalled: no frames for 4468s`. Two processes whose timers both
stopped for the same 75 minutes point at the box, not at an await: the machine was paused. Node timers run on
the process (monotonic) clock, which does not advance while the box is paused, while the wall clock does. So the
cycle wait, every per-call bound and the one-shot deadline timer were all still "not due" when the box resumed,
and SIGTERM came first. The 153.4 s "slow read" in the daily session (with a 70 s read bound that never fired)
fits a shorter pause too. Every loop await was already bounded; no unbounded call was found.

Fix:

- The session uses `deadlineWatchdog`: it ticks every 5 s and compares the wall clock with the deadline. The
  first tick after a pause past `deadline + --grace` stops the loop (`stopReason: deadline watchdog`) and the
  normal close-out runs (flat, re-arm, anchor, summary). The one-shot timer stays as a fallback.
- Stall check: no loop progress (a bounded call settled, a wait ended) for `--stall` seconds (default 900; never
  below 3 cycles, 3 RPC backoffs or 3 step bounds; `0` = off) ends the session the same way
  (`loop stalled: no progress for N s`). After a pause longer than that, the bot does not keep quoting on stale
  state.
- Live runs pass the process clock, so a wall-clock jump of 30 s or more is logged
  (`[watchdog] wall clock jumped N s ahead of the process clock (box paused?)`) and counted in the summary
  (`clockJumps`). The summary also has `watchdogReason`.
- The hard backstop is unchanged and still counts process time, so it does not SIGKILL on resume before the
  close-out had a chance.
- Each session now also writes `<out>.report.md` (a machine report from the summary, times in CET), so a daily
  routine always has a report file; `pnpm cli report <summary.json>` renders it again.

## Proof (Tokyo explorer)

Session journal `0x38e0c968…36c7` (23 receipts) anchored in
[0xacbc8acd…2f46](https://explorer.testnet.somnia.network/tokyo/tx/0xacbc8acd0f1576d1262c0110083cbdc801ddba9c7b9fe37508593fc211162f46),
[0x0651d2bd…2954](https://explorer.testnet.somnia.network/tokyo/tx/0x0651d2bd50004bcf481e05aa28a8503e3cfcc836bdbdc3716f4aaf7ad7e22954),
[0x9e58c535…842a](https://explorer.testnet.somnia.network/tokyo/tx/0x9e58c53505878233ecc94729e4f6274511d8b5b097f9d29fd82f258874bc842a).

Wrap-up journal `0x24b6acd2…7e50` (7 receipts) anchored in
[0x7636f284…5873](https://explorer.testnet.somnia.network/tokyo/tx/0x7636f28448f8b104beef07d34efa26431a4c1b46e9d64f82958b47818f0c5873).

Reduce-only close: [0x19a0ae1c…a875](https://explorer.testnet.somnia.network/tokyo/tx/0x19a0ae1c3ae86ed9719c7f9ba977d10de506e52fd7c39578001643af73d7a875).

Files: `docs/proof/session-live-2026-11-01/` (journals, HTML traces, logs, status and summary).
