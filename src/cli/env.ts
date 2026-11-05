// Reads the bot key and settings from the environment or a KEY=VALUE file (default
// ~/.config/claw-guard-perps/env). Values are never echoed.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_ENV_FILE = join(homedir(), '.config', 'claw-guard-perps', 'env');

export function loadEnv(file?: string): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...process.env };
  const path = file ?? DEFAULT_ENV_FILE;
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n]*)"?\s*$/.exec(line);
      if (m?.[1] !== undefined && out[m[1]] === undefined) out[m[1]] = m[2];
    }
  } else if (file !== undefined) {
    throw new Error(`env file ${file} not found`);
  }
  return out;
}

export function privateKeyFrom(env: Readonly<Record<string, string | undefined>>): `0x${string}` {
  const k = env['PRIVATE_KEY'];
  if (k === undefined || !/^0x[0-9a-fA-F]{64}$/.test(k)) {
    throw new Error('PRIVATE_KEY is missing or not a 32-byte hex key (use a throwaway testnet key).');
  }
  return k as `0x${string}`;
}

export function ownerFrom(env: Readonly<Record<string, string | undefined>>): `0x${string}` | undefined {
  const a = env['OWNER_ADDRESS'];
  if (a === undefined || a === '') return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error('OWNER_ADDRESS is not an address.');
  return a as `0x${string}`;
}
