// @vitest-environment-options {"url":"https://grove.test/"}

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_EXPIRED_EVENT, apiClient, clearDeviceSession, getDeviceId, getSecretKey, setDeviceSession } from '../api/client';
import { AuthRequestError, getAuthInfo, getAuthSession, loginDevice } from '../api/auth';
import { AuthGate } from './AuthGate';
import { handRemoteAuthToShell } from '../utils/tauriShell';

vi.mock('../api/auth', async importOriginal => ({
  ...await importOriginal<typeof import('../api/auth')>(),
  getAuthInfo: vi.fn(), getAuthSession: vi.fn(), loginDevice: vi.fn(),
}));
vi.mock('../utils/tauriShell', () => ({ handRemoteAuthToShell: vi.fn() }));

const device = {
  id: 'a'.repeat(64), name: 'iPhone', client: 'iPhone · Safari', trusted: true,
  created_at: 100, last_used_at: 100,
};

describe('AuthGate sign-in screen', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); },
    });
    sessionStorage.clear();
    window.history.replaceState(null, '', '/');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(getAuthInfo).mockResolvedValue({ required: true, device_sessions: true, trusted_devices: true, trusted_device_cookies: false });
    vi.mocked(getAuthSession).mockRejectedValue(new AuthRequestError(401, 'Unauthorized'));
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(null, { status: 204 })));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    clearDeviceSession();
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows an enabled unchecked trust option even without HTTPS cookies, without an expiry alert', async () => {
    await act(async () => root.render(<AuthGate><div>Signed in</div></AuthGate>));
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox).not.toBeNull();
    expect(checkbox.disabled).toBe(false);
    expect(checkbox.checked).toBe(false);
    expect(container.textContent).not.toContain('Remembered sign-in');
    expect(container.textContent).not.toContain('30 days');
  });

  it('ignores unauthorized startup requests made before signing in', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Unauthorized', {
      status: 401, headers: { 'x-grove-auth-required': '1' },
    })));
    await act(async () => {
      root.render(<AuthGate><div>Signed in</div></AuthGate>);
      await apiClient.get('/api/v1/config').catch(() => {});
    });
    act(() => window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT)));
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('allows choosing trust when remembered sign-in is available', async () => {
    vi.mocked(getAuthInfo).mockResolvedValue({ required: true, device_sessions: true, trusted_devices: true });
    vi.mocked(loginDevice).mockImplementation(async () => { setDeviceSession(device.id); return device; });
    await act(async () => root.render(<AuthGate><div>Signed in</div></AuthGate>));
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.disabled).toBe(false);
    act(() => checkbox.click());
    expect(checkbox.checked).toBe(true);
    const password = container.querySelector('input[type="password"]') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(password, 'test-secret');
      password.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(loginDevice).toHaveBeenCalledWith('test-secret', true, true);
    expect(container.textContent).toContain('Signed in');
    expect(container.textContent).not.toContain('Remembered sign-in');
  });

  it('sends a remembered HMAC login when secure cookies are unavailable', async () => {
    vi.mocked(loginDevice).mockImplementation(async () => { setDeviceSession(device.id); return device; });
    await act(async () => root.render(<AuthGate><div>Signed in</div></AuthGate>));
    act(() => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    const password = container.querySelector('input[type="password"]') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(password, 'test-secret');
      password.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(loginDevice).toHaveBeenCalledWith('test-secret', true, false);
    expect(container.textContent).toContain('Signed in');
  });

  it('keeps trust visible on old servers and does not silently save a master password', async () => {
    vi.mocked(getAuthInfo).mockResolvedValue({ required: true });
    await act(async () => root.render(<AuthGate><div>Signed in</div></AuthGate>));
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.disabled).toBe(false);
    act(() => checkbox.click());
    const password = container.querySelector('input[type="password"]') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(password, 'test-secret');
      password.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Update Grove to remember this device.');
    expect(loginDevice).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('grove_auth_sk')).toBeNull();
  });

  it('restores the remembered device before checking its session on a new tab', async () => {
    localStorage.setItem(`grove_auth_remembered:${window.location.origin}`, JSON.stringify({
      id: device.id, signingKey: 'b'.repeat(64),
    }));
    vi.mocked(getAuthSession).mockResolvedValue({ device, required: true });
    await act(async () => root.render(<AuthGate><div>Signed in</div></AuthGate>));
    expect(container.textContent).toBe('Signed in');
    expect(sessionStorage.getItem('grove_auth_device_key')).toBe('b'.repeat(64));
    expect(sessionStorage.getItem('grove_auth_sk')).toBeNull();
  });

  it.each([undefined, 'AUTH_REQUIRED'])('keeps remembered authorization after a startup 401 with code %s and can retry', async code => {
    const storageKey = `grove_auth_remembered:${window.location.origin}`;
    const remembered = JSON.stringify({ id: device.id, signingKey: 'b'.repeat(64) });
    localStorage.setItem(storageKey, remembered);
    window.history.replaceState(null, '', '/#sk=qr-secret');
    vi.mocked(getAuthSession).mockRejectedValue(new AuthRequestError(401, 'Invalid signature', code));
    await act(async () => root.render(<AuthGate><div>Signed in</div></AuthGate>));
    expect(localStorage.getItem(storageKey)).toBe(remembered);
    expect(getDeviceId()).toBe(device.id);
    expect(sessionStorage.getItem('grove_auth_device_key')).toBe('b'.repeat(64));
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.textContent).toContain('Retry connection');
    expect(loginDevice).not.toHaveBeenCalled();

    vi.mocked(getAuthSession).mockResolvedValue({ device, required: true });
    await act(async () => (container.querySelector('button') as HTMLButtonElement).click());
    expect(container.textContent).toBe('Signed in');
    expect(localStorage.getItem(storageKey)).toBe(remembered);
    expect(loginDevice).not.toHaveBeenCalled();
  });

  it('clears remembered authorization at startup only for AUTH_REVOKED', async () => {
    const storageKey = `grove_auth_remembered:${window.location.origin}`;
    localStorage.setItem(storageKey, JSON.stringify({ id: device.id, signingKey: 'b'.repeat(64) }));
    vi.mocked(getAuthSession).mockRejectedValue(new AuthRequestError(401, 'Unauthorized', 'AUTH_REVOKED'));
    await act(async () => root.render(<AuthGate><div>Signed in</div></AuthGate>));
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(getDeviceId()).toBeNull();
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it.each([undefined, 'b'.repeat(64)])('preserves an existing trusted session when entering through a QR link (key %s)', async signingKey => {
    setDeviceSession(device.id, signingKey);
    vi.mocked(getAuthSession).mockResolvedValue({ device, required: true });
    window.history.replaceState(null, '', '/#sk=qr-secret&page=tasks');
    await act(async () => root.render(<AuthGate><div>Signed in</div></AuthGate>));
    expect(container.textContent).toBe('Signed in');
    expect(loginDevice).not.toHaveBeenCalled();
    expect(getDeviceId()).toBe(device.id);
    expect(getSecretKey()).toBeNull();
    expect(sessionStorage.getItem('grove_auth_device_key')).toBe(signingKey ?? null);
  });

  it('preserves remembered trust when reopening a QR link in a new tab', async () => {
    const storageKey = `grove_auth_remembered:${window.location.origin}`;
    const remembered = JSON.stringify({ id: device.id, signingKey: 'b'.repeat(64) });
    localStorage.setItem(storageKey, remembered);
    vi.mocked(getAuthSession).mockResolvedValue({ device, required: true });
    window.history.replaceState(null, '', '/#sk=qr-secret');
    await act(async () => root.render(<AuthGate><div>Signed in</div></AuthGate>));
    expect(container.textContent).toBe('Signed in');
    expect(loginDevice).not.toHaveBeenCalled();
    expect(localStorage.getItem(storageKey)).toBe(remembered);
    expect(getDeviceId()).toBe(device.id);
  });

  it('uses a QR secret only when the existing authorization is rejected', async () => {
    setDeviceSession(device.id, 'b'.repeat(64));
    vi.mocked(getAuthSession).mockRejectedValue(new AuthRequestError(401, 'Unauthorized', 'AUTH_REVOKED'));
    const replacement = { ...device, id: 'c'.repeat(64), trusted: false };
    vi.mocked(loginDevice).mockImplementation(async () => { setDeviceSession(replacement.id, 'd'.repeat(64)); return replacement; });
    window.history.replaceState(null, '', '/#sk=new-secret');
    await act(async () => root.render(<AuthGate><div>Signed in</div></AuthGate>));
    expect(container.textContent).toBe('Signed in');
    expect(loginDevice).toHaveBeenCalledWith('new-secret', false);
    expect(getDeviceId()).toBe(replacement.id);
  });

  it('still asks for sign-in when the current authenticated session is revoked', async () => {
    setDeviceSession(device.id);
    vi.mocked(getAuthSession).mockResolvedValue({ device, required: true });
    await act(async () => root.render(<AuthGate><div>Signed in</div></AuthGate>));
    expect(container.textContent).toBe('Signed in');
    act(() => window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT)));
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Signed out.');
    expect(handRemoteAuthToShell).toHaveBeenLastCalledWith(null);
  });

  it('shares only a restored device credential with the shell and updates it after trust rotation', async () => {
    setDeviceSession(device.id, 'b'.repeat(64));
    vi.mocked(getAuthSession).mockResolvedValue({ device, required: true });
    await act(async () => root.render(<AuthGate><div>Signed in</div></AuthGate>));
    expect(handRemoteAuthToShell).toHaveBeenLastCalledWith({ deviceId: device.id, signingKey: 'b'.repeat(64) });
    act(() => setDeviceSession('c'.repeat(64), 'd'.repeat(64)));
    expect(handRemoteAuthToShell).toHaveBeenLastCalledWith({ deviceId: 'c'.repeat(64), signingKey: 'd'.repeat(64) });
  });
});
