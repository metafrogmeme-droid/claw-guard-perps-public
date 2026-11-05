// Self-contained HTML trace of a receipt journal: one row per receipt, verdict wording as recorded, explorer
// links for transactions, and the chain check result on top. No scripts, no external assets.
import type { Receipt, VerifyResult } from '../receipts/receipt.js';

const ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape for HTML text and double-quoted attributes (every value lands in one of those two places). */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
}

const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';

function obj(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

const short = (h: string): string => (h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-4)}` : h);

export interface TraceOptions {
  readonly title: string;
  readonly explorerTx?: string;
  /** Market base decimals, for showing quantities in whole units. */
  readonly baseDecimals?: Readonly<Record<string, number>>;
}

function human(raw: string, decimals: number): string {
  if (!/^-?\d+$/.test(raw)) return raw;
  const neg = raw.startsWith('-');
  const digits = (neg ? raw.slice(1) : raw).padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac === '' ? '' : `.${frac}`}`;
}

function txCell(hash: unknown, explorer: string | undefined): string {
  const h = str(hash);
  if (h === '') return '';
  if (explorer === undefined) return `<code>${esc(short(h))}</code>`;
  return `<a href="${esc(explorer + h)}"><code>${esc(short(h))}</code></a>`;
}

function row(r: Receipt, o: TraceOptions): string {
  const d = r.data;
  const time = new Date(r.ts * 1000).toISOString().replace('T', ' ').slice(0, 19);
  let cls: string = r.kind;
  let what: string;
  let detail: string;
  if (r.kind === 'decision') {
    const i = obj(d['intent']);
    const market = str(i['market']);
    const dec = o.baseDecimals?.[market] ?? 0;
    cls = str(d['verdict']);
    what = `${esc(str(i['agent']))}: ${esc(str(i['side']))} ${esc(human(str(i['quantity']), dec))} ${esc(market)} @ ${esc(human(str(i['price']), 18))} (${esc(str(i['orderType']))})`;
    const details = obj(d['details']);
    detail = `<b>${esc(str(d['message']))}</b>${Object.entries(details)
      .map(([k, v]) => `<br><code>${esc(k)}</code> ${esc(str(v))}`)
      .join('')}`;
    if (d['ownerOk'] !== undefined) detail += `<br>owner OK: ${d['ownerOk'] === true ? 'yes' : 'no'}`;
    if (str(i['reason']) !== '') detail += `<br><i>${esc(str(i['reason']))}</i>`;
  } else if (r.kind === 'execution') {
    const ok = d['ok'] === true;
    cls = ok ? 'exec-ok' : d['benign'] === true ? 'exec-benign' : 'exec-fail';
    what = `${esc(str(d['action']))}${d['orderId'] === undefined ? '' : ` order ${esc(str(d['orderId']))}`}`;
    detail = ok
      ? `sent${str(d['filled']) !== '' && str(d['filled']) !== '0' ? `, filled ${esc(str(d['filled']))}` : ''}`
      : `venue said: ${esc(str(d['errorName']) || str(d['error']))}`;
  } else {
    what = `kill switch: ${esc(str(d['action']))}`;
    detail = esc(str(d['reason']));
  }
  return `<tr class="${esc(cls)}"><td>${String(r.seq)}</td><td>${esc(time)}</td><td>${esc(r.kind)}</td><td>${what}</td><td>${detail}</td><td>${txCell(d['txHash'], o.explorerTx)}</td><td><code title="${esc(r.hash)}">${esc(short(r.hash))}</code></td></tr>`;
}

export function renderTrace(receipts: readonly Receipt[], check: VerifyResult, o: TraceOptions): string {
  const counts = { allowed: 0, blocked: 0, needs_ok: 0 };
  for (const r of receipts) {
    const v = str(r.data['verdict']);
    if (v === 'allowed' || v === 'blocked' || v === 'needs_ok') counts[v] += 1;
  }
  const status = check.ok
    ? `Chain verified: ${String(check.count)} receipts, head <code>${esc(check.head)}</code>`
    : `Chain check failed: ${check.problems.map((p) => `#${String(p.seq)} ${esc(p.problem)}`).join('; ')}`;
  const signer = receipts[0]?.signer ?? '';
  const policy = receipts[0]?.policyHash ?? '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(o.title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font:14px/1.4 system-ui,sans-serif;margin:24px;color:#1b1f24;background:#fafafa}
h1{font-size:20px;margin:0 0 8px}.meta{color:#555;margin-bottom:12px}
.status{padding:8px 12px;border-radius:6px;margin-bottom:12px;background:${check.ok ? '#e6f4ea' : '#fdecea'}}
table{border-collapse:collapse;width:100%;background:#fff}td,th{border-bottom:1px solid #e3e3e3;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#f0f0f0;position:sticky;top:0}code{font-size:12px}
tr.allowed td:first-child{border-left:4px solid #1e8e3e}tr.blocked td:first-child{border-left:4px solid #d93025}
tr.needs_ok td:first-child{border-left:4px solid #f29900}tr.exec-ok td:first-child{border-left:4px solid #1a73e8}
tr.exec-benign td:first-child{border-left:4px solid #9aa0a6}tr.exec-fail td:first-child{border-left:4px solid #a50e0e}
tr.kill_switch{background:#fff4e5}
</style></head><body>
<h1>${esc(o.title)}</h1>
<div class="meta">Signer <code>${esc(signer)}</code> · policy <code>${esc(short(policy))}</code> · Allowed ${String(counts.allowed)} · Blocked ${String(counts.blocked)} · Needs your OK ${String(counts.needs_ok)}</div>
<div class="status">${status}</div>
<table><thead><tr><th>#</th><th>UTC</th><th>kind</th><th>what</th><th>verdict / result</th><th>tx</th><th>receipt</th></tr></thead><tbody>
${receipts.map((r) => row(r, o)).join('\n')}
</tbody></table></body></html>
`;
}
