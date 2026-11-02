// @vitest-environment-options {"url":"https://grove.test/"}

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDeviceSession, setDeviceSession } from '../api/client';
import { AuthRequestError, getAuthInfo, getAuthSession, loginDevice } from '../api/auth';
import { AuthGate } from './AuthGate';

vi.mock('../api/auth', async importOriginal => ({
  ...await importOriginal<typeof import('../api/auth')>(),
  getAuthInfo: vi.fn(), getAuthSession: vi.fn(), loginDevice: vi.fn(),
}));
vi.mock('../utils/tauriShell', () => ({ handRemoteAuthToShell: vi.fn() }));

const device = {
  id: 'b'.repeat(64), name: 'Mac', client: 'Mac · Safari', trusted: false,
  created_at: 100, last_used_at: 100,
};

describe('AuthGate in Orbit', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const stored = new Map<string, string>([['grove:interface', 'orbit']]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); },
    });
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
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function submit(secret: string) {
    const password = container.querySelector('input[aria-label="Secret key"]') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(password, secret);
      password.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  }

  it('uses the Orbit sign-in when Orbit was the last interface', async () => {
    await act(async () => root.render(<AuthGate><div>Signed in</div></AuthGate>));
    expect(container.querySelector('.oas')).not.toBeNull();
    expect(container.querySelector('input[role="switch"]')).not.toBeNull();
  });

  it('marks a wrong key invalid and says why', async () => {
    vi.mocked(loginDevice).mockRejectedValue(new AuthRequestError(401, 'Unauthorized'));
    await act(async () => root.render(<AuthGate><div>Signed in</div></AuthGate>));
    await submit('wrong');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Invalid secret key');
    expect(container.querySelector('.oas-field.is-bad')).not.toBeNull();
    expect(container.querySelector('input[aria-label="Secret key"]')?.getAttribute('aria-invalid')).toBe('true');
    expect(container.textContent).not.toContain('Signed in');
  });

  it('turns the button green before handing off to the app', async () => {
    vi.useFakeTimers();
    vi.mocked(loginDevice).mockImplementation(async () => { setDeviceSession(device.id); return device; });
    await act(async () => root.render(<AuthGate><div>Signed in</div></AuthGate>));
    await submit('right');
    expect(loginDevice).toHaveBeenCalledWith('right', false, false);
    expect(container.querySelector('.oas-go.is-ok')?.textContent).toContain('Connected');
    expect(container.textContent).not.toContain('Signed in');
    await act(async () => { vi.advanceTimersByTime(700); });
    expect(container.textContent).toContain('Signed in');
  });
});
