import { isIosClient } from "../utils/platform";
import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import {
  extractSkFromUrl, extractPageFromUrl, extractRadioTokenFromUrl,
  getSecretKey, setSecretKey, clearSecretKey, getDeviceId, getDeviceSigningKey, clearDeviceSession,
  setDeviceSession, restoreRememberedDeviceSession, setPageIntent, setRadioToken, AUTH_CHANGED_EVENT, AUTH_EXPIRED_EVENT, getApiBaseUrl, isAuthTransitionPending,
} from '../api/client';
import {
  AuthRequestError, canTrustDevice, canUseTrustedDeviceCookie, getAuthInfo,
  getAuthSession, loginDevice, logoutDevice, subscribeToLogout, type AuthInfo,
} from '../api/auth';
import { hmacSha256Hex } from '../api/hmac';
import { handRemoteAuthToShell } from '../utils/tauriShell';
import { GroveHeroBackground } from './Layout/GroveHeroBackground';
import { GroveIcon } from './Layout/GroveIcon';

type AuthState = 'loading' | 'authenticated' | 'needs_auth' | 'connection_error';

export function AuthGate({ children }: { children: ReactNode }) {
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [info, setInfo] = useState<AuthInfo | null>(null);
  const [skInput, setSkInput] = useState('');
  const [trusted, setTrusted] = useState(isIosClient);
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const initializing = useRef(false);
  const offeredSecret = useRef<string | null>(null);

  const legacyLogin = useCallback(async (secret: string) => {
    const proof = await hmacSha256Hex(secret, 'grove-verify');
    const response = await fetch(`${getApiBaseUrl()}/api/v1/auth/verify`, {
      method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proof }),
    });
    if (!response.ok) throw new AuthRequestError(response.status, 'Unable to verify the secret key');
    setSecretKey(secret);
  }, []);

  const initialize = useCallback(async () => {
    if (initializing.current) return;
    initializing.current = true;
    setAuthState('loading');
    setError(null);
    try {
      if (isIosClient && new URLSearchParams(window.location.search).has('ios-sign-out')) {
        if (!getDeviceId()) restoreRememberedDeviceSession();
        if (getDeviceId()) await logoutDevice();
        else clearDeviceSession();
        window.location.replace('/_grove/');
        return;
      }
      const hashSk = extractSkFromUrl();
      const hashPage = extractPageFromUrl();
      const hashToken = (hashSk || hashPage) ? extractRadioTokenFromUrl() : null;
      if (hashSk) offeredSecret.current = hashSk;
      if (hashPage) setPageIntent(hashPage);
      if (hashToken) setRadioToken(hashToken);
      if (hashSk || hashPage || hashToken) {
        const params = new URLSearchParams(window.location.hash.slice(1));
        if (hashSk) params.delete('sk');
        if (hashPage) params.delete('page');
        if (hashToken) params.delete('token');
        const remaining = params.toString();
        window.history.replaceState(null, '', window.location.pathname + window.location.search + (remaining ? `#${remaining}` : ''));
      }

      const authInfo = await getAuthInfo();
      setInfo(authInfo);
      if (isIosClient) setTrusted(canTrustDevice(authInfo));
      if (authInfo.remote || authInfo.required) (window as unknown as Record<string, unknown>).__GROVE_REMOTE__ = true;
      if (!authInfo.required) { setAuthState('authenticated'); return; }

      if (authInfo.device_sessions) {
        const master = offeredSecret.current ?? getSecretKey();
        offeredSecret.current = master;
        clearSecretKey();
        if (!getDeviceId()) restoreRememberedDeviceSession();
        let session: Awaited<ReturnType<typeof getAuthSession>> | null = null;
        try { session = await getAuthSession(); }
        catch (err) {
          if (!(err instanceof AuthRequestError && err.status === 401)) throw err;
          if (err.code === 'AUTH_REVOKED') clearDeviceSession();
          else if (getDeviceId()) throw err;
          if (!master) throw err;
        }
        if (session?.device) {
          if (getDeviceId() !== session.device.id) setDeviceSession(session.device.id);
        } else if (master) {
          await loginDevice(master, false);
        } else throw new AuthRequestError(401, 'Sign in again');
        offeredSecret.current = null;
      } else {
        const master = offeredSecret.current ?? getSecretKey();
        if (!master) { setAuthState('needs_auth'); return; }
        await legacyLogin(master);
        offeredSecret.current = null;
      }
      setAuthState('authenticated');
    } catch (err) {
      if (err instanceof AuthRequestError && err.status === 401
        && (err.code === 'AUTH_REVOKED' || !getDeviceId())) {
        offeredSecret.current = null;
        if (err.code === 'AUTH_REVOKED') clearDeviceSession();
        else clearSecretKey();
        setAuthState('needs_auth');
      } else {
        // Only explicit revocation invalidates an existing device credential.
        setError('Unable to connect to Grove. Your saved sign-in has been kept.');
        setAuthState('connection_error');
      }
    } finally { initializing.current = false; }
  }, [legacyLogin]);

  useEffect(() => { void Promise.resolve().then(initialize); }, [initialize]);

  useEffect(() => {
    if (authState === 'loading' || authState === 'connection_error') return;
    const sync = () => {
      if (isAuthTransitionPending()) return;
      const deviceId = info?.device_sessions ? getDeviceId() : null;
      const signingKey = info?.device_sessions ? getDeviceSigningKey() : getSecretKey();
      handRemoteAuthToShell(authState === 'authenticated' && signingKey
        ? { deviceId, signingKey } : null);
    };
    sync();
    window.addEventListener(AUTH_CHANGED_EVENT, sync);
    return () => window.removeEventListener(AUTH_CHANGED_EVENT, sync);
  }, [authState, info?.device_sessions]);

  useEffect(() => {
    const expired = () => {
      if (authState !== 'authenticated' || !info?.required || isAuthTransitionPending()) return;
      clearDeviceSession();
      setSkInput('');
      setError('Signed out.');
      setAuthState('needs_auth');
      handRemoteAuthToShell(null);
    };
    const unsubscribe = subscribeToLogout(() => {
      setSkInput('');
      setError(null);
      setAuthState('needs_auth');
      handRemoteAuthToShell(null);
    });
    window.addEventListener(AUTH_EXPIRED_EVENT, expired);
    return () => { unsubscribe(); window.removeEventListener(AUTH_EXPIRED_EVENT, expired); };
  }, [authState, info?.required]);

  useEffect(() => {
    if (authState === 'authenticated') return;
    const online = () => { void initialize(); };
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, [authState, initialize]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (verifying) return;
    setVerifying(true);
    setError(null);
    try {
      if (trusted && (!info || !canTrustDevice(info))) {
        throw new AuthRequestError(409, 'Update Grove to remember this device.');
      }
      if (info?.device_sessions) {
        await loginDevice(skInput, trusted, canUseTrustedDeviceCookie(info));
      } else { await legacyLogin(skInput); }
      setSkInput('');
      offeredSecret.current = null;
      setAuthState('authenticated');
    } catch (err) {
      if (err instanceof AuthRequestError && err.status === 401) {
        clearSecretKey();
        setError('Invalid secret key or authorization. Please try again.');
      } else if (err instanceof AuthRequestError && err.status === 409) { setError(err.message); }
      else { setError('Connection failed. Please try again.'); }
    } finally { setVerifying(false); }
  };

  if (authState === 'loading') return (
    <div className="flex min-h-dvh items-center justify-center bg-[var(--color-bg)]">
      <div className="flex flex-col items-center gap-6">
        <div role="status" aria-label="Connecting" className="w-8 h-8 border-2 border-[var(--color-highlight)] border-t-transparent rounded-full animate-spin" />
        {isIosClient && <a href="/_grove/" className="text-sm text-[var(--color-text-muted)] py-3">Switch server</a>}
      </div>
    </div>
  );
  if (authState === 'authenticated') return <>{children}</>;

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-[var(--color-bg)] p-4">
      <GroveHeroBackground />
      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <GroveIcon size={96} grow />
          <h1 className="mt-5 mb-2 text-2xl font-semibold tracking-tight text-[var(--color-text)]">Welcome back</h1>
          <p className="text-sm text-[var(--color-text-muted)]">{authState === 'connection_error' ? 'Connection unavailable' : 'Enter the secret key to continue'}</p>
        </div>
        {authState === 'connection_error' ? (
          <div className="space-y-4">
            <p role="alert" className="text-sm text-[var(--color-text-muted)]">{error}</p>
            <button onClick={() => { void initialize(); }} className="w-full py-3 bg-[var(--color-highlight)] hover:opacity-90 text-white rounded-lg text-sm">Retry connection</button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <input type="password" name="password" autoComplete="current-password" value={skInput}
              onChange={event => { setSkInput(event.target.value); setError(null); }}
              placeholder="Secret key" aria-label="Secret key" autoFocus
              className="w-full px-4 py-3 bg-[var(--color-bg-secondary)]/80 backdrop-blur-sm border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)] font-mono text-sm" />
            {info?.required && (
              // Native checkbox (as a switch) inside a label, so the whole card toggles it.
              <label className="flex min-h-11 cursor-pointer select-none items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/80 px-4 py-3 backdrop-blur-sm">
                <span className="min-w-0 text-sm text-[var(--color-text)]">Remember this device</span>
                <input type="checkbox" role="switch" checked={trusted} onChange={event => setTrusted(event.target.checked)} className="peer sr-only" />
                <span aria-hidden className="relative h-5 w-9 flex-shrink-0 rounded-full bg-[var(--color-bg-tertiary)] ring-1 ring-inset ring-[var(--color-border)] transition-colors peer-checked:bg-[var(--color-highlight)] peer-checked:ring-transparent peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--color-highlight)]/40 after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-4" />
              </label>
            )}
            {error && <p role="alert" className="text-[var(--color-error)] text-xs">{error}</p>}
            <button type="submit" disabled={!skInput || verifying} className="w-full py-3 bg-[var(--color-highlight)] hover:opacity-90 disabled:opacity-40 text-white rounded-lg font-medium text-sm transition-opacity">
              {verifying ? 'Connecting…' : 'Connect'}
            </button>
          </form>
        )}
        {isIosClient && <a href="/_grove/" className="mt-5 block py-3 text-center text-sm text-[var(--color-text-muted)]">Switch or add server</a>}
      </div>
    </div>
  );
}
