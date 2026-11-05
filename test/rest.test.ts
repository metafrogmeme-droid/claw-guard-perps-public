import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { runRest } from '../src/cli/rest.js';
import { Engine } from '../src/engine/engine.js';
import { DEMO_POLICY, parsePolicy, policyHash } from '../src/gate/policy.js';
import { usd } from '../src/gate/units.js';
import { RECEIPTS_ABI } from '../src/receipts/anchor.js';
import { Journal } from '../src/receipts/journal.js';
import { StopWatcher, type ReactivityTransport } from '../src/reactivity/watch.js';
import { SimVenue, simMarkets } from '../src/venue/index.js';
import { NOW } from './fixtures.js';

// anvil test key 0 (public, allowlisted in .gitleaks.toml)
const signer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const policy = parsePolicy(DEMO_POLICY);
const silent = (): void => undefined;
const tmp = async (n: string) => join(await mkdtemp(join(tmpdir(), 'cgp-rest-')), n);

describe('rest + on-chain stop (Reactivity demo, simulated)', () => {
  it('rests one allowed post-only bid; a Stopped push trips the kill switch and cancels it', async () => {
    const venue = new SimVenue(simMarkets(NOW), { collateral: usd('40'), now: () => NOW });
    const r = await runRest({
      venue,
      policy,
      journalPath: await tmp('rest.jsonl'),
      signer,
      now: () => NOW,
      log: silent,
      market: 'BTC-PERP',
      notional: usd('10.5'),
      offsetBps: 150,
    });
    expect(r).toMatchObject({ verdict: 'allowed', resting: 1 });

    const journal = await Journal.open(await tmp('watch.jsonl'), signer, policyHash(policy));
    const engine = new Engine({ venue, policy, journal, now: () => NOW });
    const transport: ReactivityTransport = {
      subscribe: (_p, h) => {
        h.onConnect();
        return Promise.resolve({ unsubscribe: () => Promise.resolve() });
      },
    };
    const w = new StopWatcher({
      transport,
      contract: '0xeda7071961c518ce154062cb6d8e94219f8c29b3',
      signer: signer.address,
      readStopped: () => Promise.resolve(false),
      onStop: () => engine.kill('on-chain stop'),
    });
    await w.start();
    w.push({
      address: '0xeda7071961c518ce154062cb6d8e94219f8c29b3',
      topics: encodeEventTopics({
        abi: RECEIPTS_ABI,
        eventName: 'Stopped',
        args: { signer: signer.address, journal: `0x${'11'.repeat(32)}` },
      }) as Hex[],
      data: encodeAbiParameters([{ type: 'uint64' }], [0n]),
      simulationResults: [encodeAbiParameters([{ type: 'bool' }], [true])],
    });
    await w.idle();
    const s = await engine.snapshot();
    expect(s.orders).toHaveLength(0);
    expect(journal.receipts.map((x) => x.kind)).toContain('kill_switch');
  });

  it('refuses an offset outside the price band', async () => {
    const venue = new SimVenue(simMarkets(NOW), { collateral: usd('40'), now: () => NOW });
    await expect(
      runRest({
        venue,
        policy,
        journalPath: await tmp('r.jsonl'),
        signer,
        now: () => NOW,
        log: silent,
        market: 'BTC-PERP',
        notional: usd('10.5'),
        offsetBps: policy.maxPriceDeviationBps,
      }),
    ).rejects.toThrow(/must be inside/);
    await expect(
      runRest({
        venue,
        policy,
        journalPath: await tmp('r2.jsonl'),
        signer,
        now: () => NOW,
        log: silent,
        market: 'NOPE-PERP',
        notional: usd('10.5'),
        offsetBps: 100,
      }),
    ).rejects.toThrow(/not listed/);
  });
});
