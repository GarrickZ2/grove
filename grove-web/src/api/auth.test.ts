// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient, AUTH_EXPIRED_EVENT, appendHmacToUrl, clearDeviceSession, getDeviceId, getSecretKey, getSignedHeaders, restoreRememberedDeviceSession, setDeviceSession, setSecretKey } from './client';
import { AUTH_LOGOUT_EVENT, getAuthSession, loginDevice, logoutDevice, subscribeToLogout, trustCurrentDevice } from './auth';
import { hmacSha256Hex } from './hmac';

const device = { id: 'a'.repeat(64), name: 'iPhone · Safari', client: 'iPhone · Safari', trusted: false, created_at: 100, last_used_at: 100 };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('device authorizations', () => {
  beforeEach(() => {
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      get length() { return stored.size; },
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); },
      clear: () => { stored.clear(); },
    });
    sessionStorage.clear();
    localStorage.clear();
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
  });
  afterEach(() => { clearDeviceSession(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('replaces the master key with a device-scoped signing key and signs the WS device ID', async () => {
    setSecretKey('master-secret');
    const fetchMock = vi.fn().mockImplementation(async (path: string) => {
      const id = new URL(path, window.location.origin).searchParams.get('device_id');
      return json({ ...device, id });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await loginDevice('master-secret', false);
    expect(getSecretKey()).toBeNull();
    expect(getDeviceId()).toBe(result.id);
    expect(localStorage.getItem(`grove_auth_remembered:${window.location.origin}`)).toBeNull();
    const headers = await getSignedHeaders('GET', '/api/v1/example');
    const derived = await hmacSha256Hex('master-secret', `grove-device-key-v1|${result.id}`);
    expect(headers['X-Device-Id']).toBe(result.id);
    expect(headers['X-Signature']).toBe(await hmacSha256Hex(derived,
      `${headers['X-Timestamp']}|${headers['X-Nonce']}|GET|/api/v1/example`));
    const url = new URL(await appendHmacToUrl('ws://localhost/api/v1/example?session_id=chat'));
    expect(url.searchParams.get('device_id')).toBe(result.id);
    expect(url.searchParams.get('sig')).toBe(await hmacSha256Hex(derived,
      `${url.searchParams.get('ts')}|${url.searchParams.get('nonce')}|GET|/api/v1/example?device_id=${result.id}&session_id=chat`));
  });

  it('retains a tab authorization on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(device)));
    await loginDevice('master-secret', false);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    await expect(getAuthSession()).rejects.toThrow('offline');
    expect(getDeviceId()).toBe(device.id);
    expect(sessionStorage.getItem('grove_auth_device_key')).toBeTruthy();
  });

  it('keeps one browser identity across tabs and logout while rotating authorization IDs', async () => {
    const fetchMock = vi.fn().mockImplementation(async (path: string) =>
      json({ ...device, id: new URL(path, window.location.origin).searchParams.get('device_id') }));
    vi.stubGlobal('fetch', fetchMock);
    const first = await loginDevice('master-secret', false);
    const firstQuery = new URL(fetchMock.mock.calls[0][0], window.location.origin).searchParams;
    clearDeviceSession();
    sessionStorage.clear();
    const second = await loginDevice('master-secret', false);
    const secondQuery = new URL(fetchMock.mock.calls[1][0], window.location.origin).searchParams;
    expect(secondQuery.get('browser_id')).toBe(firstQuery.get('browser_id'));
    expect(second.id).not.toBe(first.id);
    expect(localStorage.getItem(`grove_auth_remembered:${window.location.origin}`)).toBeNull();
    expect(localStorage.getItem(`grove_auth_browser:${window.location.origin}`)).toBe(firstQuery.get('browser_id'));
  });

  it('expires the current device globally only for the explicit revocation error', async () => {
    setDeviceSession(device.id, 'b'.repeat(64));
    const expired = vi.fn();
    window.addEventListener(AUTH_EXPIRED_EVENT, expired);
    try {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Invalid signature', {
        status: 401, headers: { 'x-grove-auth-required': '1', 'x-grove-auth-error': 'AUTH_REQUIRED' },
      })));
      await expect(apiClient.get('/api/v1/config')).rejects.toMatchObject({ status: 401 });
      expect(expired).not.toHaveBeenCalled();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'AUTH_REVOKED', message: 'Unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      })));
      await expect(getAuthSession()).rejects.toMatchObject({ status: 401, code: 'AUTH_REVOKED' });
      expect(expired).toHaveBeenCalledOnce();
    } finally { window.removeEventListener(AUTH_EXPIRED_EVENT, expired); }
  });

  it.each(['header', 'body'])('preserves the authorization error code from the response %s', async source => {
    setDeviceSession(device.id, 'b'.repeat(64));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      message: 'Invalid signature', ...(source === 'body' ? { code: 'AUTH_REQUIRED' } : {}),
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', ...(source === 'header' ? { 'x-grove-auth-error': 'AUTH_REQUIRED' } : {}) },
    })));
    await expect(getAuthSession()).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
    expect(getDeviceId()).toBe(device.id);
  });

  it('remembers a revocable HTTP device key across tabs without persisting the startup password', async () => {
    let trusted = { ...device, trusted: true };
    const fetchMock = vi.fn().mockImplementation(async (path: string) => {
      if (path.startsWith('/api/v1/auth/login?')) {
        trusted = { ...trusted, id: new URL(path, window.location.origin).searchParams.get('device_id')! };
        return json(trusted);
      }
      return json({ device: trusted, required: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    await loginDevice('master-secret', true, false);
    const key = sessionStorage.getItem('grove_auth_device_key');
    expect(key).toBe(await hmacSha256Hex('master-secret', `grove-device-key-v1|${trusted.id}`));
    const persisted = localStorage.getItem(`grove_auth_remembered:${window.location.origin}`)!;
    expect(persisted).toContain(key!);
    expect(persisted).not.toContain('master-secret');
    expect(persisted).not.toContain('expiresAt');
    expect(fetchMock.mock.calls[0][0]).toContain('cookie=false');
    sessionStorage.clear();
    restoreRememberedDeviceSession();
    expect(getDeviceId()).toBe(trusted.id);
    expect(sessionStorage.getItem('grove_auth_device_key')).toBe(key);
    expect(getSecretKey()).toBeNull();
    clearDeviceSession();
    expect(localStorage.getItem(`grove_auth_remembered:${window.location.origin}`)).toBeNull();
  });

  it('does not report successful logout or lose remembered sign-in when the API fails', async () => {
    const trusted = { ...device, trusted: true };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(trusted)).mockResolvedValueOnce(json({ device: trusted, required: true })));
    await loginDevice('master-secret', true, false);
    const saved = localStorage.getItem(`grove_auth_remembered:${window.location.origin}`);
    const signedOut = vi.fn();
    window.addEventListener(AUTH_LOGOUT_EVENT, signedOut);
    try {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
      await expect(logoutDevice()).rejects.toThrow('offline');
      expect(signedOut).not.toHaveBeenCalled();
      expect(getDeviceId()).toBe(trusted.id);
      expect(localStorage.getItem(`grove_auth_remembered:${window.location.origin}`)).toBe(saved);
    } finally { window.removeEventListener(AUTH_LOGOUT_EVENT, signedOut); }
  });

  it('restores remembered credentials without imposing an expiry, including older saved records', () => {
    const storageKey = `grove_auth_remembered:${window.location.origin}`;
    localStorage.setItem(storageKey, JSON.stringify({ id: device.id, signingKey: 'b'.repeat(64), expiresAt: 1 }));
    restoreRememberedDeviceSession();
    expect(getDeviceId()).toBe(device.id);
    expect(localStorage.getItem(storageKey)).not.toBeNull();
  });

  it('keeps temporary authorization only in its tab without a persistent credential or time limit', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(device)));
    await loginDevice('master-secret', false);
    expect(sessionStorage.getItem('grove_auth_device_key')).toBeTruthy();
    expect(localStorage.getItem(`grove_auth_remembered:${window.location.origin}`)).toBeNull();
    sessionStorage.clear();
    restoreRememberedDeviceSession();
    expect(getDeviceId()).toBeNull();
    expect(await getSignedHeaders('GET', '/api/v1/example')).toEqual({ 'Content-Type': 'application/json' });
  });

  it('can remember an existing HTTP signed session without rotating or transmitting its signing key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(device)));
    await loginDevice('master-secret', false);
    const key = sessionStorage.getItem('grove_auth_device_key');
    const trusted = { ...device, trusted: true };
    const fetchMock = vi.fn().mockResolvedValueOnce(json(trusted)).mockResolvedValueOnce(json({ device: trusted, required: true }));
    vi.stubGlobal('fetch', fetchMock);
    await trustCurrentDevice(false);
    expect(getDeviceId()).toBe(device.id);
    expect(sessionStorage.getItem('grove_auth_device_key')).toBe(key);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/auth/trust?cookie=false');
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(key!);
  });

  it('does not expire a new login when an earlier unauthenticated request returns 401', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; })));
    const expired = vi.fn();
    window.addEventListener(AUTH_EXPIRED_EVENT, expired);
    try {
      const request = apiClient.get('/api/v1/config').catch(error => error);
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      setDeviceSession(device.id);
      finish(new Response('Unauthorized', { status: 401, headers: { 'x-grove-auth-required': '1', 'x-grove-auth-error': 'AUTH_REVOKED' } }));
      expect(await request).toMatchObject({ status: 401 });
      expect(expired).not.toHaveBeenCalled();
      expect(getDeviceId()).toBe(device.id);
    } finally { window.removeEventListener(AUTH_EXPIRED_EVENT, expired); }
  });

  it('ignores a delayed cookie rejection from a replaced authorization even without a device response header', async () => {
    let finish!: (response: Response) => void;
    setDeviceSession(device.id);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; })));
    const expired = vi.fn();
    window.addEventListener(AUTH_EXPIRED_EVENT, expired);
    try {
      const request = apiClient.get('/api/v1/config').catch(error => error);
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      setDeviceSession('b'.repeat(64));
      finish(new Response('Unauthorized', { status: 401, headers: { 'x-grove-auth-required': '1', 'x-grove-auth-error': 'AUTH_REVOKED' } }));
      expect(await request).toMatchObject({ status: 401 });
      expect(expired).not.toHaveBeenCalled();
    } finally { window.removeEventListener(AUTH_EXPIRED_EVENT, expired); }
  });

  it('clears authorization and notifies other tabs only after successful logout', async () => {
    setDeviceSession(device.id, 'b'.repeat(64));
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; })));
    const signedOut = vi.fn();
    const stop = subscribeToLogout(signedOut);
    try {
      const request = logoutDevice();
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      expect(getDeviceId()).toBe(device.id);
      expect(signedOut).not.toHaveBeenCalled();
      finish(new Response(null, { status: 204 }));
      await request;
      expect(getDeviceId()).toBeNull();
      expect(signedOut).toHaveBeenCalledOnce();
      setDeviceSession('c'.repeat(64));
      window.dispatchEvent(new StorageEvent('storage', {
        key: `grove_auth_signed_out:${window.location.origin}`, newValue: JSON.stringify({ id: device.id }),
      }));
      expect(signedOut).toHaveBeenCalledOnce();
      expect(getDeviceId()).toBe('c'.repeat(64));
    } finally { stop(); }
  });

  it('keeps HTTPS cookie credentials out of JavaScript storage and checks the cookie round trip', async () => {
    const trusted = { ...device, trusted: true };
    const fetchMock = vi.fn().mockResolvedValueOnce(json(trusted)).mockResolvedValueOnce(json({ device: trusted, required: true }));
    vi.stubGlobal('fetch', fetchMock);
    await loginDevice('master-secret', true, true);
    expect(sessionStorage.getItem('grove_auth_device_key')).toBeNull();
    expect(getSecretKey()).toBeNull();
    expect(await getSignedHeaders('GET', '/api/v1/example')).toEqual({ 'Content-Type': 'application/json' });
    expect(fetchMock.mock.calls[1][0]).toMatch(/^\/api\/v1\/auth\/session\?browser_id=[a-f0-9]{64}$/);
  });

  it('upgrades a tab and ignores delayed authorization failures from its old device ID', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(device)));
    await loginDevice('master-secret', false);
    const trusted = { ...device, id: 'b'.repeat(64), trusted: true };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(trusted)).mockResolvedValueOnce(json({ device: trusted, required: true })));
    await trustCurrentDevice(true);
    expect(getDeviceId()).toBe(trusted.id);
    expect(sessionStorage.getItem('grove_auth_device_key')).toBeNull();
    const expired = vi.fn();
    window.addEventListener(AUTH_EXPIRED_EVENT, expired);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Unauthorized', {
      status: 401, headers: { 'x-grove-auth-required': '1', 'x-grove-auth-error': 'AUTH_REVOKED', 'x-grove-device-id': device.id },
    })));
    await expect(apiClient.get('/api/v1/example')).rejects.toMatchObject({ status: 401 });
    expect(expired).not.toHaveBeenCalled();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Unauthorized', {
      status: 401, headers: { 'x-grove-auth-required': '1', 'x-grove-auth-error': 'AUTH_REVOKED', 'x-grove-device-id': trusted.id },
    })));
    await expect(apiClient.get('/api/v1/example')).rejects.toMatchObject({ status: 401 });
    expect(expired).toHaveBeenCalledOnce();
    window.removeEventListener(AUTH_EXPIRED_EVENT, expired);
  });
});
