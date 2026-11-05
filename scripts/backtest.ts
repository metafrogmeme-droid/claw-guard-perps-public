// Backtest CLI: tsx scripts/backtest.ts <candles.json> [--strategy band|skew] [--config file.json] [--penalty 1] [--fee 0]
//   [--rules session-rules.json] [--no-rules] [--session-hours 1]
// The session rules (profit and cooldown sections) apply by default with their defaults; --no-rules replays the #22 maker
// without them (before/after comparison).
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { privateKeyToAccount } from 'viem/accounts';

import { replay, type Candle, type StrategyChoice } from '../src/backtest/replay.js';
import { skewProfitFields } from '../src/engine/profit-rules.js';
import { parseStrategyRules } from '../src/engine/strategy-rules.js';
import { DEFAULT_SKEW } from '../src/engine/skew-maker.js';
import { parsePolicy, SESSION_POLICY } from '../src/gate/policy.js';
import { usd } from '../src/gate/units.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    strategy: { type: 'string', default: 'skew' },
    config: { type: 'string' },
    penalty: { type: 'string', default: '1' },
    fee: { type: 'string', default: '0' },
    from: { type: 'string' },
    to: { type: 'string' },
    rules: { type: 'string' },
    'no-rules': { type: 'boolean', default: false },
    'session-hours': { type: 'string' },
  },
});
const file = positionals[0];
if (file === undefined) throw new Error('usage: backtest <candles.json>');
const all = JSON.parse(await readFile(file, 'utf8')) as Record<string, Candle[]>;
const lo = values.from === undefined ? -Infinity : Number(values.from);
const hi = values.to === undefined ? Infinity : Number(values.to);
const candles = Object.fromEntries(
  Object.entries(all).map(([k, v]) => [
    k,
    v.filter((c) => Number(c.bucketStart) >= lo && Number(c.bucketStart) < hi),
  ]),
);
const extra =
  values.config === undefined
    ? {}
    : (JSON.parse(await readFile(values.config, 'utf8')) as Record<string, number>);
const { profit, cooldown } = parseStrategyRules(
  values.rules === undefined ? {} : (JSON.parse(await readFile(values.rules, 'utf8')) as unknown),
);
// --no-rules: the #22 maker as it was (no edge floor, take-profit, loss stop, maker-only filter or cooldown)
const before = { makerFeeBps: 0, minEdgeBps: 0, takeProfitBps: 0 };
const strategy: StrategyChoice =
  values.strategy === 'band'
    ? { kind: 'band', bandBps: extra['bandBps'] ?? 60, quoteNotional: usd('10.5') }
    : {
        kind: 'skew',
        cfg: {
          ...DEFAULT_SKEW,
          ...(values['no-rules'] ? before : skewProfitFields(profit)),
          ...extra,
          quoteNotional: usd(String(extra['quoteUsd'] ?? '10.5')),
          maxInventoryNotional: usd(String(extra['maxInventoryUsd'] ?? '30')),
        },
      };
// anvil test key 0 (public): signs the in-memory replay journal only
const signer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const r = await replay({
  candles,
  policy: parsePolicy(SESSION_POLICY),
  strategy,
  signer,
  penaltyTicks: Number(values.penalty),
  feeBps: Number(values.fee),
  ...(values['no-rules'] ? {} : { profit, cooldown }),
  ...(values['session-hours'] === undefined ? {} : { sessionSec: Number(values['session-hours']) * 3600 }),
});
console.log(JSON.stringify(r));
