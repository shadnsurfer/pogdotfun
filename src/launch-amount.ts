/** Convert the optional SOL input without losing precision through floating point arithmetic. */
export function parseInitialBuySol(value: string): string {
  const input = value.trim();
  if (!input) return '0';
  if (!/^(?:\d+(?:\.\d{0,9})?|\.\d{1,9})$/.test(input))
    throw new Error('Enter a SOL amount of 0 or more with up to 9 decimal places.');
  const [whole, fraction = ''] = input.split('.');
  const lamports = BigInt(whole || '0') * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'));
  if (lamports > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('This SOL amount is too large. Enter a smaller dev buy.');
  return lamports.toString();
}
