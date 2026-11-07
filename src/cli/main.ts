#!/usr/bin/env node
// claw-guard CLI. Somnia Tokyo testnet only.
//   doctor               network, gas, margin, link status, policy markets
//   demo --sim | --live  scripted agent + band maker through the gate, receipts + trace
//   verify <journal>     check the hash chain and signatures
//   trace <journal>      write the HTML trace
//   deploy-receipts      deploy ClawGuardReceipts (run `forge build` in contracts/ first)
//   anchor <journal> --address 0x..  anchor a journal's receipts on-chain
//   fund [--yes]         funding check: gas, margin, voucher; --yes claims the voucher when a claim would pass
//   fill --sim | --live [--yes] [--market M]  one minimal taker order (Needs your OK), then a reduce-only close
//   rest --sim | --live [--market M]  one resting post-only bid (Allowed), for the Reactivity demo
//   session --sim | --live [--hours H] [--cycle S] [--probe N] [--call-timeout S] [--grace S] [--closeout S]
//                        [--rules file.json] (session rules: docs/SESSION_RULES.md)
//                        long run under the session policy; every call time-bounded, a deadline watchdog and
//                        SIGTERM/SIGINT run the close-out; exit 0 only when it ends confirmed flat (2 = NOT flat)
//                        [--strategy band|skew] [--skew-config f.json] (docs/STRATEGY_RULES.md)
//                        [--stall S] watchdog closes out after S s without loop progress (default 900, 0 = off)
//                        writes <out>.summary.json and a machine report <out>.report.md
//   report <summary.json> [--out f.md]  render the machine session report from a saved summary
//   kill [--reason r]    trip the kill switch now: cancel resting orders, reduce positions (live).
//                        Exit 2 when a fresh read does not confirm the account is flat.
//   stop [--reason r]    remote stop: anchor a signed kill-switch receipt on-chain (no venue access)
//   rearm <stop-journal> anchor a re-arm receipt on the same journal
//   probes --dry | --live  the probe matrix (docs/PROBES.md): 65 wrong orders through the real gate, a fence
//                        that lets only the one control quote reach the venue, a signed receipt per probe,
//                        markdown + JSON summary; --live also anchors the journal on Tokyo testnet
//   watch [--react] [--seconds N]  Somnia Reactivity (somnia_watch) on ClawGuardReceipts; --react trips the
//                        local kill switch the moment an on-chain stop lands for this signer. Heartbeat and stall
//                        detector on each socket; ends on time even if a call hangs (hard stop at N + 120 s)
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { DEMO_POLICY, parsePolicy, policyHash, SESSION_POLICY, type Policy } from '../gate/policy.js';
import { formatDecimal, usd } from '../gate/units.js';
import { Engine, type Approver } from '../engine/engine.js';
import { Journal, readJournal } from '../receipts/journal.js';
import { anchorJournal, deployReceipts, readStopped } from '../receipts/anchor-viem.js';
import { StopWatcher, type StopCause, type WatchEvent } from '../reactivity/watch.js';
import { WsReactivityTransport } from '../reactivity/ws.js';
import { PositionGuard } from '../reactivity/positions.js';
import { verifyChain } from '../receipts/receipt.js';
import { renderTrace } from '../trace/html.js';
import { DreamdexVenue } from '../venue/dreamdex.js';
import { resolveNetwork, TOKYO_RECEIPTS, TOKYO_TESTNET, txUrl } from '../venue/network.js';
import { SimVenue } from '../venue/sim.js';
import { simMarkets } from '../venue/sim-markets.js';
import { fundingPlan } from '../venue/funding.js';
import type { Venue } from '../venue/types.js';
import { runDemo } from './demo.js';
import { runFill } from './fill.js';
import { runRest } from './rest.js';
import { DEFAULT_RUNTIME_RULES, parseRuntimeRules } from './rules.js';
import { renderSessionReport } from './report.js';
import { runSession } from './session.js';
import { probeMarkdown, runProbes } from '../engine/probes.js';
import { parseSkewConfig } from '../engine/profit-rules.js';
import { DEFAULT_STRATEGY_RULES, parseStrategyRules } from '../engine/strategy-rules.js';
import { hardBackstop } from '../runtime/watchdog.js';
import { timedVenue, withTimeout } from '../runtime/timeout.js';
import { loadEnv, ownerFrom, privateKeyFrom } from './env.js';
import { killAccountLine, killStopLine, stoppedMessage } from './stop.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    sim: { type: 'boolean' },
    dry: { type: 'boolean' },
    live: { type: 'boolean' },
    policy: { type: 'string' },
    env: { type: 'string' },
    out: { type: 'string' },
    cycles: { type: 'string' },
    market: { type: 'string' },
    reason: { type: 'string' },
    address: { type: 'string' },
    yes: { type: 'boolean' },
    react: { type: 'boolean' },
    seconds: { type: 'string' },
    hours: { type: 'string' },
    cycle: { type: 'string' },
    probe: { type: 'string' },
    strategy: { type: 'string' },
    'skew-config': { type: 'string' },
    'call-timeout': { type: 'string' },
    grace: { type: 'string' },
    closeout: { type: 'string' },
    rules: { type: 'string' },
    stall: { type: 'string' },
  },
});
const cmd = positionals[0] ?? 'help';
const log = (s: string): void => {
  process.stdout.write(`${s}\n`);
};
const nowSec = (): number => Math.floor(Date.now() / 1000);

async function loadPolicy(): Promise<Policy> {
  if (values.policy === undefined)
    return parsePolicy(cmd === 'session' || cmd === 'probes' ? SESSION_POLICY : DEMO_POLICY);
  if (values.policy === 'session') return parsePolicy(SESSION_POLICY);
  if (values.policy === 'demo') return parsePolicy(DEMO_POLICY);
  return parsePolicy(JSON.parse(await readFile(values.policy, 'utf8')));
}

/** Bound for one-off network steps in the CLI (connect, stop flag read, anchoring), in ms. */
const STEP_MS = 60_000;

async function liveVenue(): Promise<DreamdexVenue> {
  const env = loadEnv(values.env);
  const owner = ownerFrom(env);
  return withTimeout(
    DreamdexVenue.create({
      privateKey: privateKeyFrom(env),
      network: resolveNetwork(env),
      now: nowSec,
      ...(owner === undefined ? {} : { owner }),
    }),
    STEP_MS,
    'connect to the venue',
  );
}

const reportName = (path: string): string => (path.split('/').pop() ?? path).replace(/\.summary\.json$/, '');

/** Writes `<base>.report.md`; a failure is logged, never fatal (the summary is already on disk). */
async function writeSessionReport(base: string, summary: unknown): Promise<void> {
  try {
    await writeFile(`${base}.report.md`, renderSessionReport(summary, { name: reportName(base) }));
    log(`${iso()} report written to ${base}.report.md`);
  } catch (e) {
    log(`${iso()} report not written: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const ttyApprover: Approver = async (intent, decision) => {
  if (values.yes === true) return true;
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(
    `${decision.message} for ${intent.agent} ${intent.side} ${intent.market}. OK? [y/N] `,
  );
  rl.close();
  return a.trim().toLowerCase() === 'y';
};

function receiptsAddress(env: Readonly<Record<string, string | undefined>>): `0x${string}` {
  const a = values.address ?? env['RECEIPTS_ADDRESS'] ?? TOKYO_RECEIPTS;
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`receipts address ${a} is not an address`);
  return a as `0x${string}`;
}

async function onChainStop(): Promise<{ signer: `0x${string}`; stopped: boolean }> {
  const env = loadEnv(values.env);
  const signer = privateKeyToAccount(privateKeyFrom(env)).address;
  const stopped = await withTimeout(
    readStopped(resolveNetwork(env), receiptsAddress(env), signer),
    STEP_MS,
    'read the on-chain stop',
  );
  return { signer, stopped };
}

/** Live trading (and doctor) refuses while this signer's on-chain stop is on. */
async function assertNotStopped(): Promise<void> {
  const { signer, stopped } = await onChainStop();
  if (stopped) throw new Error(stoppedMessage(signer, values.env));
}

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');
const iso = (): string => new Date().toISOString();

function describe(ev: WatchEvent): string {
  const extra =
    ev.name === 'Anchored' ? ` verdict ${String(ev.verdict)} receipt ${String(ev.receiptHash)}` : '';
  const flag = ev.stoppedAfter === undefined ? '' : ` | isStopped after = ${String(ev.stoppedAfter)}`;
  return `${ev.name} journal ${ev.journal} seq ${ev.seq.toString()}${extra}${flag}`;
}

async function writeTrace(journalPath: string, outPath: string, explorer: string | undefined): Promise<void> {
  const receipts = await readJournal(journalPath);
  const check = await verifyChain(receipts);
  const dec = Object.fromEntries(simMarkets(0).map((m) => [m.market, m.baseDecimals]));
  await writeFile(
    outPath,
    renderTrace(receipts, check, {
      title: `Claw Guard Perps trace: ${journalPath}`,
      baseDecimals: dec,
      ...(explorer === undefined ? {} : { explorerTx: explorer }),
    }),
  );
  log(`trace written to ${outPath}`);
}

async function main(): Promise<void> {
  switch (cmd) {
    case 'doctor': {
      const policy = await loadPolicy();
      // preflight: the on-chain stop must be off before a live run
      const st = await onChainStop();
      log(`on-chain stop (isStopped ${st.signer}) = ${String(st.stopped)}`);
      if (st.stopped) throw new Error(stoppedMessage(st.signer, values.env));
      const v = await liveVenue();
      try {
        log(`network Tokyo testnet (chain ${String(TOKYO_TESTNET.chainId)}), mode ${v.mode}`);
        log(`account ${v.account}, sender ${v.sender}`);
        log(`gas balance ${formatDecimal(await v.gasBalance(), 18)} STT`);
        const s = await v.snapshot(policy.markets);
        log(
          `margin equity ${formatDecimal(s.account.equity, 18)} USDso, open orders ${String(s.orders.length)}, positions ${String(Object.values(s.account.positions).filter((p) => p !== 0n).length)}`,
        );
        for (const m of Object.values(s.markets)) {
          const age = nowSec() - m.markUpdatedAt;
          let link = '';
          if (v.mode === 'linked-bot-key') {
            const l = await v.linkStatus(m);
            link = `, link place=${String(l.place)} cancel=${String(l.cancel)}`;
          }
          log(
            `  ${m.market}: mark ${formatDecimal(m.markPrice, 18)} (${String(age)}s old), imf ${String(m.initialMarginBps)} bps${link}`,
          );
        }
        log(`policy ${policyHash(policy)}`);
        const plan = fundingPlan(await v.fundingFacts());
        log(plan.ready ? 'funding: ready for a live run' : 'funding: not ready');
        for (const st of plan.steps) log(`  ${st.code}: ${st.text}`);
      } finally {
        await v.close();
      }
      return;
    }
    case 'demo': {
      if (values.live === true) await assertNotStopped();
      if (values.sim === values.live) throw new Error('pick one: demo --sim or demo --live');
      const policy = await loadPolicy();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const base = values.out ?? `runs/${values.sim === true ? 'sim' : 'live'}-${stamp}`;
      let venue: Venue;
      let sim: SimVenue | undefined;
      let clock = nowSec();
      let signerKey: `0x${string}`;
      if (values.sim === true) {
        sim = new SimVenue(simMarkets(clock), { collateral: usd('40'), now: () => clock, seed: 7 });
        venue = sim;
        signerKey = generatePrivateKey();
      } else {
        venue = await liveVenue();
        signerKey = privateKeyFrom(loadEnv(values.env));
      }
      try {
        const r = await runDemo({
          venue,
          policy,
          journalPath: `${base}.jsonl`,
          signer: privateKeyToAccount(signerKey),
          now: () => (sim === undefined ? nowSec() : clock),
          wait: (sec) => {
            if (sim !== undefined) {
              clock += sec;
              return Promise.resolve();
            }
            return new Promise((res) => setTimeout(res, sec * 1000));
          },
          log,
          approve: sim === undefined ? ttyApprover : (intent) => Promise.resolve(intent.agent === 'operator'),
          ...(sim === undefined ? {} : { sim }),
          cycles: Number(values.cycles ?? (sim === undefined ? '1' : '4')),
          showcaseMarket: values.market ?? 'BTC-PERP',
          quoteNotional: usd('10.5'),
        });
        log(`scripted agent: ${String(r.scriptMatches)}/${String(r.scriptTotal)} verdicts as written`);
      } finally {
        await venue.close();
      }
      await writeTrace(
        `${base}.jsonl`,
        `${base}.html`,
        sim === undefined ? TOKYO_TESTNET.explorerTx : undefined,
      );
      return;
    }
    case 'fill': {
      if (values.live === true) await assertNotStopped();
      if (values.sim === values.live) throw new Error('pick one: fill --sim or fill --live');
      const policy = await loadPolicy();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const base = values.out ?? `runs/fill-${values.sim === true ? 'sim' : 'live'}-${stamp}`;
      const clock = nowSec();
      const venue: Venue =
        values.sim === true
          ? new SimVenue(simMarkets(clock), { collateral: usd('40'), now: () => clock, seed: 7 })
          : await liveVenue();
      const signerKey = values.sim === true ? generatePrivateKey() : privateKeyFrom(loadEnv(values.env));
      try {
        const r = await runFill({
          venue,
          policy,
          journalPath: `${base}.jsonl`,
          signer: privateKeyToAccount(signerKey),
          now: values.sim === true ? () => clock : nowSec,
          log,
          approve: ttyApprover,
          market: values.market ?? 'BTC-PERP',
          notional: usd('10.5'),
        });
        process.exitCode = r.flat && r.check.ok ? 0 : 1;
      } finally {
        await venue.close();
      }
      await writeTrace(
        `${base}.jsonl`,
        `${base}.html`,
        values.sim === true ? undefined : TOKYO_TESTNET.explorerTx,
      );
      return;
    }
    case 'verify': {
      const path = positionals[1];
      if (path === undefined) throw new Error('usage: verify <journal.jsonl>');
      const r = await verifyChain(await readJournal(path));
      log(r.ok ? `OK: ${String(r.count)} receipts, head ${r.head}` : `FAILED: ${JSON.stringify(r.problems)}`);
      process.exitCode = r.ok ? 0 : 1;
      return;
    }
    case 'trace': {
      const path = positionals[1];
      if (path === undefined) throw new Error('usage: trace <journal.jsonl> [--out file.html]');
      await writeTrace(path, values.out ?? path.replace(/\.jsonl$/, '') + '.html', TOKYO_TESTNET.explorerTx);
      return;
    }
    case 'deploy-receipts': {
      const env = loadEnv(values.env);
      const net = resolveNetwork(env);
      const r = await deployReceipts(net, privateKeyFrom(env));
      log(`ClawGuardReceipts at ${r.address}\n  ${txUrl(net, r.txHash)}`);
      return;
    }
    case 'anchor': {
      const path = positionals[1];
      const address = values.address;
      if (path === undefined || address === undefined || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
        throw new Error('usage: anchor <journal.jsonl> --address 0xReceiptsContract');
      }
      const receipts = await readJournal(path);
      const check = await verifyChain(receipts);
      if (!check.ok) throw new Error('journal does not verify; refusing to anchor it');
      const env = loadEnv(values.env);
      const net = resolveNetwork(env);
      const r = await anchorJournal(net, privateKeyFrom(env), address as `0x${string}`, receipts);
      log(`journal ${r.journal}: on-chain next seq ${r.nextSeq.toString()}`);
      for (const h of r.txHashes) log(`  ${txUrl(net, h)}`);
      return;
    }
    case 'fund': {
      const v = await liveVenue();
      try {
        const facts = await v.fundingFacts();
        const plan = fundingPlan(facts);
        log(
          `gas ${formatDecimal(facts.gas, 18)} STT, margin equity ${formatDecimal(facts.equity, 18)} USDso`,
        );
        log(
          `voucher ${JSON.stringify(facts.voucher, (_k, x: unknown) => (typeof x === 'bigint' ? String(x) : x))}`,
        );
        for (const st of plan.steps) log(`  ${st.code}: ${st.text}`);
        if (plan.canClaim && values.yes === true) {
          const hash = await v.claimVoucher();
          log(`voucher claimed\n  ${txUrl(resolveNetwork(loadEnv(values.env)), hash)}`);
        }
        process.exitCode = plan.ready || (plan.canClaim && values.yes === true) ? 0 : 2;
      } finally {
        await v.close();
      }
      return;
    }
    case 'kill': {
      const policy = await loadPolicy();
      const env = loadEnv(values.env);
      const v = await liveVenue();
      try {
        const journal = await Journal.open(
          values.out ?? 'runs/kill.jsonl',
          privateKeyToAccount(privateKeyFrom(env)),
          policyHash(policy),
        );
        const e = new Engine({ venue: v, policy, journal, now: nowSec });
        const outcome = await e.kill(values.reason ?? 'operator');
        let flat = false;
        try {
          const s = await e.snapshot();
          flat = s.orders.length === 0 && Object.values(s.account.positions).every((p) => p === 0n);
          log(killAccountLine(s.orders.length, Object.keys(s.account.positions).length, flat));
          if (!flat) {
            for (const sk of outcome.plan.skipped)
              log(`NOT flat: ${sk.market} position ${sk.position.toString()}: ${sk.why}`);
            for (const p of outcome.problems) log(`NOT flat: ${p}`);
            if (outcome.plan.skipped.length === 0 && outcome.problems.length === 0)
              log('NOT flat: orders or positions remain after the reduce');
            process.exitCode = 2;
          }
        } catch (err) {
          flat = false;
          process.exitCode = 2;
          log(
            `NOT flat: could not read the account to confirm it is flat (${err instanceof Error ? err.message : String(err)})`,
          );
        }
        const st = await onChainStop();
        log(killStopLine(st.stopped, flat));
      } finally {
        await v.close();
      }
      return;
    }
    case 'rest': {
      if (values.live === true) await assertNotStopped();
      const policy = await loadPolicy();
      const signer =
        values.live === true
          ? privateKeyToAccount(privateKeyFrom(loadEnv(values.env)))
          : privateKeyToAccount(generatePrivateKey());
      const venue: Venue =
        values.live === true
          ? await liveVenue()
          : new SimVenue(simMarkets(nowSec()), { collateral: usd('40'), now: nowSec });
      try {
        await runRest({
          venue,
          policy,
          journalPath: values.out ?? `runs/rest-${venue.mode}-${stamp()}.jsonl`,
          signer,
          now: nowSec,
          log,
          market: values.market ?? 'BTC-PERP',
          notional: usd('10.5'),
          offsetBps: 150,
        });
      } finally {
        if (venue instanceof DreamdexVenue) await venue.close();
      }
      return;
    }
    case 'session': {
      if (values.sim === values.live) throw new Error('pick one: session --sim or session --live');
      if (values.live === true) await assertNotStopped();
      const policy = await loadPolicy();
      const env = values.live === true ? loadEnv(values.env) : {};
      const key = values.live === true ? privateKeyFrom(env) : generatePrivateKey();
      let clock = nowSec();
      const sim =
        values.sim === true
          ? new SimVenue(simMarkets(clock), { collateral: usd('40'), now: () => clock, seed: 7 })
          : undefined;
      const venue: Venue = sim ?? (await liveVenue());
      const base = values.out ?? `runs/session-${venue.mode}-${stamp()}`;
      const seconds = Math.round(Number(values.hours ?? '3') * 3600);
      const callTimeoutSec = Number(values['call-timeout'] ?? '30');
      const graceSec = Number(values.grace ?? '60');
      const closeoutSec = Number(values.closeout ?? '180');
      // session rules file (bot-side, stricter only): one file, each loader reads its own sections; defaults when none
      const rulesFile: unknown =
        values.rules === undefined ? undefined : JSON.parse(await readFile(values.rules, 'utf8'));
      const strategyRules = rulesFile === undefined ? DEFAULT_STRATEGY_RULES : parseStrategyRules(rulesFile);
      const rules = rulesFile === undefined ? DEFAULT_RUNTIME_RULES : parseRuntimeRules(rulesFile);
      // SIGTERM / SIGINT / SIGHUP: stop the loop and run the close-out. A second signal exits at once (130).
      const stopCtl = new AbortController();
      let signals = 0;
      const onSignal = (sig: NodeJS.Signals): void => {
        signals += 1;
        if (signals === 1) {
          log(`${iso()} [session] ${sig}: stopping, closing out`);
          stopCtl.abort(sig);
          return;
        }
        log(`${iso()} [session] second ${sig}: exiting now without waiting for the close-out; run kill`);
        process.exit(130);
      };
      for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, onSignal);
      // hard backstop: if the run (loop + grace + close-out + anchoring) is still alive after this, SIGKILL
      const backstop = hardBackstop(
        // + the RPC gate's start wait (outages inside the loop stay inside `seconds`) + the close-out retry
        // phase (its budget plus one pass that may start just before the budget ends)
        (seconds +
          rules.rpcGate.maxOutageSec +
          graceSec +
          closeoutSec +
          (rules.flatten.enabled ? rules.flatten.retryBudgetSec + rules.flatten.passTimeoutSec : 0) +
          2 * (STEP_MS / 1000)) *
          1000,
        `${base}.status.json`,
        'session still running past deadline + grace + close-out + anchoring',
      );
      try {
        const r = await runSession({
          venue,
          policy,
          journalPath: `${base}.jsonl`,
          statusPath: `${base}.status.json`,
          signer: privateKeyToAccount(key),
          now: () => (sim === undefined ? nowSec() : clock),
          wait: (sec) => {
            if (sim !== undefined) {
              clock += sec;
              sim.step(sec);
              return Promise.resolve();
            }
            return new Promise((res) => setTimeout(res, sec * 1000));
          },
          log: (l) => {
            log(`${iso()} ${l}`);
          },
          approve: ttyApprover,
          seconds,
          cycleSec: Number(values.cycle ?? '120'),
          probeEvery: Number(values.probe ?? '5'),
          quoteNotional: usd('10.5'),
          bandBps: 60,
          strategy: values.strategy === 'skew' ? 'skew' : 'band',
          ...(values['skew-config'] === undefined
            ? {}
            : { skew: parseSkewConfig(JSON.parse(readFileSync(values['skew-config'], 'utf8'))) }),
          profit: strategyRules.profit,
          cooldown: strategyRules.cooldown,
          minGas: 2n * 10n ** 18n,
          ...(venue instanceof DreamdexVenue ? { gasBalance: () => venue.gasBalance() } : {}),
          signal: stopCtl.signal,
          callTimeoutSec,
          // the live venue retries reads (3 x 20 s + backoff, rotating RPCs): the outer bound covers that
          readTimeoutSec: Math.max(callTimeoutSec * 2, 70),
          graceSec,
          stallSec: Number(values.stall ?? '900'),
          // live: the process clock lets the watchdog notice a paused box (wall clock jumps ahead)
          ...(sim === undefined ? { monoMs: () => performance.now() } : {}),
          closeoutSec,
          closeoutAttempts: 3,
          closeoutPauseSec: sim === undefined ? 3 : 0,
          rpcGate: rules.rpcGate,
          flatten: rules.flatten,
        });
        const big = (_k: string, x: unknown): unknown => (typeof x === 'bigint' ? x.toString() : x);
        const summary = {
          ...r,
          check: { ok: r.check.ok, count: r.check.count, head: r.check.head },
          pnlUsd: formatDecimal(r.pnl, 18),
          startEquityUsd: formatDecimal(r.startEquity, 18),
          endEquityUsd: formatDecimal(r.endEquity, 18),
          anchors: [] as string[],
        };
        if (venue instanceof DreamdexVenue) {
          try {
            const a = await withTimeout(
              anchorJournal(
                resolveNetwork(env),
                key,
                receiptsAddress(env),
                await readJournal(`${base}.jsonl`),
              ),
              2 * STEP_MS,
              'anchoring',
            );
            summary.anchors = a.txHashes;
            log(
              `${iso()} anchored ${String(a.txHashes.length)} batches, journal ${a.journal}, next seq ${a.nextSeq.toString()}`,
            );
          } catch (e) {
            log(`${iso()} anchoring failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        const summaryJson = JSON.stringify(summary, big, 2);
        await writeFile(`${base}.summary.json`, `${summaryJson}\n`);
        log(`${iso()} summary written to ${base}.summary.json`);
        await writeSessionReport(base, JSON.parse(summaryJson));
        if (!r.flat) {
          log(`${iso()} [session] NOT flat after close-out: run \`pnpm cli kill\` now`);
          process.exitCode = 2;
        }
      } finally {
        if (venue instanceof DreamdexVenue)
          await withTimeout(venue.close(), 10_000, 'close').catch(() => undefined);
        await backstop.cancel();
        for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.off(sig, onSignal);
      }
      await writeTrace(
        `${base}.jsonl`,
        `${base}.html`,
        sim === undefined ? TOKYO_TESTNET.explorerTx : undefined,
      );
      return;
    }
    case 'report': {
      const file = positionals[1];
      if (file === undefined) throw new Error('usage: report <summary.json> [--out f.md]');
      const out = values.out ?? file.replace(/\.summary\.json$/, '') + '.report.md';
      await writeFile(
        out,
        renderSessionReport(JSON.parse(await readFile(file, 'utf8')), { name: reportName(file) }),
      );
      log(`report written to ${out}`);
      return;
    }
    case 'stop':
    case 'rearm': {
      const env = loadEnv(values.env);
      const net = resolveNetwork(env);
      const key = privateKeyFrom(env);
      const policy = await loadPolicy();
      const path = cmd === 'stop' ? (values.out ?? `runs/stop-${stamp()}.jsonl`) : positionals[1];
      if (path === undefined) throw new Error('usage: rearm <stop-journal.jsonl>');
      const journal = await Journal.open(path, privateKeyToAccount(key), policyHash(policy));
      if (cmd === 'rearm' && journal.receipts.length === 0) throw new Error(`${path} is empty`);
      await journal.append(
        'kill_switch',
        cmd === 'stop'
          ? { action: 'trip', reason: values.reason ?? 'remote stop', source: 'remote' }
          : { action: 'rearm', source: 'remote' },
        nowSec(),
      );
      const r = await anchorJournal(net, key, receiptsAddress(env), journal.receipts);
      log(`${iso()} ${cmd} anchored: journal ${r.journal}, next seq ${r.nextSeq.toString()} (${path})`);
      for (const h of r.txHashes) log(`  ${txUrl(net, h)}`);
      return;
    }
    case 'probes': {
      if (values.dry === values.live) throw new Error('pick one: probes --dry or probes --live');
      if (values.live === true) await assertNotStopped();
      const policy = await loadPolicy();
      const env = values.live === true ? loadEnv(values.env) : {};
      const key = values.live === true ? privateKeyFrom(env) : generatePrivateKey();
      const clock = nowSec();
      const venue: Venue =
        values.dry === true
          ? new SimVenue(simMarkets(clock), { collateral: usd('2000'), now: () => clock, seed: 7 })
          : timedVenue(await liveVenue());
      const base = values.out ?? `runs/probes-${values.dry === true ? 'dry' : 'live'}-${stamp()}`;
      const signer = privateKeyToAccount(key);
      const ph = policyHash(policy);
      const journal = await Journal.open(`${base}.jsonl`, signer, ph);
      if (journal.receipts.length > 0) throw new Error(`${base}.jsonl already exists; pick a new --out`);
      let anchors: `0x${string}`[] = [];
      let journalHash: `0x${string}` | undefined;
      try {
        const r = await runProbes({
          venue,
          policy,
          journal,
          policyHash: ph,
          now: () => (values.dry === true ? clock : nowSec()),
          log: (l) => {
            log(`${iso()} ${l}`);
          },
          quoteNotional: usd('10.5'),
        });
        if (values.live === true) {
          try {
            const a = await withTimeout(
              anchorJournal(resolveNetwork(env), key, receiptsAddress(env), journal.receipts),
              4 * STEP_MS,
              'anchoring',
            );
            anchors = a.txHashes;
            journalHash = a.journal;
            log(`${iso()} anchored ${String(a.txHashes.length)} batches, journal ${a.journal}`);
          } catch (e) {
            log(`${iso()} anchoring failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        const big = (_k: string, x: unknown): unknown => (typeof x === 'bigint' ? x.toString() : x);
        await writeFile(
          `${base}.summary.json`,
          `${JSON.stringify({ ...r, journal: journalHash, anchors }, big, 2)}\n`,
        );
        await writeFile(
          `${base}.md`,
          probeMarkdown(r, {
            ...(journalHash === undefined ? {} : { journal: journalHash }),
            anchors,
            explorerTx: TOKYO_TESTNET.explorerTx,
          }),
        );
        log(
          `${iso()} probes: ${String(r.passed)}/${String(r.total)} as expected, venue submits ${String(r.venueSubmits)} (expected ${String(r.expectedVenueSubmits)}), gate let through ${String(r.gateLetThrough)} (fenced), new gaps ${String(r.unexpected.length)}, receipts ${String(r.check.count)} chain ${r.check.ok ? 'ok' : 'FAILED'}`,
        );
        log(`${iso()} summary written to ${base}.summary.json and ${base}.md`);
        if (r.unexpected.length > 0 || !r.fenceOk || !r.check.ok) process.exitCode = 1;
      } finally {
        await withTimeout(venue.close(), 10_000, 'close').catch(() => undefined);
      }
      await writeTrace(
        `${base}.jsonl`,
        `${base}.html`,
        values.dry === true ? undefined : TOKYO_TESTNET.explorerTx,
      );
      return;
    }
    case 'watch': {
      const env = loadEnv(values.env);
      const net = resolveNetwork(env);
      const key = privateKeyFrom(env);
      const signer = privateKeyToAccount(key).address;
      const contract = receiptsAddress(env);
      const seconds = Number(values.seconds ?? '0');
      const policy = await loadPolicy();
      const live = await liveVenue();
      // every venue call bounded, so a hung read cannot freeze a reaction (or the shutdown behind it)
      const venue = timedVenue(live);
      const statusPath =
        (values.out ?? `runs/watch-${stamp()}.jsonl`).replace(/\.jsonl$/, '') + '.status.json';
      const backstop =
        seconds > 0
          ? hardBackstop((seconds + 120) * 1000, statusPath, 'watch still running 120 s past --seconds')
          : undefined;
      const boundedStopped = (): Promise<boolean> =>
        withTimeout(readStopped(net, contract, signer), 30_000, 'read the on-chain stop');
      let engine: Engine | undefined;
      if (values.react === true) {
        const journal = await Journal.open(
          values.out ?? `runs/watch-${stamp()}.jsonl`,
          privateKeyToAccount(key),
          policyHash(policy),
        );
        engine = new Engine({ venue, policy, journal, now: nowSec });
      }
      const snap0 = await venue.snapshot(policy.markets);
      const wsOpts = (label: string) => ({
        log: (l: string) => {
          log(`${iso()} [${label}] ${l}`);
        },
      });
      const byPool = new Map(
        Object.entries(snap0.markets).map(([name, m]) => [m.pool.toLowerCase(), { ...m, market: name }]),
      );
      const bank = Object.values(snap0.markets)[0]?.marginBank;
      if (bank === undefined) throw new Error('no margin bank known');
      let tripping = false;
      const trip = async (why: string): Promise<void> => {
        log(`${iso()} [react] ${why}`);
        if (engine === undefined) {
          log(`${iso()} [react] watch-only (no --react): would trip the kill switch now`);
          return;
        }
        if (tripping) return;
        tripping = true;
        try {
          const before = await engine.snapshot();
          await engine.kill(why);
          const after = await engine.snapshot();
          log(
            `${iso()} [react] kill switch on: open orders ${String(before.orders.length)} -> ${String(after.orders.length)}, positions ${String(Object.keys(before.account.positions).length)} -> ${String(Object.keys(after.account.positions).length)}`,
          );
        } finally {
          tripping = false;
        }
      };
      const onStop = (cause: StopCause): Promise<void> =>
        trip(
          cause.source === 'event'
            ? `on-chain stop: ${cause.event.name} journal ${cause.event.journal} seq ${cause.event.seq.toString()}`
            : 'on-chain stop already on at connect',
        );
      const w = new StopWatcher({
        transport: new WsReactivityTransport(net.wsRpcUrl, 30_000, wsOpts('watch')),
        contract,
        signer,
        readStopped: boundedStopped,
        onStop,
        onRearm: (ev) => {
          log(`${iso()} [react] re-armed on-chain${ev === undefined ? '' : ` (seq ${ev.seq.toString()})`}`);
          return Promise.resolve();
        },
        onEvent: (ev) => {
          log(`${iso()} [push] ${describe(ev)}`);
        },
        log: (l) => {
          log(`${iso()} ${l}`);
        },
      });
      const transport = new WsReactivityTransport(net.wsRpcUrl, 30_000, wsOpts('positions'));
      const g = new PositionGuard({
        transport,
        marginBank: bank,
        account: venue.account,
        policy,
        market: (pool) => {
          const m = byPool.get(pool.toLowerCase());
          return m === undefined
            ? undefined
            : { market: m.market, baseDecimals: m.baseDecimals, markPrice: m.markPrice };
        },
        stopped: () => w.stopped === true,
        onBreach: (v) => trip(`on-chain position: ${v.message}`),
        onEvent: (ev, v) => {
          log(
            `${iso()} [push] PositionUpdated pool ${ev.pool} size ${ev.newSize.toString()} realizedPnl ${formatDecimal(ev.realizedPnl, 18)} | ${v.message}`,
          );
        },
        log: (l) => {
          log(`${iso()} ${l}`);
        },
      });
      log(
        `${iso()} watching ${contract} for signer ${signer} and MarginBank ${bank} for account ${venue.account} over ${net.wsRpcUrl} (somnia_watch)`,
      );
      await w.start();
      await g.start();
      await new Promise<void>((resolve) => {
        if (seconds > 0) setTimeout(resolve, seconds * 1000);
        for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
          process.once(sig, () => {
            log(`${iso()} [watch] ${sig}: stopping`);
            resolve();
          });
        }
      });
      // shutdown is bounded too: a reaction stuck on the network must not keep the watcher alive
      const quiet = (p: Promise<void>, what: string): Promise<void> =>
        withTimeout(p, 15_000, what).catch((e: unknown) => {
          log(`${iso()} [watch] ${e instanceof Error ? e.message : String(e)}`);
        });
      await quiet(w.stop(), 'stop watcher');
      await quiet(g.stop(), 'stop position guard');
      await quiet(venue.close(), 'close venue');
      await backstop?.cancel();
      log(
        `${iso()} watch ended: ${String(w.events.length + g.events.length)} pushes, ${String(w.reactions + g.breaches)} reactions`,
      );
      return;
    }
    default:
      log(
        'usage: claw-guard <doctor|demo --sim|demo --live|fill --sim|fill --live|verify <journal>|trace <journal>|rest --sim|rest --live|session --sim|session --live|kill|stop|rearm <journal>|watch [--react]|report <summary.json>> [--policy file] [--env file] [--yes]',
      );
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
