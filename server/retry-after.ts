/** Normalize upstream retry timing without forwarding arbitrary header text. */
export function retryAfterSeconds(value: string | null, now = Date.now()): number {
  const seconds =
    value && /^\d+$/.test(value) ? Number(value) : value ? (Date.parse(value) - now) / 1000 : NaN;
  // Keep browser timers within their signed 32-bit millisecond range.
  return Number.isFinite(seconds) ? Math.max(1, Math.min(2_147_483, Math.ceil(seconds))) : 30;
}
