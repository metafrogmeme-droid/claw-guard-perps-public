// Messages about the on-chain stop (ClawGuardReceipts.isStopped). Pure, so they can be tested.

/** Preflight refusal while the signer's on-chain stop is on, with the command that clears it. */
export function stoppedMessage(signer: string, envPath?: string): string {
  const env = envPath === undefined ? '' : ` --env ${envPath}`;
  return (
    `Blocked by your rule: the on-chain stop is on for ${signer}. ` +
    `Needs your OK: re-arm with \`pnpm cli rearm <stop-journal.jsonl>${env}\` (the journal whose kill receipt was anchored), then run doctor again.`
  );
}

/** What `kill` prints about the on-chain stop. The local kill only stops on chain once its journal is anchored. */
export function killStopLine(stopped: boolean): string {
  return stopped
    ? 'on-chain stop: ON (isStopped = true). Live runs are blocked until a re-arm.'
    : 'on-chain stop: OFF (isStopped = false). Anchoring this kill journal will turn it ON; the next live run then needs a re-arm.';
}
