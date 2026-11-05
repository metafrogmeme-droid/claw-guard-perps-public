// Machine-written session report. The session CLI writes `<base>.report.md` next to `<base>.summary.json` at
// the end of every run, so a daily routine always has a report file even when nobody writes the long-form one
// (on 4 Nov the 14:00 run showed "failed" only because no daily report was written). `report <summary.json>`
// renders it again from a saved summary. Facts only, from the summary; no advice, no forecasts.

type Rec = Readonly<Record<string, unknown>>;

const rec = (v: unknown): Rec => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {});
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown, d = ''): string =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : d;
const arr = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);

/** Unix seconds as "YYYY-MM-DD HH:MM:SS CET" (Europe/Amsterdam; CEST in summer). */
export function cetTime(sec: number): string {
  const d = new Date(sec * 1000);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).formatToParts(d);
  const p = (t: string): string => parts.find((x) => x.type === t)?.value ?? '';
  return `${p('year')}-${p('month')}-${p('day')} ${p('hour')}:${p('minute')}:${p('second')} ${p('timeZoneName')}`;
}

export interface ReportMeta {
  /** Run name shown in the title, e.g. "session-daily-2026-11-05". */
  readonly name: string;
  /** Git commit the run used, if known. */
  readonly commit?: string;
}

export function renderSessionReport(summaryIn: unknown, meta: ReportMeta): string {
  const s = rec(summaryIn);
  const counts = rec(s['counts']);
  const co = rec(s['closeOut']);
  const rpc = rec(s['rpc']);
  const check = rec(s['check']);
  const profit = rec(s['profit']);
  const cool = rec(s['cooldown']);
  const jumps = rec(s['clockJumps']);
  const flat = s['flat'] === true;
  const started = num(s['startedAt']);
  const ended = num(s['endedAt']);
  const blocked = Object.entries(rec(s['blockedCodes']))
    .map(([k, v]) => `${k} ${str(v, '0')}`)
    .join(', ');
  const positions = Object.entries(rec(co['positions']))
    .map(([k, v]) => `${k} ${str(v)}`)
    .join(', ');
  const errors = arr(co['errors']).map((e) => str(e));
  const watchdog =
    s['watchdogFired'] === true ? `fired (${str(s['watchdogReason'], 'deadline watchdog')})` : 'not fired';
  const lines = [
    `# ${meta.name}`,
    '',
    `Machine report from the session summary${meta.commit === undefined ? '' : ` (commit ${meta.commit})`}. Testnet.`,
    '',
    '| | |',
    '|---|---|',
    `| Result | ${flat ? 'done, flat' : 'done, NOT flat: run `pnpm cli kill`'} |`,
    `| Started | ${started > 0 ? cetTime(started) : 'n/a'} |`,
    `| Ended | ${ended > 0 ? cetTime(ended) : 'n/a'} |`,
    `| Stop reason | ${str(s['stopReason'], 'n/a')} |`,
    `| Watchdog | ${watchdog} |`,
    `| Clock jumps (box paused) | ${String(num(jumps['count']))}${num(jumps['count']) > 0 ? `, largest ${String(num(jumps['maxSec']))} s` : ''} |`,
    `| Cycles | ${String(num(s['cycles']))} |`,
    `| Allowed / blocked / needs your OK | ${String(num(counts['allowed']))} / ${String(num(counts['blocked']))} / ${String(num(counts['needsOk']))} |`,
    `| Sent / accepted by venue / cancels | ${String(num(counts['sent']))} / ${String(num(counts['venueOk']))} / ${String(num(counts['cancels']))} |`,
    `| Blocked codes | ${blocked === '' ? 'none' : blocked} |`,
    `| Equity start / end (USDso) | ${str(s['startEquityUsd'], 'n/a')} / ${str(s['endEquityUsd'], 'n/a')} |`,
    `| Session P&L (USDso) | ${str(s['pnlUsd'], 'n/a')} |`,
    `| Receipts | ${String(num(check['count']))} (chain check ${check['ok'] === true ? 'ok' : 'NOT ok'}) |`,
    `| Anchored batches | ${String(arr(s['anchors']).length)} |`,
    `| RPC pauses / outage | ${String(num(rpc['pauses']))} / ${String(num(rpc['outageSec']))} s |`,
    `| Close-out | attempts ${String(num(co['attempts']))}, passes ${String(num(co['passes']))}, retries ${String(num(co['retries']))}, open orders ${String(num(co['openOrders']))}${positions === '' ? '' : `, positions ${positions}`} |`,
    `| Profit rules | no edge ${String(num(profit['noEdge']))}, dropped not maker ${String(num(profit['droppedNotMaker']))}, loss stop ${profit['lossStop'] === true ? 'hit' : 'not hit'} |`,
    `| Loss cooldown | trades ${String(num(cool['trades']))}, losses ${String(num(cool['losses']))}, cooldowns ${String(num(cool['cooldowns']))} |`,
  ];
  if (errors.length > 0) lines.push('', '## Close-out errors', '', ...errors.map((e) => `- ${e}`));
  return `${lines.join('\n')}\n`;
}
