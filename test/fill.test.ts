import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { runFill, takerPrice } from '../src/cli/fill.js';
import { DEMO_POLICY, parsePolicy } from '../src/gate/policy.js';
import { usd } from '../src/gate/units.js';
import { readJournal } from '../src/receipts/journal.js';
import { SimVenue, simMarkets } from '../src/venue/index.js';
import type { PlaceResult, VenueMarket } from '../src/venue/types.js';
import type { OrderIntent } from '../src/gate/types.js';
import { NOW } from './fixtures.js';

// anvil test key 0 (public, allowlisted in .gitleaks.toml)
const signer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const policy = parsePolicy(DEMO_POLICY);
const silent = (): void => undefined;

async function run(
  approve: boolean,
  venue = new SimVenue(simMarkets(NOW), { collateral: usd('40'), now: () => NOW }),
) {
  const path = join(await mkdtemp(join(tmpdir(), 'cgp-fill-')), 'f.jsonl');
  const asked: string[] = [];
  const r = await runFill({
    venue,
    policy,
    journalPath: path,
    signer,
    now: () => NOW,
    log: silent,
    approve: (_i, d) => {
      asked.push(d.message);
      return Promise.resolve(approve);
    },
    market: 'BTC-PERP',
    notional: usd('10.5'),
  });
  return { r, venue, asked, receipts: await readJournal(path) };
}

describe('fill proof', () => {
  it('asks the owner once, fills the taker order, closes reduce-only and ends flat', async () => {
    const { r, venue, asked, receipts } = await run(true);
    expect(asked).toEqual(['Needs your OK: TAKER_ORDER']);
    expect(r.open).toMatchObject({ verdict: 'needs_ok', ownerOk: true, sent: true, ok: true });
    expect(r.open.filled).toBeGreaterThan(0n);
    expect(r.close).toMatchObject({ verdict: 'allowed', sent: true, ok: true, filled: r.open.filled });
    expect(r.flat).toBe(true);
    expect(r.killSwitchUsed).toBe(false);
    expect(r.check.ok).toBe(true);
    expect(venue.fills.map((f) => f.isBid)).toEqual([true, false]);
    const decisions = receipts.filter((x) => x.kind === 'decision');
    expect(decisions.map((d) => [d.data['verdict'], d.data['ownerOk']])).toEqual([
      ['needs_ok', true],
      ['allowed', undefined],
    ]);
    const close = decisions[1]?.data['intent'] as Record<string, unknown>;
    expect(close['reduceOnly']).toBe(true);
    expect(close['side']).toBe('short');
  });

  it('sends nothing when the owner says no, and records the no', async () => {
    const { r, venue, receipts } = await run(false);
    expect(r.open).toMatchObject({ verdict: 'needs_ok', ownerOk: false, sent: false, filled: 0n });
    expect(r.close).toBeUndefined();
    expect(r.flat).toBe(true);
    expect(venue.fills).toHaveLength(0);
    expect(receipts.filter((x) => x.kind === 'execution')).toHaveLength(0);
    expect(receipts[0]?.data['ownerOk']).toBe(false);
  });

  it('refuses to start unless the account is flat', async () => {
    const venue = new SimVenue(simMarkets(NOW), { collateral: usd('40'), now: () => NOW });
    const m = venue.market('BTC-PERP');
    await venue.place(m, {
      market: 'BTC-PERP',
      side: 'long',
      orderType: 'post_only',
      price: m.markPrice - 10n * m.tickSize,
      quantity: m.minQuantity,
      reduceOnly: false,
      agent: 't',
    });
    await expect(run(true, venue)).rejects.toThrow(/not flat/);
  });

  it('flattens through the kill switch when the close does not fill', async () => {
    class NoCloseVenue extends SimVenue {
      private n = 0;
      override place(m: VenueMarket, i: OrderIntent): Promise<PlaceResult> {
        this.n += 1;
        if (this.n === 2)
          return Promise.resolve({
            ok: false,
            filled: 0n,
            errorName: 'ImmediateOrCancelNoFill',
            benign: true,
          });
        return super.place(m, i);
      }
    }
    const venue = new NoCloseVenue(simMarkets(NOW), { collateral: usd('40'), now: () => NOW });
    const { r, receipts } = await run(true, venue);
    expect(r.close).toMatchObject({ sent: true, ok: false, error: 'ImmediateOrCancelNoFill' });
    expect(r.killSwitchUsed).toBe(true);
    expect(r.flat).toBe(true);
    expect(receipts.some((x) => x.kind === 'kill_switch')).toBe(true);
  });
});

describe('takerPrice', () => {
  const [btc] = simMarkets(NOW);
  if (btc === undefined) throw new Error('fixture');
  it('buys a little above the best ask and sells a little below the best bid, on the grid', () => {
    const top = { bestBid: btc.markPrice - btc.tickSize, bestAsk: btc.markPrice + btc.tickSize };
    const buy = takerPrice(btc, true, top, policy, 10);
    const sell = takerPrice(btc, false, top, policy, 10);
    expect(buy % btc.tickSize).toBe(0n);
    expect(sell % btc.tickSize).toBe(0n);
    expect(buy).toBeGreaterThanOrEqual(top.bestAsk);
    expect(sell).toBeLessThanOrEqual(top.bestBid);
    expect(buy - btc.markPrice).toBeLessThan((btc.markPrice * 20n) / 10_000n);
  });
  it('never prices past the policy deviation limit, even on a thin book', () => {
    const far = { bestAsk: btc.markPrice * 2n, bestBid: btc.markPrice / 2n };
    const cap = BigInt(policy.maxPriceDeviationBps);
    const buy = takerPrice(btc, true, far, policy, 10);
    const sell = takerPrice(btc, false, far, policy, 10);
    expect(buy).toBeLessThanOrEqual((btc.markPrice * (10_000n + cap)) / 10_000n);
    expect(sell).toBeGreaterThanOrEqual((btc.markPrice * (10_000n - cap)) / 10_000n);
  });
  it('falls back to the mark when the book is empty', () => {
    expect(takerPrice(btc, true, undefined, policy, 0)).toBe(btc.markPrice);
  });
});
