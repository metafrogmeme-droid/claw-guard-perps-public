// A scripted agent that gets things wrong on purpose, one mistake per intent, so the demo shows each rule
// firing on a live market. Every intent is built from the current market row, so the only thing wrong with
// it is the named mistake.
import type { OrderIntent } from '../gate/types.js';
import type { VenueMarket } from '../venue/types.js';
import { quotePrice, quoteQuantity } from './strategy.js';

export interface ScriptedIntent {
  readonly label: string;
  /** The verdict this intent is written to get under the demo policy. */
  readonly expect: 'allowed' | 'blocked' | 'needs_ok';
  readonly intent: OrderIntent;
}

export function misbehavingScript(
  m: VenueMarket,
  quoteNotional: bigint,
  agent = 'scripted-agent',
): ScriptedIntent[] {
  const bid = quotePrice(m, true, 50);
  const q = quoteQuantity(m, bid, quoteNotional);
  const base: OrderIntent = {
    market: m.market,
    side: 'long',
    orderType: 'post_only',
    price: bid,
    quantity: q,
    reduceOnly: false,
    agent,
  };
  const script: ScriptedIntent[] = [
    { label: 'market not on the allowlist', expect: 'blocked', intent: { ...base, market: 'DOGE-PERP' } },
    {
      label: 'quantity written in 18 decimals instead of the market decimals',
      expect: 'blocked',
      intent: { ...base, assumedBaseDecimals: m.baseDecimals === 18 ? 8 : 18, quantity: q * 10n ** 10n },
    },
    { label: 'order ten times the per-order cap', expect: 'blocked', intent: { ...base, quantity: q * 10n } },
    {
      label: 'limit price 10% away from the mark',
      expect: 'blocked',
      intent: { ...base, price: quotePrice(m, true, 1000) },
    },
    {
      label: 'claims reduce-only with no position',
      expect: 'blocked',
      intent: { ...base, side: 'short', price: quotePrice(m, false, 50), reduceOnly: true },
    },
    {
      label: 'taker order inside every cap',
      expect: 'needs_ok',
      intent: { ...base, orderType: 'ioc', price: quotePrice(m, false, 50) },
    },
    { label: 'passive quote inside every cap', expect: 'allowed', intent: base },
  ];
  if (m.tickSize > 1n) {
    script.splice(5, 0, {
      label: 'price off the tick grid',
      expect: 'blocked',
      intent: { ...base, price: bid + m.tickSize / 2n },
    });
  }
  return script;
}
