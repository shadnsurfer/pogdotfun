/** Availability gates new work only. Historical records and reconciliation retain their platform. */
export function isRecipientPlatformEnabled(platform: unknown): boolean {
  return platform === 'twitch' || platform === 'kick';
}
