/** Omit zero to preserve fingerprints of launch requests created before optional buys. */
export function normalizeInitialBuyLamports(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    value.length > 16 ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new Error('Enter a valid initial buy amount in whole lamports.');
  return value === '0' ? undefined : value;
}
