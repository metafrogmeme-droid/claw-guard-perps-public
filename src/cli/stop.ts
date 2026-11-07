// Messages about the on-chain stop (ClawGuardReceipts.isStopped). Pure, so they can be tested.

/** Preflight refusal while the signer's on-chain stop is on, with the command that clears it. */
export function stoppedMessage(signer: string, envPath?: string): string {
  const env = envPath === undefined ? '' : ` --env ${envPath}`;
  return (
    `Blocked by your rule: the on-chain stop is on for ${signer}. ` +
    `Needs your OK: re-arm with \`pnpm cli rearm <stop-journal.jsonl>${env}\` (the journal whose kill receipt was anchored), then run doctor again.`
  );
}

/** What `kill` prints about the account it just tried to flatten. Flat is a fresh read, not the plan. */
export function killAccountLine(orders: number, positions: number, flat: boolean): string {
  const head = `kill switch on. open orders ${String(orders)}, positions ${String(positions)}`;
  return flat ? `${head}. account confirmed flat` : `${head}. NOT flat`;
}

/**
 * What `kill` prints about the on-chain stop. The local kill only stops on chain once its journal is anchored.
 * `flat` is the account read after the reduce. Anchoring while a position remains still stops the chain;
 * a re-arm does not close that position.
 */
export function killStopLine(stopped: boolean, flat = true): string {
  if (stopped) {
    return flat
      ? 'on-chain stop: ON (isStopped = true). Live runs are blocked until a re-arm.'
      : 'on-chain stop: ON (isStopped = true). The account is NOT flat. Live runs are blocked until a re-arm, and a re-arm does not remove the residual position.';
  }
  return flat
    ? 'on-chain stop: OFF (isStopped = false). Anchoring this kill journal will turn it ON; the next live run then needs a re-arm.'
    : 'on-chain stop: OFF (isStopped = false). The account is NOT flat. Anchoring this kill journal would turn the stop ON while a position remains; a re-arm does not remove that position.';
}
