import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'scripts/**/*.test.mjs'],
    // CI rule: no network. The global fetch always rejects; chain access is behind the Venue interface.
    setupFiles: ['./test-setup/no-network.ts'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Network adapters and CLI entry points are exercised by the live runs recorded in docs/PROOF.md.
      exclude: ['src/venue/dreamdex.ts', 'src/receipts/anchor-viem.ts', 'src/cli/main.ts', 'src/cli/env.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 95, branches: 90, functions: 95, statements: 95 },
    },
  },
});
