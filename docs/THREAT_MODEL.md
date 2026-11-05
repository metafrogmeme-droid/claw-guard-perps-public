# Threat model

Claw Guard sits between an agent that proposes orders and the key that signs them. The agent is untrusted: it may be
wrong, buggy, prompt-injected or looping.

| Threat | Control |
| --- | --- |
| Agent trades a market the owner never chose | market allowlist (`MARKET_NOT_ALLOWED`), owner OK on first order per market |
| Unit mistakes (18 decimals instead of 8, wrong tick) | pinned base decimals, `DECIMALS_MISMATCH`, `MARKET_DECIMALS_CHANGED`, tick/lot/min checks |
| Fat-finger price or size | `PRICE_FAR_FROM_MARK`, per-order, daily and position notional caps, leverage cap, venue max size |
| Acting on stale or missing prices | `MARK_UNKNOWN`, `MARK_STALE`, `VENUE_UNPRICEABLE`: unknown blocks, it never passes |
| Order spam or a retry loop | orders-per-minute limit, open-orders cap, `FAILURE_LOOP` after N venue rejects |
| Agent says "reduce" but adds | `NOT_REDUCING` checks the real position |
| Drawdown spiral | kill switch on drawdown from peak: cancel, reduce, block until re-armed by the owner |
| Agent edits its own history | receipts are signed and hash-chained; the contract refuses gaps, forks, replays and reorders |
| Key leak | bot key is a testnet linked key: it can place and cancel for the owner but cannot withdraw. Keys live in an env file outside the repo (chmod 600); gitleaks scans every PR, every push to main and the full history |
| Wrong network | the network module refuses any chain id except Tokyo testnet 50383 |

Out of scope: a compromised machine that holds the bot key (it can bypass the gate), venue-side bugs, and oracle
manipulation beyond the mark-deviation check.

## Reactivity watcher (`watch --react`)

| Threat | Effect | Handling |
| --- | --- | --- |
| Socket drops, pushes missed | a stop lands while the watcher is deaf | reconnect with backoff; on every (re)subscribe, re-read `isStopped` over RPC and react to the state, not only to events |
| Node sends a forged or wrong push | a needless kill | a push can only trip the kill switch (cancel, reduce, block); it can never loosen a verdict or send an opening order |
| Push for another signer or account | a wrong reaction | the node filters on topic1, and the watcher re-checks the decoded signer/account before reacting |
| Watcher and trader send at the same time | a nonce race, one tx fails | a failed venue call is a receipt and counts toward the failure-loop rule; the kill switch re-reads the account before cancelling |
| Stop key leaked | anyone with it can stop the bot | a stop only removes risk; re-arming also needs the key, so treat it like the gate key |

## Session rules (`session --rules`)

Bot-side rules (RPC health gate, close-out retry budget, profit rules, loss cooldown) can only pause, skip or end;
they never change a guard limit. Risks and handling per rule: [SESSION_RULES.md](SESSION_RULES.md#threat-model-notes).

## Probe run (`probes`)

The probe run sends 65 deliberately wrong orders through the real gate to show, with receipts, that each rule
holds. Details and the full list: [PROBES.md](PROBES.md).

| Threat | Effect | Handling |
| --- | --- | --- |
| A probe gets past the gate | a wrong order reaches dreamDEX | every probe goes through a fence venue; only the one control quote (`ctl-forward`) is ever sent, and the run fails if the venue count is anything else |
| Untyped agent output (JSON) with a bad shape | a side like `"buy"` sent as a short; a number quantity makes the gate throw | found by this run, fixed: `INTENT_MALFORMED` is checked first, blocks with a receipt and never throws; a malformed intent is never sized or sent; the venue adapters also refuse any side other than exactly `long`/`short` and any unknown order type ([DECISIONS](DECISIONS.md) #13) |
| Replayed intent | the same order sent again | intents carry no nonce, so a replay is a new order: bounded by the rate limit, daily cap and open-orders cap, and logged as its own receipt. A nonce with a replay window is a follow-up ([DECISIONS](DECISIONS.md) #14) |
| Text in `reason` or `agent` that claims owner approval | the gate is talked out of a limit | the gate never reads either field; probes `inject-reason` and `inject-agent` show it |
| The control quote fills | a small leftover position | the run cancels the control at once; if a position is left it closes it reduce-only and writes a `session_aborted` receipt |
| Probe run on a busy account | cancels or close-outs touch a live session | the run refuses an account with any position or open order |
