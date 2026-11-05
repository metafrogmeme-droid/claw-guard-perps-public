# 6h live block 2026-11-05 (Somnia Tokyo testnet, main) — skew session

After the 1h canary (see `docs/daily/2026-11-05.md`). Patrick go `t558u`. Testnet only (chain 50383). Bot
0x39791a9Df0bb96EBaEEaE2C6754bB76EbD09C67D, linked app wallet 0x3C9650bb62e913c33F662D6De2F4C0C5C617a898.
Session policy 0xc055…c945 (doctor shows live policy hash 0xe906…b976), guard limits unchanged. Repo head at
start: main a804a28 (incl. #35+#36). Start artifacts landed in #37 (`start-6h.txt`, `doctor-pre-6h.txt`,
`fund-pre-6h.txt`, close-routine spec).

Run: `session --live --hours 6 --cycle 120 --probe 5 --call-timeout 30 --grace 60 --closeout 180 --stall 900 --strategy skew`
(skew maker, post-only quotes). Watcher: `watch --react --policy session --seconds 21900`.

Session ended early: five wall-clock jumps (box paused; largest 1105 s), stall watchdog fired after 1117 s with no
progress, close-out flattened successfully. On-chain stop stayed OFF. Planned window was 17:00–23:00 CET; live
quoting stopped ~18:19 CET.

## Preflight 16:59 CET
- `doctor-pre-6h.txt`: on-chain stop OFF, 0 orders, 0 positions, equity 2000.166512 USDso, gas 4.434 STT, link place/cancel true.
- `fund-pre-6h.txt`: ready for a live run.
- `start-6h.txt`: start 17:00:14 CET, deadline 23:00:14 CET, strategy skew accepted.

## Session (started 17:00:14 CET, planned 6 h, ended 18:19:39 CET)
| | |
|---|---|
| Cycles | 15 |
| Allowed: within your limits | 18 (18 sent, 17 accepted by venue) |
| Blocked by your rule | 4 (probes / stale-mark / shape) |
| Needs your OK | 0 |
| Cancels | 6 in session counts (3 more in close-out; 9 cancel executions in the journal) |
| Receipts | 55 (chain check ok, head 0xf04dcb63…f5e3) |
| Peak equity | 2000.233740 USDso |
| P&L | +0.043054 USDso (2000.166512 → 2000.209566) |
| Gas | 4.433713 → 4.230550 STT (≈ 0.203 STT used) |
| Stop reason | loop stalled: no progress for 1117 s |
| Watchdog | fired (`watchdogFired = true`) |
| Clock jumps | 5, max 1105 s |
| RPC pauses / outage | 0 / 0 s |

## Rules that fired
- Intents tried: skew-maker post-only BTC-PERP / ETH-PERP long and short (requotes across cycles); scripted probes; close-out reduce-only IOC on BTC-PERP and ETH-PERP.
- Allowed: within your limits — 18 skew/close intents placed; 17 venueOk (one ETH short place at 17:29:10 CET returned ok=false with no tx).
- Blocked by your rule — 4 (nothing bad reached dreamDEX for those):
  - allowlist probe (DOGE-PERP): MARKET_NOT_ALLOWED, QTY_OFF_LOT, QTY_BELOW_MIN, PRICE_FAR_FROM_MARK, VENUE_MAX_SIZE
  - stale / unpriceable mark while quoting BTC
  - decimals / notional / position / leverage probe shape
  - further stale-mark / cap combination on BTC
- Needs your OK — 0.
- Loss cooldown: trades 3, losses 1, cooldowns 0. Profit rules: noEdge 0, droppedNotMaker 0, loss stop not hit.
- Stall watchdog: fired after the 1105 s clock jump; loop stalled 1117 s with no progress → end session.
- Deadline watchdog / hard backstop: not needed (session already closing well before 23:00 CET).

## Fills
- Maker resting quotes filled into a BTC-PERP short (position −14000 then −28000 = 0.00028 BTC). Book later flipped; at close-out the account held a BTC-PERP long 14000 (0.00014 BTC) and an ETH-PERP long 0.0047 ETH.
- Live `place` executions during quoting reported filled=0 (resting post-only); the only IOC fills in the journal are the two close-out reduces.
- Close-out reduce-only IOC filled BTC short-to-flat:
  https://explorer.testnet.somnia.network/tokyo/tx/0x811b755f06fbf887afee0a615126bf6d57e1d99563d5b7d7a46453b68058de0e
- Close-out reduce-only IOC filled ETH short-to-flat:
  https://explorer.testnet.somnia.network/tokyo/tx/0x4e4df14365e78cc75529af093d3d2f6e6ecbf629fbbfefabd539132f5dcca8db
- (Close-out intents are labeled `agent: kill-switch` / "reduce position" in the journal — that is the flatten path name, not an on-chain stop. `isStopped` stayed false.)

## Close-out
- 18:18:43 CET stall stop; 18:19:02 attempt 1: 3 open orders, 2 positions → cancel all + reduce-only close.
- Flat at 18:19:39 CET (attempts 2, passes 1, retries 0, open orders 0). Journal got `session_aborted` ("loop stalled… (close-out 1)"), not a kill-switch trip. On-chain stop stayed OFF.

## Anchor
18:20:06 CET by the runner: 7 batches, journal 0x27db352720545840cb35aa3a03580001462a150a48dc46dfb7723ed50eabd816, next seq 55.
- https://explorer.testnet.somnia.network/tokyo/tx/0x6872a031bb3e02daa61c5ce890de76cc4f8d9f95993a52de4674de48ff276610
- https://explorer.testnet.somnia.network/tokyo/tx/0x2ec8c4de82e227f7baf813ea02cf49a1bdbb11c83cb1f0ae57669e1511b41009
- https://explorer.testnet.somnia.network/tokyo/tx/0x638d96ad778b5e65dc2010ab9ab15cde3b6b3ed88123073e4da3232777d12048
- https://explorer.testnet.somnia.network/tokyo/tx/0xda7cb213cbaf018cae048e5618a2d09e4c8c5f55414c973ac8ffe89bc43866e6
- https://explorer.testnet.somnia.network/tokyo/tx/0xef78e91ce6d06759180da344afc94ccd25cad9ecc814931c37a3cbf47199b615
- https://explorer.testnet.somnia.network/tokyo/tx/0x2a31eaeb413335a9fe9503efd0dbbb4f373850f923dc7a870a905f1e6fcbe8ac
- https://explorer.testnet.somnia.network/tokyo/tx/0x2fcd659b3a57ab046df1cc5dd92b17292ea4a345f3aeb3dbbe1b011e4900b521

## Post check 19:04 CET (`doctor-post-6h.txt`)
On-chain stop OFF, 0 orders, 0 positions, equity 2000.209566 USDso (= session end), gas 4.231 STT, link place/cancel true. Funding still ready.

## Watcher
SIGTERM at 19:04 CET (session already done; past its useful window, well before the 21900 s budget): 61 pushes, 0 reactions. `isStopped` stayed false through the anchored batches. Watch log also saw two brief WS stalls (~982 s and ~158 s) and re-subscribed; no reaction path fired.

## Lesson
Same host-pause pattern as the morning canary: five clock jumps (max ~18 min) burned most of the planned 6h wall window, the stall watchdog from #35 stopped the loop, flatten filled both legs, journal anchored in 7 batches, on-chain stop stayed off. Treat session P&L (+0.04 USDso) as noise when pauses dominate live quoting time. For the remaining daily canaries through 15 Nov, keep the detached start + later wrap-up split, and expect short effective windows whenever the box sleeps. No guard-limit or policy change from this run.
