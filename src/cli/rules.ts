// Session rules file (`session --rules <file.json>`): bot-side rules that can only make a session stricter.
// They never change the guard policy, the on-chain limits or the contracts. Every section is optional and
// falls back to conservative defaults; see docs/SESSION_RULES.md.
import { z } from 'zod';

import { DEFAULT_FLATTEN_RETRY, FlattenRetrySchema, type FlattenRetryConfig } from '../runtime/closeout.js';
import { DEFAULT_RPC_GATE, RpcGateSchema, type RpcGateConfig } from '../runtime/rpc-gate.js';

/** Top-level sections. Strategy sections (profit, cooldown) are read by the strategy rules loader. */
export const RULE_SECTIONS = ['rpcGate', 'flatten', 'profit', 'cooldown'] as const;

const TopLevel = z.object(Object.fromEntries(RULE_SECTIONS.map((k) => [k, z.unknown().optional()]))).strict();

export interface RuntimeRules {
  readonly rpcGate: RpcGateConfig;
  readonly flatten: FlattenRetryConfig;
}

export const DEFAULT_RUNTIME_RULES: RuntimeRules = {
  rpcGate: DEFAULT_RPC_GATE,
  flatten: DEFAULT_FLATTEN_RETRY,
};

export function parseRuntimeRules(input: unknown): RuntimeRules {
  const top = TopLevel.parse(input ?? {}) as Record<string, unknown>;
  return {
    rpcGate: RpcGateSchema.parse(top['rpcGate'] ?? {}),
    flatten: FlattenRetrySchema.parse(top['flatten'] ?? {}),
  };
}
