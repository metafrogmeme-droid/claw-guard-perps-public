// Market rows for the simulated venue, copied from Somnia Tokyo testnet on 1 Nov 2026 (grid, decimals,
// initial margin, mark). Pools are placeholders.
import type { VenueMarket } from './types.js';

const bank = '0x478769e1177c0773c43a593dccc4ad15f15f1394';

export function simMarkets(now: number): VenueMarket[] {
  return [
    {
      market: 'BTC-PERP',
      pool: '0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0',
      marginBank: bank,
      baseDecimals: 8,
      tickSize: 10n ** 17n,
      lotSize: 1000n,
      minQuantity: 13000n,
      markPrice: 77_917_200_000_000_000_000_000n,
      markUpdatedAt: now,
      initialMarginBps: 500,
    },
    {
      market: 'ETH-PERP',
      pool: '0xd6cb1dd58580b84d76068ac21594219ce03aeddf',
      marginBank: bank,
      baseDecimals: 18,
      tickSize: 10n ** 16n,
      lotSize: 10n ** 14n,
      minQuantity: 4n * 10n ** 15n,
      markPrice: 2_264_800_000_000_000_000_000n,
      markUpdatedAt: now,
      initialMarginBps: 500,
    },
    {
      market: 'SOL-PERP',
      pool: '0xb483ec1fb34996638677c20ab087b16f1896fa53',
      marginBank: bank,
      baseDecimals: 9,
      tickSize: 10n ** 16n,
      lotSize: 10n ** 7n,
      minQuantity: 10n ** 8n,
      markPrice: 94_610_000_000_000_000_000n,
      markUpdatedAt: now,
      initialMarginBps: 500,
    },
  ];
}
