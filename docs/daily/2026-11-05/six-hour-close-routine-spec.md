# One-shot: Perps 6h close check (parent must create via UpdateRoutine)

Subagent cannot create routines. Parent: create this, then delete the old "Perps 6h block after canary" routine (missed 16:15 window; session already started manually).

## UpdateRoutine fields

- **action**: create (or upsert by name)
- **name**: `Perps 6h close check`
- **timing**: `exact`
- **schedule**: `10 23 5 11 *`  
  (Europe/Amsterdam local: **2026-11-05 23:10 CET** — ~6h after actual start 17:00:14 CET + closeout buffer. One calendar fire only; prompt deletes the routine after.)
- **trigger**: omit (cron schedule only)
- **prompt**: (full text below)

### Prompt text (copy verbatim)

```
One-shot wrap-up for today's Claw Guard Perps 6h live block. Testnet only (Somnia Tokyo chain 50383). Repo /workspace/claw-guard-perps (PRIVATE). Bot 0x39791a9Df0bb96EBaEEaE2C6754bB76EbD09C67D. Never mainnet. Never kill -9. Never touch /workspace/repo001. Never change guard limits or SESSION_POLICY. Never print secrets from ~/.config/claw-guard-perps/env.

Context (from start):
- Started 2026-11-05 17:00:14 CET / 2026-11-05T16:00:14.278Z
- Deadline 2026-11-05 23:00:14 CET / 2026-11-05T22:00:14.000Z
- Out: runs/session-6h-2026-11-05.* and runs/session-6h-watch-2026-11-05.*
- Flags: session --live --hours 6 --strategy skew --cycle 120 --probe 5 --call-timeout 30 --grace 60 --closeout 180 --stall 900
- Watcher: --react --policy session --seconds 21900
- Preflight: docs/daily/2026-11-05/doctor-pre-6h.txt + fund-pre-6h.txt; start record docs/daily/2026-11-05/start-6h.txt
- Repo was on main a804a28 at start (after #35+#36). Pull with private GIT_ASKPASS helper from claw-guard-perps-RESUME.md; delete helper after. Do not merge any docs PR.

Do this:
1. Wait for runs/session-6h-2026-11-05.status.json to show state "done, flat" (or equivalent done+flat). Poll gently. Hard backstop latest alive ≈ deadline + grace(60s) + closeout(180s) + 120s anchoring. Only SIGTERM the session node PID if still alive more than 10 minutes past deadline+grace+closeout; never kill -9 first. If status is "done, NOT flat" or exit implies not flat, run `pnpm cli kill --env ~/.config/claw-guard-perps/env --out runs/session-6h-2026-11-05-wrapup.jsonl` then doctor; do NOT anchor a kill journal unless Patrick asks (anchored kill turns on-chain stop on).
2. After flat: run doctor → docs/daily/2026-11-05/doctor-post-6h.txt. Confirm isStopped=false, 0 orders, 0 positions. Note gas used vs start (4.43371257 STT).
3. Confirm journal anchored (status/summary or runner log has anchor txs). Record explorer links for Somnia Tokyo.
4. SIGTERM the watcher if still running past its --seconds window (same as canary wrap-up).
5. Write docs/daily/2026-11-05/six-hour-report.md with: counts (Allowed / Blocked / Needs your OK / sent / venueOk / cancels / cycles), P&L (start→end equity), gas used, fills, close-out path, anchor txs, watchdogReason / clockJumps / stall / host pause if any, honest lesson. Mirror a short copy into docs/daily/2026-11-05.md section or sibling note only if that fits the existing daily doc style without rewriting the canary section falsely.
6. Open a DRAFT docs PR the same way as the daily wrap-up (worktree off main, branch like docs/daily-2026-11-05-6h, commit the new report + doctor-post-6h + start-6h artifacts that belong in docs; gitleaks clean). Do NOT merge.
7. Tell Patrick the short result in this chat (start/deadline CET, flat?, counts, P&L, gas, watchdog if any, draft PR link). Destination: the user (Patrick / HUMANOID-TRADERS) in this Grok Bot chat. If there is nothing new beyond "still running past expected close", say that once and still delete this routine only after the session is actually done or you had to force-stop past the grace window.
8. Delete this routine itself when finished (one-shot).

If the session is still healthy and before deadline when this somehow fires early, wait until deadline+buffer rather than stopping it.
```

## Also for parent

- **Delete** routine named like `Perps 6h block after canary` / `perps-6h-block-after-canary` (already missed; session started manually at 17:00 CET on Patrick "Go" t558u).
- Do not create a second 6h start.

## Start confirmation snapshot (for parent message to Patrick)

- Start: 2026-11-05 17:00:14 CET
- Deadline: 2026-11-05 23:00:14 CET
- Gas at start: 4.43371257 STT
- Equity: 2000.166512 USDso
- Session node PID: 3733415 (pnpm 3733341)
- Watcher node PID: 3733874 (pnpm 3733844; restarted once after empty --seconds bug)
- Artifacts: docs/daily/2026-11-05/start-6h.txt, doctor-pre-6h.txt, fund-pre-6h.txt
- Status at confirm: running (cycle 1, 4 sent / 4 venue ok)
