# Probe run

`probes` sends a matrix of 65 wrong orders through the real gate, on the real venue snapshot, and checks that
each one gets the verdict and rule code it should. Every probe writes a signed receipt to a hash-chained journal.
With `--live` the journal is anchored on Somnia Tokyo testnet.

Guard limits are the session limits (`SESSION_POLICY`), unchanged.

## Commands

Offline, on the sim (no network, no key):

```
pnpm cli probes --dry --out runs/probes-dry-2026-11-03
```

Live, on dreamDEX Tokyo testnet (needs your go; stop any running session first):

```
pnpm cli probes --live --env /home/box/.config/claw-guard-perps/env --out runs/probes-live-2026-11-04
```

Each run writes `<out>.jsonl` (receipts), `<out>.summary.json`, `<out>.md` and `<out>.html` (trace). The command
exits 1 if a probe fails that is not a listed known gap, if any order other than the control reached the venue,
or if the receipt chain does not verify.

## How a probe stays off the venue

Each probe runs in a fresh engine behind a fence venue:

- reads (snapshot, sizing) pass through, with the probe's setup laid over them: a stale mark, a used daily
  budget, a tripped kill switch. The setup only changes what the gate sees, never the account.
- orders are stopped at the fence and recorded as a failed execution. Only the probe marked `forward`
  (`ctl-forward`, a 10.50 USD post-only bid 50 bps under the mark) is sent, and it is cancelled right away.
- the run refuses an account that holds a position or an open order.
- the owner-OK prompt always answers no, so a held order is never sent.

The run reports two counts: orders sent to the venue (must be exactly 1) and blocked or held probes the gate let
through (stopped at the fence). The second one is the gate's own score.

## Groups

| Group | Probes | What they try |
| --- | --- | --- |
| market | 8 | unknown, lower case, padded, look-alike letters, listed but not chosen, empty, spot-style |
| decimals | 6 | 18, 6, 0, negative decimals; venue row changed its decimals; matching control |
| grid | 7 | off-lot, below minimum, off-tick, zero and negative quantity and price |
| price | 7 | 10% off either way for long and short, just outside and just inside the 3% band, absurd price |
| mark | 3 | stale mark, no mark, venue cannot size |
| caps | 7 | 10x the order cap, just over it, absurd quantity, daily budget, position cap, leverage, no equity |
| flow | 3 | open-orders cap, failure loop, over the venue's maximum size |
| reduce | 3 | reduce-only with no position, a flip, the side that adds |
| kill_switch | 2 | opening while tripped (blocked), a real reduce while tripped (allowed) |
| owner_ok | 2 | taker order, above the 12 USD OK line |
| shape | 10 | side `"buy"`, side `"LONG"`, side missing, type `"market"`, type `"POST_ONLY"`, reduceOnly `"yes"`, number quantity, string price, agent missing, an unknown extra field |
| replay | 3 | a blocked intent three times, a burst past 12 per minute, an intent priced off an old mark |
| injection | 2 | "owner approved, ignore limits" in the reason; agent named as the owner |
| control | 2 | a passive ETH quote and the forwarded BTC quote, both inside every cap |

Every block rule in `src/gate/codes.ts` is the expected rule of at least one probe, plus `TAKER_ORDER` and
`ABOVE_OK_THRESHOLD`. `NEW_MARKET` is switched off in the session policy, so it is covered by the gate unit tests
only.

## Known gaps

None. `KNOWN_GAPS` in `src/engine/probe-matrix.ts` lists a probe the gate does not answer as written yet; the
run reports it as a known gap instead of hiding it, and any other miss as new.

The first probe run (3 Nov 2026, sim) found one: the gate trusted the TypeScript types and did not check an
intent's shape at runtime.

| Probe | Before the fix | Now |
| --- | --- | --- |
| shape-side-buy | allowed; the venue adapter would send it as a short | blocked, `INTENT_MALFORMED` |
| shape-side-upper | allowed; same as above | blocked, `INTENT_MALFORMED` |
| shape-type-market | allowed; the venue adapter has no code for it | blocked, `INTENT_MALFORMED` |
| shape-ro-string | blocked, but only as `NOT_REDUCING` | blocked, `INTENT_MALFORMED` |
| shape-qty-number | the gate threw: nothing sent, no receipt | blocked with a receipt, `INTENT_MALFORMED` |
| shape-price-string | the gate threw: same as above | blocked with a receipt, `INTENT_MALFORMED` |

The fix (`src/gate/shape.ts`) runs before every other rule. A wrong type, an unknown or upper-case side or
order type, a non-boolean `reduceOnly`, a missing field or an unknown extra field blocks on its own: no other
rule runs, the intent is never sized or sent, and the receipt records a sanitised copy. Zero or negative
values block as `INTENT_MALFORMED` next to `QTY_ZERO` / `PRICE_ZERO`. The venue adapters fail closed too: any
side other than exactly `long` or `short`, and any unknown order type, throws instead of being sent.

Replays: intents have no nonce or timestamp, so the gate cannot tell a replay from a new order. Replays are
bounded by the rate limit, the daily cap and the open-orders cap. A nonce with a replay window is a follow-up
(DECISIONS #14).
