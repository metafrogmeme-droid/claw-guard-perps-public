// Exact unit handling for dreamDEX perps. Everything is bigint; no float ever touches a size or a price.
//
// dreamDEX rules (docs/developers/perps-testnet):
//   - price is raw quote units per WHOLE base asset, always 18 decimals (the collateral, USDso, has 18);
//   - quantity is raw base units, scaled by the market's OWN baseDecimals (6..24 across live markets);
//   - price must sit on tickSize, quantity on lotSize, and quantity >= minQuantity.
// A wrong scale does not fail loudly on-chain (0.1 SOL written with 18 decimals is 100,000,000 SOL and
// reverts as InsufficientCollateral), so the gate checks scale before anything is sent.

/** Decimals of every dreamDEX perp price and of USDso notional. */
export const PRICE_DECIMALS = 18;
export const ONE_USD = 10n ** 18n;

const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

/**
 * Parse a non-negative decimal string into raw units. Rejects (returns undefined) anything that would need
 * rounding, so "0.123" at 2 decimals is refused rather than silently truncated.
 */
export function parseDecimal(human: string, decimals: number): bigint | undefined {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return undefined;
  const m = DECIMAL_RE.exec(human.trim());
  if (!m) return undefined;
  const whole = m[1] ?? '0';
  const frac = (m[2] ?? '').replace(/0+$/, '');
  if (frac.length > decimals) return undefined;
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/** Raw units to an exact decimal string (no trailing zeros, no exponent). */
export function formatDecimal(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole.toString()}${frac ? `.${frac}` : ''}`;
}

/** True when value is a whole multiple of step (step must be positive). */
export function onGrid(value: bigint, step: bigint): boolean {
  if (step <= 0n) return false;
  return value % step === 0n;
}

/** Round DOWN to the grid (toward zero for non-negative values). */
export function floorToGrid(value: bigint, step: bigint): bigint {
  if (step <= 0n) throw new RangeError('step must be positive');
  return value - (value % step);
}

/**
 * Notional of an order in raw USDso (18 decimals): price (18 dp, per whole base) x quantity (base dp).
 * Rounded down; the gate compares notionals against caps, so rounding down never lets a cap be crossed by
 * more than one wei of USDso.
 */
export function notional(price: bigint, quantity: bigint, baseDecimals: number): bigint {
  return (price * quantity) / 10n ** BigInt(baseDecimals);
}

/** |a - b| / b in basis points, rounded up. b must be positive. */
export function deviationBps(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError('reference must be positive');
  const diff = a > b ? a - b : b - a;
  return (diff * 10_000n + b - 1n) / b;
}

/** Whole USD (as decimal string or number of USD) to raw 18-dp USDso. */
export function usd(amount: string | number): bigint {
  const raw = parseDecimal(typeof amount === 'number' ? String(amount) : amount, PRICE_DECIMALS);
  if (raw === undefined) throw new RangeError(`not a USD amount: ${String(amount)}`);
  return raw;
}
