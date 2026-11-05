# Repeat-use loop: the daily guard report (design notes)

Status: proposal, not built.

## The loop

1. The bot trades through the guard all day.
2. At the end of the day the owner gets a short report that answers one question: what did my rules do for me today?
3. The report has a share card with a public check link. Traders post it the way they post a PnL card, except this one shows discipline: "the bot proposed 212 orders, my rules blocked 9, 3 waited for my OK".
4. The next morning the owner tightens or loosens a rule based on the report, and the cycle repeats. Each report links to the last one, so the streak is what brings them back.

## What the report shows

The report is built only from the day's signed receipt journals, so nothing in it is typed by hand:

| Section | Source |
| --- | --- |
| Allowed / Blocked / Needs your OK counts | `decision` receipts |
| Top rules that fired, in plain words ("Blocked by your rule: ORDER_NOTIONAL_CAP" ×4) | `codes` on blocked decisions |
| Orders sent, fills, cancels, with explorer links | `execution` receipts and tx hashes |
| Realized PnL and end equity (equity + locked collateral) | the session summary |
| Kill switch trips and re-arms, with the reason and the tx | `kill` receipts and `Stopped` / `Rearmed` events |
| Streak: days in a row ending flat with no kill switch trip | the previous reports |
| Proof line: journal heads, the anchor tx and the policy hash | the `Anchored` events on ClawGuardReceipts |

No token or price picks, no performance claims beyond the day's numbers, and only the three verdict phrasings (copy-lint already enforces this).

## Share card

- 1200×630 PNG and an HTML page: the counts, the top three rules, the PnL line, the streak and a QR code for the check link.
- The check link opens the HTML trace we already render (`runs/*.html`). It runs `verify` on the journal in the browser and compares its head with the anchored one on Somnia.
- Privacy: the owner chooses whether the account address shows in full or shortened. Sizes can be shown as a percent of the cap instead of USD.

## How it is built

- `pnpm cli report --day YYYY-MM-DD [--share]`: reads `runs/*.jsonl` for that day, verifies each one, reads the `Anchored` events for those journal ids over RPC, and writes `report-<day>.{md,html,png}`.
- A routine (cron or the watcher process) runs it at 00:05 local time and sends it to the owner's chosen channel. Sending is opt-in and off by default.
- About 250 lines plus tests. It reuses `verify`, the trace renderer and `readStopped`, and needs no new contracts.

## Why judges should care

- **Repeat use:** a daily artifact that changes with the owner's own rules, plus a streak.
- **Viral:** the share card is verifiable, so posting it is a credible flex and brings more builders to dreamDEX.
- **Product:** the report turns the guard from insurance you forget into something you look at every day.
