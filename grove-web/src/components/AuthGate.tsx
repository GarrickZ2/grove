import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import {
  extractSkFromUrl, extractPageFromUrl, extractRadioTokenFromUrl,
  getSecretKey, setSecretKey, clearSecretKey, getDeviceId, getDeviceSigningKey, clearDeviceSession,
  setDeviceSession, restoreRememberedDeviceSession, setPageIntent, setRadioToken, AUTH_CHANGED_EVENT, AUTH_EXPIRED_EVENT, getApiBaseUrl, isAuthTransitionPending,
} from '../api/client';
import {
  AuthRequestError, canTrustDevice, canUseTrustedDeviceCookie, getAuthInfo,
  getAuthSession, loginDevice, subscribeToLogout, type AuthInfo,
} from '../api/auth';
import { hmacSha256Hex } from '../api/hmac';
import { handRemoteAuthToShell } from '../utils/tauriShell';
import { Checkbox } from './ui/Checkbox';

type AuthState = 'loading' | 'authenticated' | 'needs_auth' | 'connection_error';

export function AuthGate({ children }: { children: ReactNode }) {
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [info, setInfo] = useState<AuthInfo | null>(null);
  const [skInput, setSkInput] = useState('');
  const [trusted, setTrusted] = useState(false);
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
    <div className="flex min-h-dvh items-center justify-center bg-[#0a0a0a]">
      <div role="status" aria-label="Connecting" className="w-8 h-8 border-2 border-[#3b82f6] border-t-transparent rounded-full animate-spin" />
    </div>
  );
  if (authState === 'authenticated') return <>{children}</>;

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[#0a0a0a] p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-white mb-2">Grove</h1>
          <p className="text-[#888] text-sm">{authState === 'connection_error' ? 'Connection unavailable' : 'Enter the secret key to continue'}</p>
        </div>
        {authState === 'connection_error' ? (
          <div className="space-y-4">
            <p role="alert" className="text-sm text-[#aaa]">{error}</p>
            <button onClick={() => { void initialize(); }} className="w-full py-3 bg-[#3b82f6] text-white rounded-lg text-sm">Retry connection</button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <input type="password" name="password" autoComplete="current-password" value={skInput}
              onChange={event => { setSkInput(event.target.value); setError(null); }}
              placeholder="Secret key" aria-label="Secret key" autoFocus
              className="w-full px-4 py-3 bg-[#1a1a1a] border border-[#333] rounded-lg text-white placeholder-[#666] focus:outline-none focus:ring-1 focus:ring-[#3b82f6] font-mono text-sm" />
            {info?.required && (
              <Checkbox checked={trusted} onChange={setTrusted} label="Trust this device"
                className="min-h-11 gap-2.5 text-sm text-[#bbb] transition-colors hover:text-white [--color-bg:#1a1a1a] [--color-border:#444] [--color-highlight:#3b82f6]" />
            )}
            {error && <p role="alert" className="text-red-400 text-xs">{error}</p>}
            <button type="submit" disabled={!skInput || verifying} className="w-full py-3 bg-[#3b82f6] hover:bg-[#2563eb] disabled:bg-[#333] disabled:text-[#666] text-white rounded-lg font-medium text-sm">
              {verifying ? 'Connecting…' : 'Connect'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
