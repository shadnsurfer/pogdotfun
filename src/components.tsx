import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { motion, useReducedMotion } from 'motion/react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  ArrowDownLeft,
  Check,
  ChevronRight,
  Heart,
  Radio,
  X,
  TrendingUp,
  Copy,
  ChevronDown,
} from './icons';
import type { Launchpad, Sort, Streamer, Token } from './data';
import { decimalMoney, getStreamer, money, padName, tokenDonations } from './data';
import { TokenImage } from './TokenImage';
import { fundingWaitMessage } from './funding-status';
import { UnclaimedFees } from './UnclaimedFees';

export function Brand({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand ${small ? 'brand-small' : ''}`}>
      <span
        aria-label="POG"
        style={{ fontWeight: 900, fontSize: small ? 22 : 32, letterSpacing: '-0.06em' }}
      >
        POG
      </span>
    </span>
  );
}
const brandPaths: Record<string, string> = {
  twitch: 'twitch.svg',
  kick: 'kick.svg',
  x: 'x.svg',
  pump: 'pump.png',
  pons: 'pons.png',
  flap: 'bnbchain.svg',
  solana: 'solana.svg',
  robinhood: 'robinhood.svg',
};
export function BrandLogo({ brand, className = '' }: { brand: string; className?: string }) {
  return (
    <img
      className={`brand-logo brand-${brand} ${className}`}
      src={`/assets/brands/${brandPaths[brand] ?? brand + '.svg'}`}
      alt={
        brand === 'pump'
          ? 'Pump.fun'
          : brand === 'pons'
            ? 'PONs'
            : brand === 'flap'
              ? 'Flap'
              : brand
      }
      draggable={false}
    />
  );
}
export function PlatformMark({ platform }: { platform: string }) {
  return (
    <span className={`platform-mark ${platform}`}>
      <BrandLogo brand={platform} />
    </span>
  );
}
export function Avatar({ streamer, large = false }: { streamer: Streamer; large?: boolean }) {
  return (
    <TokenImage
      className={`avatar ${large ? 'avatar-lg' : ''}`}
      src={streamer.image}
      alt={`${streamer.name} portrait`}
      loading={large ? 'eager' : 'lazy'}
    />
  );
}
export function TokenArt({
  token,
  large = false,
}: {
  token: Pick<Token, 'image' | 'name'>;
  large?: boolean;
}) {
  return (
    <TokenImage
      className={`token-art ${large ? 'token-art-lg' : ''}`}
      src={token.image}
      alt={`${token.name} artwork`}
      loading={large ? 'eager' : 'lazy'}
      fetchPriority={large ? 'high' : 'auto'}
    />
  );
}
export function PadBadge({ pad }: { pad: Launchpad }) {
  return (
    <span className={`pad-badge ${pad}`}>
      <BrandLogo brand={pad} />
      {padName(pad)}
    </span>
  );
}
export function Sparkline({
  negative = false,
  variant = 0,
}: {
  negative?: boolean;
  variant?: number;
}) {
  const points =
    variant % 3 === 0
      ? '0,34 8,32 16,35 24,23 32,26 40,19 48,24 56,12 64,16 72,8 80,11 90,2'
      : variant % 3 === 1
        ? '0,32 10,27 20,29 30,18 40,21 50,11 60,15 70,7 80,12 90,4'
        : '0,30 10,34 20,24 30,26 40,18 50,23 60,11 70,15 80,5 90,9';
  return (
    <svg
      className={`sparkline ${negative ? 'negative' : ''}`}
      viewBox="0 0 90 40"
      aria-hidden="true"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        transform={negative ? 'translate(0,40) scale(1,-1)' : undefined}
      />
    </svg>
  );
}
export function marketDataLabel(token: Pick<Token, 'marketDataStatus' | 'marketDataUpdatedAt'>) {
  const updated = token.marketDataUpdatedAt ? ` Last updated ${token.marketDataUpdatedAt}.` : '';
  switch (token.marketDataStatus) {
    case 'fresh':
      return `Market data.${updated}`;
    case 'stale':
      return `Market data is delayed.${updated}`;
    case 'warming':
      return 'Market data is loading.';
    default:
      return 'Market data is unavailable.';
  }
}

export function TokenCard({ token, index }: { token: Token; index?: number }) {
  const streamer = getStreamer(token.streamerId);
  const fundingWait = fundingWaitMessage(token, streamer);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  async function copyContract() {
    try {
      await navigator.clipboard.writeText(token.address);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopied(false);
      setCopyError(true);
    }
  }
  return (
    <motion.article
      layout="position"
      initial={false}
      transition={{ type: 'spring', stiffness: 350, damping: 35 }}
      className="token-card"
    >
      <div className="token-card-art">
        <Link
          className="token-art-link"
          to={`/token/${token.id}`}
          aria-label={`View ${token.name}`}
        >
          <TokenImage
            src={token.image}
            alt={`${token.name} artwork`}
            loading={index !== undefined && index < 4 ? 'eager' : 'lazy'}
          />
          <span className="token-pad-mark">
            <BrandLogo brand={token.launchpad} />
          </span>
        </Link>
        <Link className="token-recipient-pill" to={`/streamer/${streamer.id}`}>
          <PlatformMark platform={streamer.platform} />
          <Avatar streamer={streamer} />
          <span>{streamer.name}</span>
        </Link>
      </div>
      <div className="token-card-info">
        <Link className="token-card-title" to={`/token/${token.id}`}>
          <h3>{token.name}</h3>
          <span>{token.symbol}</span>
        </Link>
        <Link className="token-card-figures" to={`/token/${token.id}`}>
          <span
            title={marketDataLabel(token)}
            aria-label={`Market cap ${money(token.mcap, true)}. ${marketDataLabel(token)}`}
          >
            <strong>{money(token.mcap, true)}</strong>
            <small>MC</small>
          </span>
          <span title="Confirmed gifts funded by this token · USD">
            <strong>{decimalMoney(tokenDonations(token.id))}</strong>
            <small>Gifts sent</small>
          </span>
          <span title="Funds allocated to this streamer that are still awaiting a gift · USD">
            <strong>
              {decimalMoney(
                token.pendingUsdCents === undefined ? null : token.pendingUsdCents / 100,
              )}
            </strong>
            <small>Awaiting gift</small>
          </span>
        </Link>
        {fundingWait && <p className="token-funding-wait">{fundingWait.summary}</p>}
        {token.feeAccrual && (
          <p className="token-funding-wait">
            <UnclaimedFees token={token} />
          </p>
        )}
        <button
          className="token-contract"
          onClick={copyContract}
          aria-label={`Copy ${token.name} contract`}
        >
          <span>
            {copied
              ? 'Copied'
              : copyError
                ? 'Copy unavailable'
                : `${token.address.slice(0, 5)}…${token.address.slice(-5)}`}
          </span>
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
        <span className="sr-only" role="status">
          {copied ? 'Demo contract copied' : copyError ? 'Clipboard unavailable' : ''}
        </span>
      </div>
    </motion.article>
  );
}
export function TokenFilters({
  pad,
  setPad,
  sort,
  setSort,
}: {
  pad: string;
  setPad: (s: string) => void;
  sort: Sort;
  setSort: (s: Sort) => void;
}) {
  const id = useId();
  return (
    <div className="token-filters">
      <div className="segmented" role="group" aria-label="Filter launchpad">
        {[
          ['all', 'All tokens'],
          ['pump', 'Pump.fun'],
          ['pons', 'PONs'],
        ].map(([key, label]) => (
          <button
            key={key}
            className={pad === key ? 'active' : ''}
            onClick={() => setPad(key)}
            aria-pressed={pad === key}
            aria-label={key === 'pons' ? 'PONs — Coming soon' : label}
            disabled={key === 'pons'}
            title={key === 'pons' ? 'PONs on Robinhood Chain — Coming soon' : undefined}
          >
            {pad === key && (
              <motion.span
                className="segment-indicator"
                layoutId={`filter-${id}`}
                transition={{ type: 'spring', stiffness: 380, damping: 32 }}
              />
            )}
            <span>
              {key !== 'all' && <BrandLogo brand={key} />} {label}
              {key === 'pons' && <small>Coming soon</small>}
            </span>
          </button>
        ))}
      </div>
      <label className="sort-select">
        <TrendingUp size={16} />
        <span className="sr-only">Sort tokens</span>
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          <option value="mcap">Market cap</option>
          <option value="donations">Most donations</option>
          <option value="volume">Volume</option>
          <option value="newest">Newest</option>
        </select>
        <ChevronDown size={12} />
      </label>
    </div>
  );
}
export function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Radio size={36} />
      <h3>{title}</h3>
      {children}
    </div>
  );
}
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const reduce = useReducedMotion();
  const returnFocus = useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className="modal"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (returnFocus.current?.isConnected) returnFocus.current.focus();
          }}
          aria-describedby={undefined}
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            onClose();
          }}
          onPointerDownOutside={(e) => {
            e.preventDefault();
            onClose();
          }}
          asChild
        >
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 18, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ type: 'spring', stiffness: 360, damping: 29 }}
          >
            <div className="modal-header">
              <Dialog.Title>{title}</Dialog.Title>
              <button aria-label="Close dialog" className="icon-btn" onClick={onClose}>
                <X size={20} />
              </button>
            </div>
            {children}
          </motion.div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Tip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip.Root delayDuration={250}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" sideOffset={8}>
          {label}
          <Tooltip.Arrow />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
export function SectionLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="text-link">
      {children}
      <ChevronRight size={16} />
    </Link>
  );
}
export function Status({ status }: { status: string }) {
  return (
    <span className={`status ${status.toLowerCase()}`}>
      {status === 'Settled' || status === 'Confirmed' ? (
        <Check size={12} />
      ) : (
        <span className="status-dot" />
      )}
      {status}
    </span>
  );
}
export function StatIcon({ type }: { type: 'heart' | 'tokens' | 'treasury' }) {
  return (
    <span className={`stat-icon ${type}`}>
      {type === 'heart' ? (
        <Heart size={22} />
      ) : type === 'tokens' ? (
        <Radio size={22} />
      ) : (
        <ArrowDownLeft size={22} />
      )}
    </span>
  );
}
