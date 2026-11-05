# Session rules

Bot-side rules for the live session runner (`pnpm cli session`). They sit on top of the guard and can only
make a session **stricter**: pause quoting, skip a quote, end a session early, retry a close-out longer. They
never change the guard policy (`SESSION_POLICY`), the on-chain limits, the receipts contract or the kill switch,
and they never send an order the guard did not see. Testnet only, like the rest of the runner.

Rules are set in one JSON file, `session --rules <file.json>`. Every section and field is optional; anything
left out keeps the default below. Unknown keys are refused, so a typo cannot silently fall back to a default.
Example: [`docs/session-rules.example.json`](session-rules.example.json).

## 1. RPC health gate (`rpcGate`)

Why: on 2 Nov both testnet sessions ended early on one timed-out RPC read (`getPosition` 14:40 CET,
`getAccountState` 15:16 CET). PR #21 made one read retry across two RPCs; this rule decides what the session
does when reads stay slow or failing.

- A cycle read (gas, kill-switch check, snapshot) that fails with an infra error (timeout, socket, HTTP 5xx /
  429, "rpc") or takes longer than `slowReadSec` **pauses** quoting. Nothing new is asked for while the
  session cannot see the account, and resting quotes are pulled once (best effort cancels; a cancel only
  removes risk).
- While paused it re-reads with backoff: `backoffBaseSec`, doubling, capped at `backoffMaxSec`.
- It resumes after `healthyProbes` fast reads in a row.
- It ends the session (normal close-out, `session_aborted`, never an on-chain stop) when one outage lasts
  `maxOutageSec`, or all outages in the session add up to `maxTotalOutageSec`.
- Any other error (a bug, a bad answer) still ends the session at once, as before.
- At the start, a failing first read is retried the same way for up to `maxOutageSec`; after that the session
  refuses to start (`RPC not healthy at start ... not starting`).

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` = old behaviour: the first failed read ends the session |
| `slowReadSec` | `20` | a read slower than this counts as unhealthy |
| `backoffBaseSec` | `5` | first wait before a re-read |
| `backoffMaxSec` | `60` | longest wait between re-reads |
| `maxOutageSec` | `600` | end the session after one outage this long |
| `maxTotalOutageSec` | `1200` | end the session when outages add up to this |
| `healthyProbes` | `2` | fast reads in a row needed to resume quoting |
| `cancelOnPause` | `true` | pull resting quotes when a pause starts |

The session result and status file report `rpc: { pauses, outageSec, longestOutageSec, paused }`; the status
file shows `paused: RPC` while paused.

## 4. Close-out retry budget (`flatten`)

Why: on 2 Nov (run 2) the first close-out pass took 120 s and the 180 s close-out budget was used up, so no
retry ran and the run ended NOT flat; the make-up run timed out after 81 s with 2 positions open.

- The first close-out (`--closeout`, default 180 s, 3 attempts) is unchanged.
- If it ends NOT flat, a separate retry phase starts with its own, longer budget (`retryBudgetSec`). Each retry
  waits (`backoffBaseSec`, doubling, capped at `backoffMaxSec`), re-reads the account, and when it is not flat
  runs one more cancel-all + reduce-only pass bounded by `passTimeoutSec` (never beyond the budget left).
- It stops as soon as a read confirms flat, after `maxRetries`, or when the budget is spent; then the normal
  final check and report run (exit 2 and `pnpm cli kill` advice when still NOT flat).
- The retry path keeps the same kind as the first pass: `session_aborted` after an infra / time stop (never an
  on-chain stop), the kill switch only after a real guard trip.
- The CLI hard backstop includes `retryBudgetSec + passTimeoutSec`, so the process is not killed mid-retry.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` = old behaviour: NOT flat after the first budget is final |
| `retryBudgetSec` | `600` | total time for the retry phase |
| `backoffBaseSec` | `5` | first wait before a retry |
| `backoffMaxSec` | `60` | longest wait between retries |
| `passTimeoutSec` | `180` | bound for one retry pass (longer than the 120 s pass seen on 2 Nov) |
| `maxRetries` | `10` | retries in the retry phase |

The session result reports `closeOut.retries`.

## Threat-model notes

| Risk | Handling |
| --- | --- |
| Blind while paused: resting quotes fill, or the price moves, while the account cannot be read | quotes are pulled at the pause; the blind time is bounded by `maxOutageSec` / `maxTotalOutageSec`, then the normal close-out runs. The guard drawdown kill switch is unchanged and acts again on the first good read |
| A misclassified bug keeps a broken session alive | only network-shaped errors pause (timeouts, sockets, HTTP 5xx / 429, "rpc"); every pause still has the outage bound, so the worst case is a session that idles and then ends |
| A slow but working RPC serves stale data | a read over `slowReadSec` counts as unhealthy, so no quote is built on it; the guard's `MARK_STALE` check stays in force |
| Retrying the close-out sends more orders | only cancels and reduce-only orders, each through the guard as before; it stops on the first flat read, and is bounded by `maxRetries` and `retryBudgetSec` |
| A run lives longer than planned | worst case is `seconds + maxOutageSec (start) + grace + closeout + retryBudgetSec + passTimeoutSec`; the hard backstop uses exactly that |
| A rules file loosens a limit | it cannot: no field maps to a guard limit; the schema is strict and bounded |
