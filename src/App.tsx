import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { MotionConfig } from 'motion/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  Compass,
  Heart,
  Home,
  Menu,
  Rocket,
  Route as RouteIcon,
  Search,
  Wallet,
  X,
} from './icons';
import { Brand, BrandLogo, Modal, Tip } from './components';
import { useSession } from './auth';
import { getDomainRouting } from './domain-routing';
import { useReducedMotionPreference } from './use-reduced-motion-preference';
import { HomePage, ExplorePage } from './pages/Discover';
const DonationsPage = lazy(() =>
  import('./pages/Transparency').then((m) => ({ default: m.DonationsPage })),
);
const FlowPage = lazy(() => import('./pages/Transparency').then((m) => ({ default: m.FlowPage })));
const LaunchPage = lazy(() => import('./pages/Launch').then((m) => ({ default: m.LaunchPage })));
const DocsPage = lazy(() => import('./pages/Details').then((m) => ({ default: m.DocsPage })));
const StreamerPage = lazy(() =>
  import('./pages/Details').then((m) => ({ default: m.StreamerPage })),
);
const TokenPage = lazy(() => import('./pages/Details').then((m) => ({ default: m.TokenPage })));
const links = [
  { path: '/', label: 'Home', icon: Home },
  { path: '/explore', label: 'Explore', icon: Compass },
  { path: '/donations', label: 'Donations', icon: Heart },
  { path: '/launch', label: 'Launch', icon: Rocket },
  { path: '/flow', label: 'Capital flow', icon: RouteIcon },
  { path: '/docs', label: 'Docs', icon: BookOpen },
];
const socials = [
  ['x', 'https://x.com/pogdotfun'],
  ['twitch', 'https://twitch.tv/pogdotfun'],
  ['kick', 'https://kick.com/pogdotfun'],
];
function Navigation({
  mobile = false,
  collapsed = false,
  onNavigate,
}: {
  mobile?: boolean;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const { isAdminHost, publicHref } = getDomainRouting(window.location.hostname);
  return (
    <>
      <Link to={publicHref('/')} className="logo-link" aria-label="pog home" onClick={onNavigate}>
        <Brand small={collapsed} />
      </Link>
      <nav aria-label={mobile ? 'Mobile navigation' : 'Main navigation'}>
        {links.map(({ path, label, icon: Icon }) =>
          isAdminHost ? (
            <a
              key={path}
              href={publicHref(path)}
              onClick={onNavigate}
              aria-label={label}
              className="nav-link"
            >
              <Icon size={25} weight="regular" />
              <span>{label}</span>
            </a>
          ) : (
            <NavLink
              key={path}
              to={path}
              end={path === '/'}
              onClick={onNavigate}
              aria-label={label}
              className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
            >
              {({ isActive }) => (
                <>
                  <Icon size={25} weight={isActive ? 'fill' : 'regular'} />
                  <span>{label}</span>
                </>
              )}
            </NavLink>
          ),
        )}
      </nav>
      <div className="sidebar-bottom">
        <Link to={publicHref('/docs#demo')} className="demo-badge">
          <span />
          Multichain · Solana live
        </Link>
        <div className="social-links">
          {socials.map(([brand, href]) => (
            <Tip key={brand} label={`pog on ${brand}`}>
              <a href={href} target="_blank" rel="noreferrer" aria-label={`pog on ${brand}`}>
                <BrandLogo brand={brand} />
              </a>
            </Tip>
          ))}
        </div>
        <a
          className="sidebar-account"
          aria-label="pog on X"
          href="https://x.com/pogdotfun"
          target="_blank"
          rel="noreferrer"
        >
          <Brand small />
          <span>
            <strong>pog</strong>
            <small>@pogdotfun</small>
          </span>
          <ArrowUpRight size={16} />
        </a>
      </div>
    </>
  );
}
export default function App() {
  const reducedMotion = useReducedMotionPreference();
  const location = useLocation(),
    navigate = useNavigate();
  const session = useSession();
  const { isAdminHost, publicHref, redirectFor } = getDomainRouting(window.location.hostname);
  const redirect = redirectFor(location.pathname, location.search, location.hash);
  const [mobile, setMobile] = useState(false),
    [wallet, setWallet] = useState(false),
    [collapsed, setCollapsed] = useState(false),
    [query, setQuery] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  async function signOutWallet() {
    if (signingOut) return;
    setSigningOut(true);
    setLogoutError('');
    try {
      await session.logout();
      setWallet(false);
    } catch (error) {
      setLogoutError(
        error instanceof Error ? error.message : 'Wallet sign-out could not finish. Try again.',
      );
    } finally {
      setSigningOut(false);
    }
  }
  useEffect(() => {
    if (redirect) window.location.replace(redirect);
  }, [redirect]);
  useEffect(() => {
    setMobile(false);
    window.scrollTo(0, 0);
    document.title = `${location.pathname.startsWith('/receipt/') ? 'Gift receipt' : (links.find((l) => l.path === location.pathname)?.label ?? 'Community')} · pog`;
  }, [location.pathname]);
  return (
    <MotionConfig reducedMotion={reducedMotion ? 'always' : 'never'}>
      <Tooltip.Provider>
        <div className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
          <a href="#main" className="skip-link">
            Skip to content
          </a>
          <aside className="sidebar">
            <Navigation collapsed={collapsed} />
            <button
              className="sidebar-toggle"
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              onClick={() => setCollapsed(!collapsed)}
            >
              <ChevronRight
                size={15}
                style={{ transform: collapsed ? 'none' : 'rotate(180deg)' }}
              />
            </button>
          </aside>
          <div className="main-shell">
            <header className="topbar">
              <div className="mobile-brand">
                <Dialog.Root open={mobile} onOpenChange={setMobile}>
                  <Dialog.Trigger asChild>
                    <button className="icon-btn" aria-label="Open navigation">
                      <Menu size={24} />
                    </button>
                  </Dialog.Trigger>
                  <Dialog.Portal>
                    <Dialog.Overlay className="sidebar-backdrop" />
                    <Dialog.Content className="mobile-drawer" aria-describedby={undefined}>
                      <Dialog.Title className="sr-only">Navigation</Dialog.Title>
                      <Dialog.Close className="icon-btn mobile-close" aria-label="Close navigation">
                        <X size={21} />
                      </Dialog.Close>
                      <Navigation mobile onNavigate={() => setMobile(false)} />
                    </Dialog.Content>
                  </Dialog.Portal>
                </Dialog.Root>
                <Link to={publicHref('/')} aria-label="pog home">
                  <Brand />
                </Link>
              </div>
              <form
                className="global-search"
                onSubmit={(e) => {
                  e.preventDefault();
                  const target = publicHref(`/explore?q=${encodeURIComponent(query)}`);
                  if (isAdminHost) window.location.assign(target);
                  else navigate(target);
                  setQuery('');
                }}
              >
                <Search size={18} />
                <input
                  aria-label="Search tokens or contract address"
                  placeholder="Search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </form>
              <div className="topbar-actions">
                <Link className="btn btn-primary topbar-launch" to={publicHref('/launch')}>
                  Launch
                </Link>
                <button
                  className="wallet-button"
                  aria-label="Connect wallet"
                  onClick={() =>
                    session.authenticated || session.error ? setWallet(true) : session.login()
                  }
                  disabled={!session.ready}
                >
                  <span>{session.authenticated ? 'My wallet' : 'Connect wallet'}</span>
                  <Wallet size={19} />
                </button>
              </div>
            </header>
            <main id="main">
              <Suspense
                fallback={
                  <div className="page route-loading" role="status">
                    Loading…
                  </div>
                }
              >
                <Routes>
                  <Route path="/" element={<HomePage />} />
                  <Route path="/explore" element={<ExplorePage />} />
                  <Route path="/donations" element={<DonationsPage />} />
                  <Route path="/launch" element={<LaunchPage />} />
                  <Route path="/flow" element={<FlowPage />} />
                  <Route path="/docs" element={<DocsPage />} />
                  <Route path="/token/:id" element={<TokenPage />} />
                  <Route path="/streamer/:id" element={<StreamerPage />} />
                  <Route
                    path="*"
                    element={
                      <div className="empty">
                        <h1>Page not found</h1>
                        <Link className="btn btn-primary" to={publicHref('/')}>
                          Back to home
                        </Link>
                      </div>
                    }
                  />
                </Routes>
              </Suspense>
            </main>
            <footer className="page-footer">
              <div>
                <Brand />
                <span>© {new Date().getFullYear()} pog</span>
              </div>
              <p>Community tokens. Public receipts. No creator endorsement implied.</p>
              <a href="/assets/credits.html" target="_blank" rel="noreferrer">
                Image credits <ArrowUpRight size={13} />
              </a>
            </footer>
          </div>
          {wallet && (
            <Modal title="Connect your wallet" onClose={() => setWallet(false)}>
              {logoutError && <p role="alert">{logoutError}</p>}
              {session.authenticated ? (
                <>
                  <p>Solana wallets</p>
                  {session.wallets.map((address) => (
                    <p className="wallet-address" key={address}>
                      <code>{address}</code>
                    </p>
                  ))}
                  {!session.wallets.length && <p>Connect your Solana wallet to continue.</p>}
                  <button
                    className="btn btn-secondary full-width"
                    disabled={signingOut || !session.ready}
                    onClick={() => {
                      setWallet(false);
                      session.connectWallet();
                    }}
                  >
                    Connect Phantom or MetaMask
                  </button>
                  <Link
                    to={publicHref('/launch')}
                    className="btn btn-primary full-width"
                    onClick={() => setWallet(false)}
                  >
                    Launch a token
                  </Link>
                  <button
                    className="modal-secondary"
                    disabled={signingOut}
                    onClick={() => void signOutWallet()}
                  >
                    {signingOut ? 'Disconnecting wallet…' : 'Sign out'}
                  </button>
                </>
              ) : (
                <>
                  <p role="status">
                    {signingOut
                      ? 'Disconnecting your previous wallet…'
                      : session.error || 'Choose Phantom or MetaMask to connect.'}
                  </p>
                  {logoutError ? (
                    <button
                      className="btn btn-secondary full-width"
                      disabled={signingOut}
                      onClick={() => void signOutWallet()}
                    >
                      Retry sign out
                    </button>
                  ) : (
                    <button
                      className="btn btn-primary full-width"
                      disabled={!session.ready || signingOut}
                      onClick={() => {
                        setWallet(false);
                        session.login();
                      }}
                    >
                      Connect wallet
                    </button>
                  )}
                </>
              )}
            </Modal>
          )}
        </div>
      </Tooltip.Provider>
    </MotionConfig>
  );
}
