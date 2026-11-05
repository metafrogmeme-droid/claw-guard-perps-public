// The probe run: every probe in the matrix goes through the real gate (Engine.submit), one fresh engine per
// probe, all sharing one signed journal. A fence sits between the engine and the venue: it counts every order
// the engine tries to send and only lets the one control probe marked `forward` through. Reads (snapshot,
// sizing) go to the real venue, with the probe's starting state applied to the gate's view.
import type { Hex } from 'viem';

import { utcDay } from '../gate/gate.js';
import type { Policy } from '../gate/policy.js';
import type { OrderIntent, Verdict, VenueSizing } from '../gate/types.js';
import type { RestingOrder } from '../killswitch/killswitch.js';
import type { Journal } from '../receipts/journal.js';
import { verifyChain, type VerifyResult } from '../receipts/receipt.js';
import type { CancelResult, PlaceResult, Venue, VenueMarket, VenueSnapshot } from '../venue/types.js';
import { Engine } from './engine.js';
import { KNOWN_GAPS, PROBE_GROUPS, probeMatrix, type ProbeGroup, type ProbeVariant } from './probe-matrix.js';

export const FENCE_ERROR = 'probe fence: not forwarded';

/** Wraps the real venue for a probe run. Orders are fenced; reads pass through with the probe's setup. */
export class ProbeFence implements Venue {
  current: ProbeVariant | undefined;
  /** Orders the engine tried to send (the gate let them through), all probes. */
  placeCalls = 0;
  /** Orders that really went to the venue (probes marked forward). */
  venueSubmits = 0;
  /** Set during the close-out: reduce-only orders pass so a filled control can be closed. */
  closing = false;
  /** Reduce-only close-out orders sent to the venue. */
  closeOutSubmits = 0;
  constructor(
    private readonly inner: Venue,
    private readonly now: () => number,
  ) {}

  get mode(): Venue['mode'] {
    return this.inner.mode;
  }
  get account(): `0x${string}` {
    return this.inner.account;
  }
  get sender(): `0x${string}` {
    return this.inner.sender;
  }

  async snapshot(markets: readonly string[]): Promise<VenueSnapshot> {
    const s = await this.inner.snapshot(markets);
    const setup = this.current?.setup;
    if (setup === undefined) return s;
    const target = this.current?.intent.market;
    const out: Record<string, VenueMarket> = { ...s.markets };
    let account = s.account;
    const tm = typeof target === 'string' ? s.markets[target] : undefined;
    if (tm !== undefined && typeof target === 'string') {
      if (setup.market !== undefined) out[target] = setup.market(tm, this.now());
      if (setup.account !== undefined) account = setup.account(account, tm);
    } else if (setup.account !== undefined) {
      // no row for the target market: still apply account-only setups against any listed market
      const any = Object.values(s.markets)[0];
      if (any !== undefined) account = setup.account(account, any);
    }
    return { ...s, markets: out, account };
  }

  async sizing(market: VenueMarket, intent: OrderIntent): Promise<VenueSizing> {
    const override = this.current?.setup?.sizing;
    if (override === undefined) return this.inner.sizing(market, intent);
    const s = await this.inner.sizing(market, intent).catch(() => undefined);
    return override(s, market);
  }

  async place(market: VenueMarket, intent: OrderIntent): Promise<PlaceResult> {
    // strict on purpose: an untyped intent can carry a truthy non-boolean here
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare
    if (this.closing && intent.reduceOnly === true && this.current === undefined) {
      this.closeOutSubmits += 1;
      return this.inner.place(market, intent);
    }
    this.placeCalls += 1;
    if (this.current?.forward !== true) return { ok: false, filled: 0n, error: FENCE_ERROR };
    this.venueSubmits += 1;
    return this.inner.place(market, intent);
  }

  cancel(market: VenueMarket, order: RestingOrder): Promise<CancelResult> {
    return this.inner.cancel(market, order);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

export interface ProbeResult {
  readonly id: string;
  readonly group: ProbeGroup;
  readonly label: string;
  readonly expect: Verdict;
  readonly rule?: string;
  /** The gate's verdict, or "threw" when the gate raised instead of answering. */
  readonly verdict: Verdict | 'threw';
  readonly codes: readonly string[];
  readonly pass: boolean;
  readonly attempts: number;
  /** Decision receipts written for this probe (one per attempt). */
  readonly receipts: readonly Hex[];
  /** Times the gate let this probe through to the fence. */
  readonly reachedFence: number;
  /** Times it really went to the venue (only the forwarded control). */
  readonly venueSubmits: number;
  readonly venueOk?: boolean;
  readonly error?: string;
  /** Set when this probe is a listed known gap (see KNOWN_GAPS). */
  readonly knownGap?: string;
}

export interface RuleCount {
  readonly rule: string;
  readonly probes: number;
  readonly pass: number;
}

export interface GroupCount {
  readonly group: ProbeGroup;
  readonly probes: number;
  readonly pass: number;
}

export interface ProbeRunResult {
  readonly mode: string;
  readonly at: number;
  readonly policyHash: Hex;
  readonly signer: Hex;
  readonly account: Hex;
  readonly results: readonly ProbeResult[];
  readonly total: number;
  readonly passed: number;
  readonly failed: readonly string[];
  /** Failed probes that are not listed known gaps: each one is a new gate bug. */
  readonly unexpected: readonly string[];
  readonly byGroup: readonly GroupCount[];
  readonly byRule: readonly RuleCount[];
  /** Codes the gate reported across all probes, with how many probes reported each. */
  readonly codesSeen: Readonly<Record<string, number>>;
  readonly venueSubmits: number;
  readonly expectedVenueSubmits: number;
  /** Probes expected to be blocked or held that the gate let through anyway (each one stopped at the fence). */
  readonly gateLetThrough: number;
  /** True when only the forwarded control reached the venue: no other probe was ever sent. */
  readonly fenceOk: boolean;
  readonly check: VerifyResult;
  readonly cleanup: {
    readonly cancels: number;
    readonly closeOutSubmits: number;
    readonly positionsLeft: number;
  };
}

export interface ProbeRunOptions {
  readonly venue: Venue;
  readonly policy: Policy;
  readonly journal: Journal;
  readonly policyHash: Hex;
  readonly now: () => number;
  readonly log: (line: string) => void;
  readonly quoteNotional: bigint;
  /** Markets the matrix is built on. Both must be in the policy. */
  readonly btcMarket?: string;
  readonly ethMarket?: string;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function runProbes(o: ProbeRunOptions): Promise<ProbeRunResult> {
  const fence = new ProbeFence(o.venue, o.now);
  const btcName = o.btcMarket ?? 'BTC-PERP';
  const ethName = o.ethMarket ?? 'ETH-PERP';
  const snap = await o.venue.snapshot([btcName, ethName]);
  const btc = snap.markets[btcName];
  const eth = snap.markets[ethName];
  if (btc === undefined || eth === undefined) throw new Error(`${btcName} and ${ethName} must be listed`);
  const held = Object.values(snap.account.positions).filter((x) => x !== 0n).length;
  if (held > 0 || snap.orders.length > 0) {
    throw new Error(
      `probe run needs a flat account with no open orders (positions ${String(held)}, orders ${String(snap.orders.length)}); stop the session first`,
    );
  }
  const matrix = probeMatrix({ btc, eth }, o.quoteNotional);
  const results: ProbeResult[] = [];
  let lastEngine: Engine | undefined;
  const forwardedOrders: RestingOrder[] = [];

  for (const p of matrix) {
    const engine = new Engine({
      venue: fence,
      policy: o.policy,
      journal: o.journal,
      now: o.now,
      approve: () => Promise.resolve(false),
    });
    const now = o.now();
    const mem0 = { ...engine.memory, day: utcDay(now) };
    engine.memory = p.setup?.memory === undefined ? mem0 : p.setup.memory(mem0, now);
    if (p.setup?.killSwitch !== undefined) engine.killSwitch = p.setup.killSwitch;
    fence.current = p;
    const before = { place: fence.placeCalls, submit: fence.venueSubmits };
    const receipts: Hex[] = [];
    let verdict: Verdict | 'threw' = 'threw';
    let codes: readonly string[] = [];
    let pass = true;
    let venueOk: boolean | undefined;
    let error: string | undefined;
    const attempts = p.repeat ?? 1;
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await engine.submit(p.intent);
        receipts.push(r.receipt.hash);
        verdict = r.decision.verdict;
        codes = r.decision.codes;
        if (r.execution !== undefined) {
          venueOk = r.execution.result.ok;
          if (!r.execution.result.ok && r.execution.result.error !== FENCE_ERROR)
            error = r.execution.result.error ?? r.execution.result.errorName;
        }
        const hit = verdict === p.expect && (p.rule === undefined || codes.includes(p.rule));
        if (!hit) pass = false;
      } catch (e) {
        verdict = 'threw';
        codes = [];
        pass = false;
        error = errText(e);
      }
    }
    for (const t of engine.tracked.values()) forwardedOrders.push(t);
    for (const t of [...engine.tracked.values()]) await engine.cancel(t, 'probe run: control quote');
    lastEngine = engine;
    fence.current = undefined;
    const res: ProbeResult = {
      id: p.id,
      group: p.group,
      label: p.label,
      expect: p.expect,
      ...(p.rule === undefined ? {} : { rule: p.rule }),
      verdict,
      codes,
      pass,
      attempts,
      receipts,
      reachedFence: fence.placeCalls - before.place,
      venueSubmits: fence.venueSubmits - before.submit,
      ...(venueOk === undefined ? {} : { venueOk }),
      ...(error === undefined ? {} : { error }),
      ...(KNOWN_GAPS[p.id] === undefined ? {} : { knownGap: KNOWN_GAPS[p.id] }),
    };
    results.push(res);
    const got = verdict === 'threw' ? `gate threw (${error ?? ''})` : `${verdict} ${codes.join(',')}`;
    o.log(`[probe] ${pass ? 'PASS' : 'FAIL'} ${p.id}: ${p.label} -> ${got}`);
  }

  // Clean-up: the forwarded control was cancelled above. If it filled in between, close reduce-only.
  let positionsLeft = 0;
  if (lastEngine !== undefined) {
    const after = await lastEngine.snapshot();
    positionsLeft = Object.values(after.account.positions).filter((x) => x !== 0n).length;
    if (positionsLeft > 0) {
      fence.closing = true;
      await lastEngine.abort('probe run close-out');
      fence.closing = false;
      const again = await lastEngine.snapshot();
      positionsLeft = Object.values(again.account.positions).filter((x) => x !== 0n).length;
    }
  }

  const expectedVenueSubmits = results.filter(
    (r) => matrix.find((p) => p.id === r.id)?.forward === true && r.verdict === 'allowed',
  ).length;
  const gateLetThrough = results
    .filter((r) => r.expect !== 'allowed')
    .reduce((n, r) => n + r.reachedFence, 0);
  const fenceOk =
    fence.venueSubmits === expectedVenueSubmits &&
    results.every((r) => r.venueSubmits === 0 || matrix.find((p) => p.id === r.id)?.forward === true);

  const byGroup: GroupCount[] = PROBE_GROUPS.map((g) => {
    const rs = results.filter((r) => r.group === g);
    return { group: g, probes: rs.length, pass: rs.filter((r) => r.pass).length };
  }).filter((g) => g.probes > 0);
  const rules = [...new Set(results.map((r) => r.rule ?? 'ALLOWED'))];
  const byRule: RuleCount[] = rules.map((rule) => {
    const rs = results.filter((r) => (r.rule ?? 'ALLOWED') === rule);
    return { rule, probes: rs.length, pass: rs.filter((r) => r.pass).length };
  });
  const codesSeen: Record<string, number> = {};
  for (const r of results) for (const c of r.codes) codesSeen[c] = (codesSeen[c] ?? 0) + 1;

  return {
    mode: o.venue.mode,
    at: o.now(),
    policyHash: o.policyHash,
    signer: o.journal.receipts[0]?.signer ?? '0x',
    account: o.venue.account,
    results,
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).map((r) => r.id),
    unexpected: results.filter((r) => !r.pass && r.knownGap === undefined).map((r) => r.id),
    byGroup,
    byRule,
    codesSeen,
    venueSubmits: fence.venueSubmits,
    expectedVenueSubmits,
    gateLetThrough,
    fenceOk,
    check: await verifyChain(o.journal.receipts),
    cleanup: { cancels: forwardedOrders.length, closeOutSubmits: fence.closeOutSubmits, positionsLeft },
  };
}

const cell = (s: string): string => s.replace(/\|/g, '\\|');

/** Public summary in markdown. `explorerTx` turns anchor hashes into links. */
export function probeMarkdown(
  r: ProbeRunResult,
  extra: { readonly journal?: Hex; readonly anchors?: readonly Hex[]; readonly explorerTx?: string } = {},
): string {
  const when = new Date(r.at * 1000).toISOString().replace('T', ' ').slice(0, 16);
  const lines: string[] = [
    `# Claw Guard Perps probe run (${r.mode}, ${when} UTC)`,
    '',
    `Somnia Tokyo testnet only. Policy ${r.policyHash}, signer ${r.signer}.`,
    '',
    '| | |',
    '| --- | --- |',
    `| Probes | ${String(r.total)} |`,
    `| As expected | ${String(r.passed)} of ${String(r.total)} |`,
    `| Not as expected, known gaps | ${String(r.failed.length - r.unexpected.length)}${r.failed.length > r.unexpected.length ? `: ${r.failed.filter((x) => !r.unexpected.includes(x)).join(', ')}` : ''} |`,
    `| Not as expected, new | ${r.unexpected.length === 0 ? '0' : `${String(r.unexpected.length)}: ${r.unexpected.join(', ')}`} |`,
    `| Orders sent to the venue | ${String(r.venueSubmits)} (expected ${String(r.expectedVenueSubmits)}: the one control quote) |`,
    `| Blocked or held probes sent to the venue | ${String(r.results.filter((x) => x.expect !== 'allowed').reduce((n, x) => n + x.venueSubmits, 0))} |`,
    `| Blocked or held probes the gate let through (stopped at the fence) | ${String(r.gateLetThrough)} |`,
    `| Receipts | ${String(r.check.count)} (chain check ${r.check.ok ? 'ok' : 'FAILED'}) |`,
    `| Clean-up | ${String(r.cleanup.cancels)} control cancelled, ${String(r.cleanup.closeOutSubmits)} close-out orders, ${String(r.cleanup.positionsLeft)} positions left |`,
    '',
    '## Per group',
    '',
    '| Group | Probes | As expected |',
    '| --- | --- | --- |',
    ...r.byGroup.map((g) => `| ${g.group} | ${String(g.probes)} | ${String(g.pass)} |`),
    '',
    '## Per expected rule',
    '',
    '| Rule | Probes | As expected |',
    '| --- | --- | --- |',
    ...r.byRule.map((g) => `| ${g.rule} | ${String(g.probes)} | ${String(g.pass)} |`),
    '',
    '## Every probe',
    '',
    '| Probe | What is wrong | Expected | Got | Result |',
    '| --- | --- | --- | --- | --- |',
    ...r.results.map((x) => {
      const exp = `${x.expect}${x.rule === undefined ? '' : ` (${x.rule})`}`;
      const got =
        x.verdict === 'threw'
          ? 'gate threw'
          : `${x.verdict}${x.codes.length > 0 ? ` (${x.codes.join(', ')})` : ''}`;
      return `| ${x.id} | ${cell(x.label)} | ${exp} | ${cell(got)} | ${x.pass ? 'ok' : x.knownGap === undefined ? 'NOT AS EXPECTED' : `known gap: ${cell(x.knownGap)}`} |`;
    }),
  ];
  if (extra.journal !== undefined || (extra.anchors?.length ?? 0) > 0) {
    lines.push('', '## Anchors', '');
    if (extra.journal !== undefined) lines.push(`Journal ${extra.journal}`, '');
    for (const h of extra.anchors ?? [])
      lines.push(extra.explorerTx === undefined ? `- ${h}` : `- [${h}](${extra.explorerTx}${h})`);
  }
  return `${lines.join('\n')}\n`;
}
