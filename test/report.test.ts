// Machine session report: written next to the summary at the end of every session.
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { cetTime, renderSessionReport } from '../src/cli/report.js';

describe('session report', () => {
  it('renders the 4 Nov daily summary with times in CET', async () => {
    const summary: unknown = JSON.parse(
      await readFile(new URL('./fixtures/session-summary-2026-11-04.json', import.meta.url), 'utf8'),
    );
    const md = renderSessionReport(summary, { name: 'session-daily-2026-11-04', commit: 'abc1234' });
    expect(md).toContain('# session-daily-2026-11-04');
    expect(md).toContain('(commit abc1234)');
    expect(md).toContain('| Result | done, flat |');
    expect(md).toContain('| Started | 2026-11-04 14:12:44 CET |');
    expect(md).toContain('| Stop reason | time is up |');
    expect(md).toContain('| Watchdog | not fired |');
    expect(md).toContain('| Session P&L (USDso) | 0.058820134302166337 |');
    expect(md).toContain('| Receipts | 70 (chain check ok) |');
    expect(md).toContain('| Anchored batches | 9 |');
    expect(md).toContain('| RPC pauses / outage | 1 / 27 s |');
    expect(md).toContain('MARKET_NOT_ALLOWED 1');
    expect(md.endsWith('\n')).toBe(true);
  });

  it('shows NOT flat, the watchdog reason, clock jumps and close-out errors', () => {
    const md = renderSessionReport(
      {
        flat: false,
        watchdogFired: true,
        watchdogReason: 'loop stalled: no progress for 950 s',
        clockJumps: { count: 1, maxSec: 4468 },
        closeOut: { positions: { 'BTC-PERP': '-28000' }, errors: ['cancel reverted'] },
      },
      { name: 'x' },
    );
    expect(md).toContain('done, NOT flat: run `pnpm cli kill`');
    expect(md).toContain('| Watchdog | fired (loop stalled: no progress for 950 s) |');
    expect(md).toContain('| Clock jumps (box paused) | 1, largest 4468 s |');
    expect(md).toContain('positions BTC-PERP -28000');
    expect(md).toContain('## Close-out errors');
    expect(md).toContain('- cancel reverted');
    expect(md).toContain('| Started | n/a |');
  });

  it('tolerates an empty or odd summary', () => {
    const md = renderSessionReport(null, { name: 'empty' });
    expect(md).toContain('| Cycles | 0 |');
    expect(md).toContain('| Blocked codes | none |');
    expect(renderSessionReport([], { name: 'arr' })).toContain('| Stop reason | n/a |');
  });

  it('cetTime uses Europe/Amsterdam (CET in winter, CEST in summer)', () => {
    expect(cetTime(1793797964)).toBe('2026-11-04 14:12:44 CET');
    expect(cetTime(1783000000)).toMatch(/ CEST$/);
  });
});
