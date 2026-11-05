// Read-only recorder: mark price and top of book for the policy markets, one JSON line per market per tick.
// Sends no transactions. Usage: tsx scripts/record-market.ts --env <file> --out data/x.jsonl --seconds 9000 --every 10
import { appendFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { loadEnv, ownerFrom, privateKeyFrom } from '../src/cli/env.js';
import { DreamdexVenue } from '../src/venue/dreamdex.js';
import { resolveNetwork } from '../src/venue/network.js';

const { values } = parseArgs({
  options: {
    env: { type: 'string' },
    out: { type: 'string', default: 'data/market.jsonl' },
    seconds: { type: 'string', default: '3600' },
    every: { type: 'string', default: '10' },
    markets: { type: 'string', default: 'BTC-PERP,ETH-PERP,SOL-PERP' },
  },
});
const env = loadEnv(values.env);
const owner = ownerFrom(env);
const now = (): number => Math.floor(Date.now() / 1000);
const names = values.markets.split(',');
const end = now() + Number(values.seconds);
const v = await DreamdexVenue.create({
  privateKey: privateKeyFrom(env),
  network: resolveNetwork(env),
  now,
  ...(owner === undefined ? {} : { owner }),
});
const t = <T>(p: Promise<T>, ms = 20_000): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, r) =>
      setTimeout(() => {
        r(new Error('timeout'));
      }, ms),
    ),
  ]);
while (now() < end) {
  const ts = now();
  try {
    const s = await t(v.snapshot(names));
    for (const m of Object.values(s.markets)) {
      let top: { bestBid?: bigint; bestAsk?: bigint } | undefined;
      try {
        top = await t(v.bookTop(m));
      } catch {
        top = undefined;
      }
      const line = {
        ts,
        market: m.market,
        mark: m.markPrice.toString(),
        bid: top?.bestBid?.toString(),
        ask: top?.bestAsk?.toString(),
      };
      await appendFile(values.out, JSON.stringify(line) + '\n');
    }
  } catch (e) {
    await appendFile(
      values.out,
      JSON.stringify({ ts, error: e instanceof Error ? e.message : String(e) }) + '\n',
    );
  }
  await new Promise((r) => setTimeout(r, Number(values.every) * 1000));
}
await v.close();
process.exit(0);
