# Decisions

| # | Decision | Why |
| --- | --- | --- |
| 1 | Three verdicts only: Allowed / Blocked by your rule / Needs your OK | one wording everywhere; codes explain the reason |
| 2 | Unknown facts block (no mark, stale mark, venue cannot price) | a missing fact is never a pass |
| 3 | Every rule that fires is reported, not just the first | the owner sees all problems with one order at once |
| 4 | Receipts are EIP-191 signed JSONL with a hash chain; anchoring is optional and batched | cheap to write, checkable off-chain, provable on-chain |
| 5 | The contract enforces order (seq, prevHash, journal id) and exposes `isStopped` | other contracts and keepers can read a stop without trusting our server |
| 6 | Linked bot key (placeOrderFor) is the target mode; own-account mode for development | the key cannot withdraw the owner's margin |
| 7 | Writes are simulated before sending; the voucher claim is simulated before it is offered | a revert costs no gas and names the error |
| 8 | Testnet only; mainnet chain ids are refused in code | bounty scope |
| 9 | Pure core (gate, receipts, kill switch, engine) with the network behind a `Venue` interface | tests run with no network; the sim venue drives the same engine |
| 10 | Somnia Reactivity through `somnia_watch` (off-chain), not a Solidity handler | the reaction must sign venue transactions with the bot key; the event and `isStopped` arrive from the same block; no 32 STT subscription deposit (details in REACTIVITY.md) |
| 11 | On a stop push the kill switch re-reads the account before cancelling | correctness first (it also cancels orders it did not place); cost: about 16 s from push to cancel on testnet. Next: cancel tracked orders first, then re-read |
| 12 | Somnia Agents: not integrated yet | the Agents platform (`0x037B…6776`) is deployed on Somnia testnet 50312 and mainnet 5031, not on Tokyo 50383 where dreamDEX perps run (`eth_getCode` on Tokyo returns `0x`, checked 1 Nov 2026). A guard cannot wait on a callback from another chain. Plan: when Agents reach Tokyo (or perps reach 50312/5031), add an optional "second opinion" rule: the gate sends a `Needs your OK` intent to the LLM Inference agent (`inferString` with allowed values `allowed`/`needs_ok`) and records the consensus result in the receipt. It can only tighten a verdict, never loosen one |
| 13 | The gate checks the intent's shape at runtime first (`INTENT_MALFORMED`) and the venue adapters fail closed on side and order type | the probe run (3 Nov 2026) showed the gate trusted the TypeScript types: side `"buy"` was allowed and the adapter sent anything but `"long"` as a short; a number quantity made the gate throw with no receipt. Now a wrong type, unknown or upper-case enum, non-boolean `reduceOnly`, missing or extra field blocks alone, before any other rule; zero or negative values block next to `QTY_ZERO`/`PRICE_ZERO`. A malformed intent is never sized or sent, and its receipt holds a sanitised copy. The adapters throw on any side other than exactly `long`/`short` |
| 14 | Replay protection (a nonce or timestamp per intent with a replay window) is a follow-up, not in this fix | it needs a nonce in every intent, the strategies to set it, and gate memory for seen nonces across restarts. Until then a replay is a new order, bounded by the rate limit, daily cap and open-orders cap, and each copy has its own receipt |
