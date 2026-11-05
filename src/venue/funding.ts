// Funding check for a live run: is there gas, is there margin, and if not, what is the next step.
// Pure: the dreamDEX adapter reads the chain and hands the facts in.
import type { VenueMode } from './types.js';

/** Testnet perp transactions measured 0.0003 to 0.003 STT; keep room for a full demo plus a kill. */
export const MIN_GAS_WEI = 50_000_000_000_000_000n; // 0.05 STT

export type VoucherFact =
  | { readonly kind: 'off' }
  | { readonly kind: 'claimed' }
  | { readonly kind: 'ineligible'; readonly reason: string }
  /** Eligibility says yes; `preflight` is 'ok' or the revert a simulated claim() from this key returned. */
  | { readonly kind: 'eligible'; readonly grant: bigint; readonly preflight: string };

export interface FundingFacts {
  readonly mode: VenueMode;
  readonly account: `0x${string}`;
  readonly sender: `0x${string}`;
  readonly gas: bigint;
  readonly equity: bigint;
  readonly voucher: VoucherFact;
}

export interface FundingStep {
  readonly code: string;
  readonly text: string;
}

export interface FundingPlan {
  /** True when a live demo can place orders now. */
  readonly ready: boolean;
  /** True when `claw-guard fund --yes` would claim the voucher (the preflight passed). */
  readonly canClaim: boolean;
  readonly steps: readonly FundingStep[];
}

export function fundingPlan(f: FundingFacts, minGas: bigint = MIN_GAS_WEI): FundingPlan {
  const steps: FundingStep[] = [];
  if (f.gas < minGas) {
    steps.push({
      code: 'LOW_GAS',
      text: `send STT for gas to ${f.sender} (Tokyo faucet or dreamDEX app "Send it")`,
    });
  }
  let canClaim = false;
  if (f.equity <= 0n) {
    const v = f.voucher;
    if (v.kind === 'eligible' && v.preflight === 'ok' && f.mode === 'own-account') {
      canClaim = true;
      steps.push({ code: 'CLAIM_VOUCHER', text: 'claim the paper USDso voucher: claw-guard fund --yes' });
    } else if (v.kind === 'eligible' && v.preflight === 'SelfClaimDisabled') {
      steps.push({
        code: 'SELF_CLAIM_DISABLED',
        text:
          'the voucher distributor refuses direct claims (SelfClaimDisabled). In the dreamDEX app: join ' +
          `Perps Arena, then Link a Bot with ${f.sender} and run with OWNER_ADDRESS set to the app wallet`,
      });
    } else if (v.kind === 'eligible' && v.preflight !== 'ok') {
      steps.push({ code: 'CLAIM_PREFLIGHT_FAILED', text: `a claim would revert: ${v.preflight}` });
    } else {
      steps.push({
        code: 'NO_MARGIN',
        text:
          f.mode === 'linked-bot-key'
            ? `top up the Perps account of ${f.account} in the dreamDEX app`
            : `no USDso margin in ${f.account}; link this key to a funded dreamDEX app wallet`,
      });
    }
  }
  return { ready: steps.length === 0, canClaim, steps };
}
