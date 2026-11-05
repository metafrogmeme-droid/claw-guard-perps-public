// Turning venue failures into names. Pool reverts carry a custom-error name when the ABI knows it; otherwise
// the 4-byte selector is the only evidence, so keep it.

/** Known pool/bank error selectors that matter for an operator. */
export const KNOWN_SELECTORS: Readonly<Record<string, string>> = {
  '0x3a23d825': 'InsufficientCollateral',
  '0xd48c4403': 'ImmediateOrCancelNoFill',
  '0x714b36d6': 'MaxPositionSizeExceeded',
  // VoucherDistributor.claim() on Tokyo testnet; not in the SDK 0.32.1 error ABI.
  '0x3e31dcc2': 'SelfClaimDisabled',
};

/** Ordinary outcomes of a moving book: count as no-ops, not failures. */
export const BENIGN_ERRORS: ReadonlySet<string> = new Set(['ImmediateOrCancelNoFill', 'PostOnlyWouldCross']);

interface ErrLike {
  readonly errorName?: unknown;
  readonly data?: unknown;
  readonly message?: unknown;
  readonly shortMessage?: unknown;
  readonly cause?: unknown;
}

/** Walk an error and its causes for a custom-error name or a 4-byte selector. */
export function errorName(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (typeof cur === 'object' && cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as ErrLike;
    if (typeof e.errorName === 'string' && e.errorName !== '') return e.errorName;
    const data = typeof e.data === 'string' ? e.data : undefined;
    if (data !== undefined && /^0x[0-9a-fA-F]{8}/.test(data)) {
      const sel = data.slice(0, 10).toLowerCase();
      return KNOWN_SELECTORS[sel] ?? sel;
    }
    const text = [e.shortMessage, e.message].filter((t): t is string => typeof t === 'string').join(' ');
    const named =
      /reverted with the following reason:\s*\n?\s*([A-Z][A-Za-z0-9]+)|error\s+([A-Z][A-Za-z0-9]+)\(/.exec(
        text,
      );
    if (named !== null) return named[1] ?? named[2];
    for (const name of [...BENIGN_ERRORS, ...Object.values(KNOWN_SELECTORS)])
      if (text.includes(name)) return name;
    cur = e.cause;
  }
  return undefined;
}

export function errorText(err: unknown): string {
  if (err instanceof Error)
    return (err as ErrLike).shortMessage === undefined ? err.message : String((err as ErrLike).shortMessage);
  return String(err);
}
