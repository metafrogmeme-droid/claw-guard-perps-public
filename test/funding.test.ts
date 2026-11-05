import { describe, expect, it } from 'vitest';

import { MIN_GAS_WEI, errorName, fundingPlan, type FundingFacts } from '../src/venue/index.js';

const base: FundingFacts = {
  mode: 'own-account',
  account: '0x39791a9Df0bb96EBaEEaE2C6754bB76EbD09C67D',
  sender: '0x39791a9Df0bb96EBaEEaE2C6754bB76EbD09C67D',
  gas: 10n ** 18n,
  equity: 0n,
  voucher: { kind: 'off' },
};
const codes = (f: FundingFacts) => fundingPlan(f).steps.map((s) => s.code);

describe('fundingPlan', () => {
  it('is ready with gas and margin', () => {
    const p = fundingPlan({ ...base, equity: 1n });
    expect(p).toEqual({ ready: true, canClaim: false, steps: [] });
  });
  it('asks for gas below the floor, at the floor it is enough', () => {
    expect(codes({ ...base, equity: 1n, gas: MIN_GAS_WEI - 1n })).toEqual(['LOW_GAS']);
    expect(codes({ ...base, equity: 1n, gas: MIN_GAS_WEI })).toEqual([]);
  });
  it('offers a claim only when the preflight passed in own-account mode', () => {
    const v = { kind: 'eligible', grant: 10n ** 21n, preflight: 'ok' } as const;
    const p = fundingPlan({ ...base, voucher: v });
    expect(p.canClaim).toBe(true);
    expect(p.steps.map((s) => s.code)).toEqual(['CLAIM_VOUCHER']);
    expect(fundingPlan({ ...base, mode: 'linked-bot-key', voucher: v }).canClaim).toBe(false);
  });
  it('names SelfClaimDisabled and points at the app link', () => {
    const p = fundingPlan({
      ...base,
      voucher: { kind: 'eligible', grant: 1n, preflight: 'SelfClaimDisabled' },
    });
    expect(p.canClaim).toBe(false);
    expect(p.steps[0]?.code).toBe('SELF_CLAIM_DISABLED');
    expect(p.steps[0]?.text).toContain('Link a Bot with 0x39791a9Df0bb96EBaEEaE2C6754bB76EbD09C67D');
  });
  it('reports any other failed preflight', () => {
    expect(codes({ ...base, voucher: { kind: 'eligible', grant: 1n, preflight: '0xdeadbeef' } })).toEqual([
      'CLAIM_PREFLIGHT_FAILED',
    ]);
  });
  it('falls back to a top-up when no voucher can be claimed', () => {
    for (const voucher of [
      { kind: 'off' },
      { kind: 'claimed' },
      { kind: 'ineligible', reason: 'notFlat' },
    ] as const) {
      expect(codes({ ...base, voucher })).toEqual(['NO_MARGIN']);
    }
    const linked = fundingPlan({
      ...base,
      mode: 'linked-bot-key',
      account: '0x00000000000000000000000000000000000000aa',
    });
    expect(linked.steps[0]?.text).toContain(
      'top up the Perps account of 0x00000000000000000000000000000000000000aa',
    );
  });
  it('lists gas and margin together', () => {
    expect(codes({ ...base, gas: 0n })).toEqual(['LOW_GAS', 'NO_MARGIN']);
  });
});

describe('errorName', () => {
  it('names the distributor revert', () => {
    expect(errorName({ data: '0x3e31dcc2' })).toBe('SelfClaimDisabled');
    expect(errorName({ cause: { data: '0x3E31DCC2' } })).toBe('SelfClaimDisabled');
  });
});
