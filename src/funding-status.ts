import type { FinancialMetrics, Streamer } from './data';

/** Explain a new funding wait only while the public offline observation is current. */
export function fundingWaitMessage(
  metrics: Pick<FinancialMetrics, 'pendingUsdCents'>,
  streamer: Pick<
    Streamer,
    'name' | 'platform' | 'liveStatus' | 'liveCheckedAt' | 'nextLiveCheckAt'
  >,
  now = Date.now(),
): { summary: string; detail: string } | null {
  const checkedAt = streamer.liveCheckedAt ? Date.parse(streamer.liveCheckedAt) : NaN;
  const nextCheckAt = streamer.nextLiveCheckAt ? Date.parse(streamer.nextLiveCheckAt) : NaN;
  if (
    !Number.isSafeInteger(metrics.pendingUsdCents) ||
    Number(metrics.pendingUsdCents) <= 0 ||
    !['twitch', 'kick'].includes(streamer.platform) ||
    streamer.liveStatus !== 'offline' ||
    !Number.isFinite(now) ||
    !Number.isFinite(checkedAt) ||
    !Number.isFinite(nextCheckAt) ||
    checkedAt > now ||
    nextCheckAt <= now
  )
    return null;
  return {
    summary: `Next gift paused: ${streamer.name} is offline.`,
    detail:
      'Gifts wait for a verified live stream. Funds remain allocated to their original tokens; all other payment checks still apply.',
  };
}
