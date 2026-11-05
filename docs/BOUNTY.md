# dreamDEX Perps Builder Bounty: rules we build against

Source: the DoraHacks page <https://dorahacks.io/hackathon/dreamdex-perps-bounty/detail>, read on
1 Nov 2026 18:20 CET, plus the dreamDEX X post of 30 Oct 2026 ("We've extended the submission deadline
to November 15!"). Re-check the page before submitting; organisers can change it.

## Deadline

| | UTC | CET (Amsterdam) |
|---|---|---|
| Opened | 19 Oct 2026 12:00 | 19 Oct 2026 14:00 (CEST) |
| Original close (page text, superseded) | 1 Nov 2026 23:59 | 2 Nov 2026 00:59 |
| **Submissions close (extended)** | **15 Nov 2026 14:30** | **15 Nov 2026 15:30** |
| Results | "by November 8" in the page text, written before the extension; expect later | |

The page header shows "Extended 2026/11/15 14:30" and the page data has `timelineEnd = 1794753000`
(15 Nov 2026 14:30:00 UTC) and `isExtended = true`. The body text still shows the old 1 Nov timeline.

Our target: everything submitted by **Sat 14 Nov 2026**, a day early.

## Tracks and prizes

- **Feedback track, up to $1,500 total.** $40 per accepted critical or major item, $15 per other accepted
  item. Paid only if they can reproduce it; only the first valid report of an issue is paid; payouts stop
  when the $1,500 budget is used.
- **MVP track, 3 x $500.** $300 when winners are announced, $200 after the perps mainnet launch if the MVP
  places orders on mainnet within 30 days of that launch. Each winner gets a technical breakdown post on the
  dreamDEX X account.

You can enter one or both tracks.

## Whitelist (required to submit a Build)

Registration is open to everyone, but only whitelisted emails can submit Builds.

- Builders from the dreamDEX Event Contracts hackathon who placed orders on chain are already whitelisted.
- Everyone else: open a ticket in the dreamDEX Discord (<https://discord.gg/dreamdex>), or message the
  SomniaHacks Telegram group, **with the email used on DoraHacks**. They add it to the whitelist.

The draft ticket is kept outside the repo, because it holds the owner's email and DoraHacks username. It is a draft only, and the owner sends it.

## What a submission must contain

Every Build needs a GitHub repository (visible to the judges).

Feedback track:

- One Markdown file per issue in a `feedback/` folder, in this template: title, `Severity: critical | major
  | normal`, `Area: API | SDK | docs | app | contracts`, Steps to reproduce, Expected, Actual, Evidence
  (transaction hash, request and response, screenshots), Environment (SDK version, network, wallet address).
- Security vulnerabilities go privately to security@dreamdex.io, **never** into the repo.

MVP track:

- The MVP places **real perps orders on Somnia Tokyo testnet**.
- The README explains **what it does, who it is for and how to run it**.
- The README has an **"X posts" section** with links to **2 or 3 posts** about the MVP that **tag
  @DreamDEXSomnia**.
- Categories: bots and agents, trader tools, consumer perps.
- **Plus:** using Somnia primitives such as **Reactivity** or **Somnia Agents**.

## Judging criteria

Feedback: severity, clarity, reproducibility, and how useful the item is for the perps product and the
developer experience.

MVP:

1. **MVP potential:** clear user value, credible scope, a viral or repeat-use loop, technical execution.
2. **Evidence of building:** live orders on Somnia Tokyo testnet, transaction hashes, repo and demo.
3. **Communication:** quality and accuracy of the X posts.

## Testnet funds

Trade with the Perps Arena balance (paper USDso every week, app.testnet.dreamdex.io). Extra USDso is only
given on request in Discord, only to a bounty account that is **not** in the Perps Arena, and those wallets
are monitored. **Moving bounty USDso into a Perps Arena account is not allowed.** We trade only the owner's
Perps Arena balance through a linked bot key, and never request or move extra USDso.

## How Claw Guard Perps maps to the criteria

| Criterion | Where |
|---|---|
| Real perps orders on Tokyo testnet | [`docs/PROOF.md`](PROOF.md): placed, cancelled and filled orders with tx hashes |
| README what / who / how to run | [`README.md`](../README.md) |
| X posts section, 2 to 3 posts tagging @DreamDEXSomnia | README "X posts" (links added after the owner approves and posts them) |
| Reactivity plus | [`docs/REACTIVITY.md`](REACTIVITY.md) (PR #13): on-chain stop pushed by `somnia_watch`, cancel, `PositionUpdated` checks |
| Technical execution | strict CI (format, lint, types, coverage gate, copy-lint, gitleaks full history, audit, Semgrep), [`docs/THREAT_MODEL.md`](THREAT_MODEL.md) |
| Feedback track | [`feedback/`](../feedback/), summary in [`docs/FEEDBACK_REPORT.md`](FEEDBACK_REPORT.md) |
| Repeat-use loop | [`docs/REPEAT_USE.md`](REPEAT_USE.md) (design) |
| Mainnet within 30 days | [`docs/MAINNET_READINESS.md`](MAINNET_READINESS.md) (plan) |
| Demo | video, linked in the DoraHacks submission |
