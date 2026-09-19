import { useState } from 'react';
import { BrandLogo } from './components';
import { verifiedRecipientProfile } from './donation-recipient-data';
import type { RecipientProfile } from './donation-recipient-data';
import './donation-recipient.css';

function RecipientPortrait({ source, username }: { source: string; username: string }) {
  const [failed, setFailed] = useState(false);
  return source && !failed ? (
    <img
      className="dr-photo"
      src={source}
      alt={`@${username} profile picture`}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  ) : (
    <span className="dr-initials" aria-label={`@${username} profile picture unavailable`}>
      {username.slice(0, 2).toUpperCase()}
    </span>
  );
}

export function DonationRecipient({
  platform,
  username,
  profile,
  label = 'Gift sent to',
  compact = false,
}: {
  platform: 'twitch' | 'kick';
  username: string;
  profile?: RecipientProfile | null;
  label?: string;
  compact?: boolean;
}) {
  const verified = verifiedRecipientProfile(platform, username, profile);
  const platformName = platform === 'kick' ? 'Kick' : 'Twitch';
  const channelUrl = `https://${platform === 'kick' ? 'kick.com' : 'www.twitch.tv'}/${encodeURIComponent(username)}`;
  const displayName = verified?.displayName;
  return (
    <a
      className={`dr-recipient${compact ? ' dr-compact' : ''}`}
      href={channelUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Visit @${username} on ${platformName}`}
    >
      <span className="dr-portrait">
        <RecipientPortrait
          key={`${platform}:${username}:${verified?.imageUrl ?? ''}`}
          source={verified?.imageUrl ?? ''}
          username={username}
        />
        <span className="dr-platform-badge" aria-hidden="true">
          <BrandLogo brand={platform} />
        </span>
      </span>
      <span className="dr-copy">
        <span className="dr-label">{label}</span>
        <strong className="dr-username">@{username}</strong>
        <span className="dr-platform">
          {displayName && displayName.toLowerCase() !== username.toLowerCase() && (
            <>{displayName} · </>
          )}
          {platformName}
        </span>
      </span>
    </a>
  );
}
