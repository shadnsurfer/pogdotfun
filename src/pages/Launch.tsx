import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { motion, useReducedMotion } from 'motion/react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FileText,
  Heart,
  ImagePlus,
  LoaderCircle,
  Trash2,
  Upload,
} from '../icons';
import { Avatar, BrandLogo, Modal, PadBadge, PageHeading, PlatformMark } from '../components';
import { refreshCatalog } from '../data';
import { useSession } from '../auth';
import { parseInitialBuySol } from '../launch-amount';
import type { Launchpad, Platform, Streamer } from '../data';
import './launch-v2.css';

interface LaunchRecord {
  launchId: string;
  walletAddress: string;
  status: 'preparing' | 'prepared' | 'submitted' | 'confirmed' | 'failed' | 'review';
  transaction: string | null;
  summary: {
    name: string;
    symbol: string;
    mint: string;
    creatorAddress: string;
    recipientPlatform: Platform;
    recipientUsername: string;
    networkFeeLamports: string;
    creatorReserveLamports: string;
    estimatedTotalLamports: string;
    initialBuyLamports: string;
  };
  signature?: string;
  tokenId?: string;
  transactionUrl?: string;
  error?: string;
}
const sol = (lamports: string | undefined) => {
  if (!lamports) return '—';
  const amount = BigInt(lamports);
  const whole = (amount / 1_000_000_000n).toLocaleString('en-US');
  const fraction = (amount % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} SOL`;
};
export function LaunchPage() {
  const session = useSession();
  const identity = JSON.stringify([
    session.generation,
    session.authenticated,
    session.userId,
    session.wallets,
  ]);
  const [selection, setSelection] = useState({ identity: '', address: '' });
  const selectedWallet =
    session.authenticated && session.userId
      ? selection.identity === identity && session.wallets.includes(selection.address)
        ? selection.address
        : session.wallets[0] || ''
      : '';
  const scopeKey = JSON.stringify([identity, selectedWallet]);
  const owner = useRef(scopeKey);
  owner.current = scopeKey;
  return (
    <LaunchEditor
      key={scopeKey}
      session={session}
      selectedWallet={selectedWallet}
      ownsIdentity={() => owner.current === scopeKey}
      selectWallet={(address) => setSelection({ identity, address })}
    />
  );
}

function LaunchEditor({
  session,
  selectedWallet,
  ownsIdentity,
  selectWallet,
}: {
  session: ReturnType<typeof useSession>;
  selectedWallet: string;
  ownsIdentity: () => boolean;
  selectWallet: (address: string) => void;
}) {
  const [params] = useSearchParams();
  const requestedRoute = params.get('launchpad') ?? params.get('pad') ?? params.get('chain');
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [description, setDescription] = useState('');
  const [launchpad, setLaunchpad] = useState<Launchpad>('pump');
  const [platform, setPlatform] = useState<Platform>(
    params.get('platform') === 'kick' ? 'kick' : 'twitch',
  );
  const [username, setUsername] = useState('');
  const [twitter, setTwitter] = useState('');
  const [image, setImage] = useState('');
  const [imageError, setImageError] = useState('');
  const [review, setReview] = useState(false);
  const [initialBuySol, setInitialBuySol] = useState('');
  const [saving, setSaving] = useState(false);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [launch, setLaunch] = useState<LaunchRecord | null>(null);
  const [recipient, setRecipient] = useState<Streamer | null>(null);
  const [lookupError, setLookupError] = useState('');
  const [looking, setLooking] = useState(false);
  const lookupGeneration = useRef(0);
  const actionSequence = useRef(0);
  const active = useRef(true);
  const actionPending = useRef(false);
  const submissionStarted = useRef(false);
  const launchRef = useRef(launch);
  launchRef.current = launch;
  const current = () => active.current && ownsIdentity();
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      lookupGeneration.current++;
    };
  }, []);
  const [availabilityNotice, setAvailabilityNotice] = useState(
    requestedRoute && !['pump', 'solana'].includes(requestedRoute.toLowerCase())
      ? 'That route is coming soon. Pump.fun on Solana is selected.'
      : '',
  );
  const uploadRef = useRef<HTMLInputElement>(null);
  const usernameClean = username.replace(/^@/, '').trim();
  const reduceMotion = useReducedMotion();
  const previewImage = image || '/assets/brand/fee-coin.png';
  const awaitingConfirmation = !!launch && !['confirmed', 'failed'].includes(launch.status);
  useEffect(() => {
    lookupGeneration.current++;
    setRecipient(null);
    setLookupError('');
    setLooking(false);
  }, [username, platform]);
  function receiveLaunch(record: LaunchRecord) {
    // A lost submit response may still be in flight. Keep checking this operation.
    setLaunch(
      submissionStarted.current && ['preparing', 'prepared'].includes(record.status)
        ? { ...record, status: 'review' }
        : record,
    );
    if (record.status === 'confirmed') void refreshCatalog({ force: true });
  }
  function closeDialog() {
    if (saving || awaitingConfirmation) return;
    setReview(false);
    if (launch) {
      setLaunch(null);
      setInitialBuySol('');
      setError('');
      submissionStarted.current = false;
    }
  }
  useEffect(() => {
    if (
      !launch ||
      !['preparing', 'submitted', 'review'].includes(launch.status) ||
      !session.authenticated
    )
      return;
    let stopped = false;
    const id = launch.launchId;
    let polling = false;
    const timer = setInterval(() => {
      if (document.hidden || !current() || actionPending.current || polling) return;
      polling = true;
      const sequence = actionSequence.current;
      session
        .request<LaunchRecord>(`/api/launches/${encodeURIComponent(id)}`)
        .then((record) => {
          if (
            !stopped &&
            current() &&
            sequence === actionSequence.current &&
            launchRef.current?.launchId === id
          ) {
            receiveLaunch(record);
          }
        })
        .catch(() => {})
        .finally(() => {
          polling = false;
        });
    }, 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [launch?.launchId, launch?.status, session.authenticated]);
  async function lookup() {
    if (!current()) return;
    if (!session.authenticated) {
      session.login();
      return;
    }
    const generation = ++lookupGeneration.current;
    setLooking(true);
    setLookupError('');
    setRecipient(null);
    try {
      const result = await session.request<{ streamer: Streamer }>(
        `/api/streamers/lookup?platform=${platform}&username=${encodeURIComponent(usernameClean)}`,
      );
      if (!current() || generation !== lookupGeneration.current) return;
      if (result.streamer.platform !== platform)
        throw new Error('The verified channel does not match the selected platform.');
      setRecipient(result.streamer);
    } catch (e) {
      if (current() && generation === lookupGeneration.current)
        setLookupError(e instanceof Error ? e.message : 'Could not verify this channel.');
    } finally {
      if (current() && generation === lookupGeneration.current) setLooking(false);
    }
  }
  function readImage(file?: File) {
    if (!file) return;
    setImageError('');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setImageError('Choose a PNG, JPG, or WebP image.');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setImageError('Your image must be 2 MB or smaller.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (current()) setImage(String(reader.result));
    };
    reader.onerror = () => {
      if (current()) setImageError('This image could not be read.');
    };
    reader.readAsDataURL(file);
  }
  function onReview(e: FormEvent) {
    e.preventDefault();
    if (!current()) return;
    setError('');
    if (!session.authenticated) {
      session.login();
      return;
    }
    if (!session.config?.launchesEnabled) {
      setError('Token launches are not enabled yet.');
      return;
    }
    if (new TextEncoder().encode(name.trim()).length > 32) {
      setError('Token names must fit within 32 UTF-8 bytes. Try a shorter name.');
      return;
    }
    if (!image) {
      setImageError('Add artwork for your token.');
      return;
    }
    if (!recipient || recipient.platform !== platform) {
      setLookupError('Verify the streamer channel before continuing.');
      return;
    }
    if (!selectedWallet) {
      setError('Connect a Solana wallet to continue.');
      return;
    }
    setReview(true);
  }
  async function launchToken() {
    if (
      !current() ||
      actionPending.current ||
      !session.ready ||
      !session.authenticated ||
      !session.wallets.includes(selectedWallet)
    )
      return;
    if (launch) return;
    if (!recipient || recipient.platform !== platform) {
      setError('Verify the selected channel before continuing.');
      return;
    }
    let initialBuyLamports: string;
    try {
      initialBuyLamports = parseInitialBuySol(initialBuySol);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Enter a valid dev buy in SOL.');
      return;
    }
    setSaving(true);
    actionPending.current = true;
    const sequence = ++actionSequence.current;
    const owned = () => current() && sequence === actionSequence.current;
    setError('');
    let attempt: LaunchRecord | null = null;
    submissionStarted.current = false;
    try {
      const preparedRequestId = crypto.randomUUID();
      setStage('Uploading artwork…');
      const uploaded = await session.request<{ uri: string }>('/api/uploads/token-image', {
        method: 'POST',
        body: JSON.stringify({ imageDataUrl: image }),
      });
      if (!owned()) return;
      setStage('Getting your launch ready…');
      const prepared = await session.request<LaunchRecord>('/api/launches/prepare', {
        method: 'POST',
        body: JSON.stringify({
          requestId: preparedRequestId,
          name: name.trim(),
          symbol: symbol.trim(),
          description: description.trim(),
          imageUri: uploaded.uri,
          ...(twitter.trim() ? { twitter: twitter.trim() } : {}),
          recipientPlatform: platform,
          recipientUsername: usernameClean,
          walletAddress: selectedWallet,
          initialBuyLamports,
        }),
      });
      if (!owned()) return;
      attempt = prepared;
      setLaunch(prepared);
      setStage('Opening your wallet…');
      const current = await session.request<LaunchRecord>(
        `/api/launches/${encodeURIComponent(attempt.launchId)}`,
      );
      if (!owned()) return;
      if (
        current.walletAddress !== selectedWallet ||
        current.launchId !== attempt.launchId ||
        current.summary.recipientPlatform !== platform
      )
        throw new Error('The launch details changed. Please try again.');
      if (current.signature || ['submitted', 'confirmed'].includes(current.status)) {
        submissionStarted.current = true;
        receiveLaunch(current);
        return;
      }
      if (current.status !== 'prepared' || !current.transaction)
        throw new Error(current.error || 'Could not verify this launch. Please try again.');
      setLaunch(current);
      attempt = current;
      setStage('Confirm in your wallet…');
      const signedTransaction = await session.sign(current.transaction, current.walletAddress);
      if (!owned()) return;
      setStage('Submitting to Solana…');
      submissionStarted.current = true;
      const record = await session.request<LaunchRecord>(
        `/api/launches/${encodeURIComponent(attempt.launchId)}/submit`,
        { method: 'POST', body: JSON.stringify({ signedTransaction }) },
      );
      if (!owned()) return;
      receiveLaunch(record);
    } catch (e) {
      if (!owned()) return;
      setError(e instanceof Error ? e.message : 'Could not finish this launch.');
      if (!submissionStarted.current) {
        if (attempt) {
          try {
            await session.request(`/api/launches/${encodeURIComponent(attempt.launchId)}/cancel`, {
              method: 'POST',
            });
          } catch {
            // Abandoned unsigned transactions also expire through server reconciliation.
          }
        }
        if (!owned()) return;
        setLaunch(null);
        return;
      }
      if (!attempt) return;
      // A lost response may still have reached Solana. Recover before allowing another attempt.
      try {
        const recovered = await session.request<LaunchRecord>(
          `/api/launches/${encodeURIComponent(attempt.launchId)}`,
        );
        if (owned()) receiveLaunch(recovered);
      } catch {
        if (!owned()) return;
        setLaunch({ ...attempt, status: 'review' });
        setError(
          'The result is unknown. Keep this launch open and check its status before trying again.',
        );
      }
    } finally {
      if (owned()) {
        actionPending.current = false;
        setSaving(false);
        setStage('');
      }
    }
  }
  async function checkStatus() {
    if (!current() || actionPending.current || !session.authenticated || !launch) return;
    actionPending.current = true;
    const sequence = ++actionSequence.current;
    const owned = () => current() && sequence === actionSequence.current;
    setSaving(true);
    setError('');
    try {
      const record = await session.request<LaunchRecord>(
        `/api/launches/${encodeURIComponent(launch.launchId)}`,
      );
      if (owned()) receiveLaunch(record);
    } catch (e) {
      if (owned()) setError(e instanceof Error ? e.message : 'Status unavailable.');
    } finally {
      if (owned()) {
        actionPending.current = false;
        setSaving(false);
      }
    }
  }
  return (
    <div className="page launch-v2">
      <PageHeading
        title="Launch a token"
        description="Create a token. Support a Twitch streamer. Solana is live today, with more chains coming soon."
        action={<span className="lv-mode">Solana mainnet</span>}
      />
      <div className="lv-workspace">
        <div className="lv-editor">
          {error && !review && (
            <p className="lv-error" role="alert">
              {error}
            </p>
          )}
          {!session.config?.launchesEnabled && (
            <p className="lv-availability" role="status">
              Launches are currently unavailable. You can review the form while the launch service
              is prepared.
            </p>
          )}
          {session.authenticated && (
            <label className="lv-wallet-select">
              Launch wallet
              <select
                value={selectedWallet}
                onChange={(e) => selectWallet(e.target.value)}
                disabled={saving}
              >
                {session.wallets.map((address) => (
                  <option key={address} value={address}>
                    {address}
                  </option>
                ))}
              </select>
            </label>
          )}
          {availabilityNotice && (
            <p className="lv-availability" role="status">
              {availabilityNotice}
            </p>
          )}
          <form onSubmit={onReview} className="lv-form">
            <fieldset
              disabled={saving || !!launch}
              style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
            >
              <section className="lv-section">
                <div className="lv-upload-row">
                  <button
                    type="button"
                    className={`lv-upload ${image ? 'lv-has-image' : ''}`}
                    onClick={() => uploadRef.current?.click()}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      readImage(event.dataTransfer.files?.[0]);
                    }}
                    aria-label="Upload token image"
                  >
                    {image ? (
                      <img src={image} alt="Your token artwork" />
                    ) : (
                      <>
                        <ImagePlus size={30} />
                        <span>Add artwork</span>
                      </>
                    )}
                    {image && (
                      <span className="lv-upload-overlay">
                        <Upload size={19} />
                      </span>
                    )}
                  </button>
                  <div className="lv-upload-copy">
                    <strong>
                      Token image <span>Required</span>
                    </strong>
                    <p>JPG, PNG or WebP. Max 2 MB.</p>
                    <div className="lv-upload-actions">
                      <button
                        type="button"
                        className="lv-inline-action"
                        onClick={() => uploadRef.current?.click()}
                      >
                        <Upload size={15} />
                        {image ? 'Change artwork' : 'Choose an image'}
                      </button>
                      {image && (
                        <button
                          type="button"
                          className="lv-remove"
                          onClick={() => {
                            setImage('');
                            if (uploadRef.current) uploadRef.current.value = '';
                          }}
                          aria-label="Remove token image"
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                  <input
                    ref={uploadRef}
                    aria-label="Token image file"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="sr-only"
                    tabIndex={-1}
                    onChange={(event) => readImage(event.target.files?.[0])}
                  />
                </div>
                {imageError && (
                  <p className="lv-error" role="alert">
                    {imageError}
                  </p>
                )}
                <div className="lv-field-row">
                  <label className="lv-field">
                    Token name
                    <input
                      required
                      minLength={2}
                      maxLength={32}
                      placeholder="Chat Cat"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </label>
                  <label className="lv-field">
                    Ticker
                    <div className="lv-prefixed">
                      <span>$</span>
                      <input
                        required
                        minLength={2}
                        maxLength={10}
                        pattern="[A-Z0-9]{2,10}"
                        title="2–10 uppercase letters or numbers"
                        placeholder="CHAT"
                        value={symbol}
                        onChange={(event) =>
                          setSymbol(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))
                        }
                      />
                    </div>
                  </label>
                </div>
                <label className="lv-field">
                  <span className="lv-label-line">
                    Description <span>Optional</span>
                  </span>
                  <textarea
                    maxLength={500}
                    rows={3}
                    placeholder="Tell your community about the token"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                  <span className="lv-count">{description.length}/500</span>
                </label>
                <label className="lv-field">
                  <span className="lv-label-line">
                    X link <span>Optional</span>
                  </span>
                  <input
                    type="url"
                    pattern="https://(?:www[.])?(?:x[.]com|twitter[.]com)/.+"
                    title="Use an HTTPS x.com or twitter.com profile, community, or post link without a port or sign-in details"
                    placeholder="https://x.com/your_community"
                    value={twitter}
                    onChange={(event) => setTwitter(event.target.value)}
                  />
                </label>
              </section>
              <section className="lv-section">
                <div className="lv-section-title">
                  <h2>Launchpad</h2>
                </div>
                <div className="lv-launchpads" role="group" aria-label="Choose a launchpad">
                  {(
                    [
                      { id: 'pump', name: 'Pump.fun', chain: 'Solana' },
                      { id: 'pons', name: 'PONs', chain: 'Robinhood' },
                    ] as const
                  ).map((pad) => (
                    <button
                      type="button"
                      key={pad.id}
                      className={`lv-pad ${launchpad === pad.id ? 'is-selected' : ''} ${pad.id !== 'pump' ? 'lv-soon' : ''}`}
                      disabled={pad.id !== 'pump'}
                      onClick={() => {
                        setLaunchpad(pad.id);
                        setAvailabilityNotice('');
                      }}
                      aria-pressed={launchpad === pad.id}
                    >
                      <BrandLogo brand={pad.id} />
                      <strong>{pad.name}</strong>
                      <small>
                        {pad.chain}
                        {pad.id !== 'pump' ? ' · Coming soon' : ''}
                      </small>
                    </button>
                  ))}
                  <button type="button" className="lv-pad lv-soon" disabled>
                    <BrandLogo brand="flap" />
                    <strong>Flap</strong>
                    <small>BNB · Coming soon</small>
                  </button>
                </div>
              </section>
              <section className="lv-section">
                <div className="lv-section-title">
                  <h2>Support a streamer</h2>
                </div>
                <div className="lv-recipient-platforms" role="group" aria-label="Streamer platform">
                  <button
                    type="button"
                    className={`twitch ${platform === 'twitch' ? 'is-selected' : ''}`}
                    aria-pressed={platform === 'twitch'}
                    onClick={() => setPlatform('twitch')}
                  >
                    <BrandLogo brand="twitch" /> Twitch <Check size={14} />
                  </button>
                  <button
                    type="button"
                    aria-pressed={platform === 'kick'}
                    onClick={() => setPlatform('kick')}
                  >
                    <BrandLogo brand="kick" /> Kick
                  </button>
                </div>
                <label className="lv-field">
                  Streamer username
                  <div className="lv-prefixed">
                    <span>@</span>
                    <input
                      required
                      minLength={3}
                      maxLength={25}
                      pattern="[A-Za-z0-9_]{3,25}"
                      title="3–25 letters, numbers, or underscores"
                      placeholder="twitch_username"
                      value={username}
                      onChange={(event) => setUsername(event.target.value.replace(/^@/, ''))}
                    />
                  </div>
                </label>
                <div className="lv-lookup">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => void lookup()}
                    disabled={looking || usernameClean.length < 3 || !session.ready}
                  >
                    {looking
                      ? 'Checking…'
                      : session.authenticated
                        ? 'Verify channel'
                        : 'Connect wallet to verify'}
                  </button>
                  {recipient && (
                    <a
                      href={
                        recipient.channelUrl ||
                        `https://twitch.tv/${encodeURIComponent(recipient.handle)}`
                      }
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Check size={14} /> {recipient.name} · View channel
                    </a>
                  )}
                </div>
                {lookupError && (
                  <p className="lv-error" role="alert">
                    {lookupError}
                  </p>
                )}
                <p className="lv-helper">
                  Channel lookup confirms the account exists. Gift availability is checked before
                  each payment.
                </p>
              </section>
              <div className="lv-submit-row">
                <Link to="/docs">How it works</Link>
                <button
                  className="btn btn-primary"
                  type="submit"
                  disabled={
                    launchpad !== 'pump' || !session.ready || !session.config?.launchesEnabled
                  }
                >
                  {session.authenticated ? 'Launch token' : 'Connect wallet to launch'}
                  <ArrowRight size={17} />
                </button>
              </div>
            </fieldset>
          </form>
        </div>
        <aside className="lv-preview-column">
          <div className="lv-preview-sticky">
            <div className="lv-preview-label">
              <h2>Preview</h2>
              <span>Unlaunched token</span>
            </div>
            <div className="lv-beneficiary">
              {recipient ? (
                <Avatar streamer={recipient} />
              ) : (
                <span className="lv-recipient-icon">
                  <BrandLogo brand={platform} />
                </span>
              )}
              <div>
                <span>Fees support</span>
                <strong>@{usernameClean || 'your_streamer'}</strong>
              </div>
              {recipient && <PlatformMark platform={platform} />}
              <Heart size={18} className="lv-beneficiary-heart" />
            </div>
            <div className="lv-preview-shell">
              <div className="lv-preview-cover">
                <motion.img
                  key={image || 'default'}
                  src={previewImage}
                  alt={image ? 'Your token artwork preview' : 'pog token artwork placeholder'}
                  initial={reduceMotion ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.2 }}
                />
                {!image && <span className="lv-example-art">Artwork preview</span>}
              </div>
              <div className="lv-preview-content">
                <div className="lv-preview-title">
                  <h2>{name || 'Token name'}</h2>
                  <span>${symbol || 'TICKER'}</span>
                </div>
                <p className={`lv-preview-story ${description ? '' : 'is-placeholder'}`}>
                  {description || 'Your token description will appear here.'}
                </p>
                <div className="lv-preview-stats">
                  <div>
                    <span>Market cap</span>
                    <strong>—</strong>
                  </div>
                  <div>
                    <span>Donations</span>
                    <strong>$0</strong>
                  </div>
                  <PadBadge pad={launchpad} />
                </div>
              </div>
            </div>
            <div className="lv-allocation">
              <div className="lv-allocation-title">
                <h3>Fee split</h3>
                <Link to="/flow">
                  View flow
                  <ArrowRight size={14} />
                </Link>
              </div>
              <div
                className="lv-allocation-track"
                aria-label="80 percent to streamer support and 20 percent to native POG buybacks and burns"
              >
                <span />
                <span />
              </div>
              <div className="lv-allocation-legend">
                <div>
                  <Heart size={15} />
                  <span>Streamer donations</span>
                  <strong>80%</strong>
                </div>
                <div>
                  <span>Native POG buybacks & burns</span>
                  <strong>20%</strong>
                </div>
              </div>
              <p>
                Native creator fees split 80/20 before conversion. The streamer share goes to
                Coinbase; its actual net USD proceeds cover gifts and checkout costs.
              </p>
            </div>
          </div>
        </aside>
      </div>
      {review && (
        <Modal
          title={
            launch?.status === 'confirmed'
              ? 'Your token is live'
              : !launch || launch.status === 'prepared'
                ? 'Launch token'
                : 'Launch status'
          }
          onClose={closeDialog}
        >
          <div className="lv-review">
            <div className="lv-review-token">
              <img src={previewImage} alt={image ? 'Token artwork' : 'Artwork preview'} />
              <div>
                <h3>{launch?.summary.name || name}</h3>
                <p>${launch?.summary.symbol || symbol}</p>
              </div>
              <PadBadge pad={launchpad} />
            </div>
            <dl className="lv-review-details">
              <div>
                <dt>Supporting</dt>
                <dd>
                  <PlatformMark platform={launch?.summary.recipientPlatform || platform} />@
                  {launch?.summary.recipientUsername || usernameClean}
                </dd>
              </div>
              <div>
                <dt>Streamer donations</dt>
                <dd>80%</dd>
              </div>
              <div>
                <dt>Native POG buybacks & burns</dt>
                <dd>20%</dd>
              </div>
            </dl>
            {!launch && (
              <div className="lv-review-dev-buy">
                <label htmlFor="launch-dev-buy">Dev buy (SOL)</label>
                <input
                  id="launch-dev-buy"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0.00"
                  maxLength={32}
                  value={initialBuySol}
                  disabled={saving}
                  aria-describedby="launch-dev-buy-help"
                  onChange={(event) => {
                    setInitialBuySol(event.target.value);
                    setError('');
                  }}
                />
                <p id="launch-dev-buy-help">
                  Optional. Leave blank to launch without buying. Your purchase is included in the
                  same transaction, and the tokens go to your connected wallet.
                </p>
              </div>
            )}
            {launch && (
              <dl className="lv-review-details">
                <div>
                  <dt>Estimated total</dt>
                  <dd>{sol(launch.summary.estimatedTotalLamports)}</dd>
                </div>
                <div>
                  <dt>Network fee</dt>
                  <dd>{sol(launch.summary.networkFeeLamports)}</dd>
                </div>
                <div>
                  <dt>Creator gas reserve</dt>
                  <dd>{sol(launch.summary.creatorReserveLamports)}</dd>
                </div>
                <div>
                  <dt>Initial token purchase</dt>
                  <dd>
                    {launch.summary.initialBuyLamports && launch.summary.initialBuyLamports !== '0'
                      ? sol(launch.summary.initialBuyLamports)
                      : 'None'}
                  </dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{launch.status}</dd>
                </div>
              </dl>
            )}
            <p className="lv-review-note">
              <FileText size={17} />{' '}
              {launch
                ? 'The estimate includes the network fee, account creation, the dedicated creator wallet reserve and any initial token purchase. Your wallet shows the transaction before approval.'
                : 'Launch fees are additional to your optional buy. Next, confirm the transaction in your wallet to create your token.'}
            </p>
            {launch?.error && (
              <p className="lv-error" role="alert">
                {launch.error}
              </p>
            )}
            {launch?.transactionUrl && (
              <a
                className="text-link"
                href={launch.transactionUrl}
                target="_blank"
                rel="noreferrer"
              >
                View Solana transaction
              </a>
            )}
            {launch?.status === 'confirmed' && launch.tokenId && (
              <Link className="btn btn-primary full-width" to={`/token/${launch.tokenId}`}>
                View your token
              </Link>
            )}

            {error && (
              <p className="lv-error" role="alert">
                {error}
              </p>
            )}
            {launch?.status !== 'confirmed' && launch?.status !== 'failed' && (
              <button
                className="btn btn-primary lv-launch-button"
                onClick={() => void (launch ? checkStatus() : launchToken())}
                disabled={saving || !session.ready || !session.authenticated}
              >
                {saving ? (
                  <>
                    <LoaderCircle className="spin" size={17} />
                    {stage || 'Checking status…'}
                  </>
                ) : !launch ? (
                  'Launch token'
                ) : (
                  'Check confirmation'
                )}
              </button>
            )}
            {launch?.status === 'review' && (
              <p className="lv-helper">
                Checking whether this transaction confirmed. Keep this dialog open while
                confirmation is pending.
              </p>
            )}
            {!awaitingConfirmation && (
              <button className="lv-back-button" disabled={saving} onClick={closeDialog}>
                <ArrowLeft size={14} />
                {launch ? 'Close' : 'Back to editing'}
              </button>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
