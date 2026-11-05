// Strategy sections of the session rules file (`session --rules <file.json>`): profit (rule 2) and cooldown
// (rule 3). The runtime sections (rpcGate, flatten) are read by the runtime rules loader; this one
// accepts their names so a single file serves both, and refuses anything else. See docs/STRATEGY_RULES.md.
import { z } from 'zod';

import { CooldownSchema, DEFAULT_COOLDOWN, type CooldownConfig } from './cooldown.js';
import { DEFAULT_PROFIT_RULES, ProfitRulesSchema, type ProfitRules } from './profit-rules.js';

export const RULE_FILE_SECTIONS = ['rpcGate', 'flatten', 'profit', 'cooldown'] as const;

const TopLevel = z
  .object(Object.fromEntries(RULE_FILE_SECTIONS.map((k) => [k, z.unknown().optional()])))
  .strict();

export interface StrategyRules {
  readonly profit: ProfitRules;
  readonly cooldown: CooldownConfig;
}

export const DEFAULT_STRATEGY_RULES: StrategyRules = {
  profit: DEFAULT_PROFIT_RULES,
  cooldown: DEFAULT_COOLDOWN,
};

export function parseStrategyRules(input: unknown): StrategyRules {
  const top = TopLevel.parse(input ?? {}) as Record<string, unknown>;
  return {
    profit: ProfitRulesSchema.parse(top['profit'] ?? {}),
    cooldown: CooldownSchema.parse(top['cooldown'] ?? {}),
  };
}
