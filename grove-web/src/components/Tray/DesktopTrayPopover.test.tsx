import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AUTH_EXPIRED_EVENT, apiClient, clearTabAuthorization, getDeviceId, getSecretKey, getDeviceSigningKey, rememberDeviceSession } from '../../api/client';
import { AuthRequestError, getAuthSession } from '../../api/auth';
import { DesktopTrayPopover } from './DesktopTrayPopover';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('./TrayPopover', () => ({ TrayPopover: () => <div>Tray</div> }));
vi.mock('../Blitz/RadioConnectDialog', () => ({ RadioConnectDialog: () => null }));
vi.mock('../../api/auth', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/auth')>(), getAuthSession: vi.fn(),
}));

let root: Root;
let container: HTMLDivElement;
let changed: () => void;
const id = 'a'.repeat(64);
const key = 'b'.repeat(64);

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (name: string) => stored.get(name) ?? null,
    setItem: (name: string, value: string) => { stored.set(name, value); },
    removeItem: (name: string) => { stored.delete(name); },
  });
  sessionStorage.clear();
  vi.mocked(invoke).mockResolvedValue({ deviceId: id, signingKey: key });
  vi.mocked(listen).mockImplementation(async (_event, callback) => {
    changed = () => callback({ event: 'grove-remote-auth-changed', id: 1, payload: null });
    return vi.fn();
  });
  vi.spyOn(apiClient, 'get').mockResolvedValue({ required: true });
  vi.mocked(getAuthSession).mockResolvedValue({ device: { id, name: 'Mac', client: 'Mac', trusted: true, created_at: 1, last_used_at: 1 }, required: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  clearTabAuthorization();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it('uses the main device authorization and preserves its remembered login', async () => {
  rememberDeviceSession(id, key);
  await act(async () => root.render(<DesktopTrayPopover />));
  expect(container.textContent).toBe('Tray');
  expect(getDeviceId()).toBe(id);
  expect(getDeviceSigningKey()).toBe(key);
  expect(getSecretKey()).toBeNull();
  expect(localStorage.getItem(`grove_auth_remembered:${window.location.origin}`)).toContain(key);
  expect(invoke).toHaveBeenCalledWith('get_remote_auth');
});

it('unmounts on logout and takes the replacement device on a new login', async () => {
  await act(async () => root.render(<DesktopTrayPopover />));
  vi.mocked(invoke).mockResolvedValue(null);
  await act(async () => changed());
  expect(container.textContent).toBe('');
  expect(getDeviceId()).toBeNull();
  vi.mocked(invoke).mockResolvedValue({ deviceId: 'c'.repeat(64), signingKey: 'd'.repeat(64) });
  await act(async () => changed());
  expect(container.textContent).toBe('Tray');
  expect(getDeviceId()).toBe('c'.repeat(64));
});

it('does not render with a revoked credential retained in the shell', async () => {
  vi.mocked(getAuthSession).mockRejectedValue(new AuthRequestError(401, 'Unauthorized', 'AUTH_REVOKED'));
  await act(async () => root.render(<DesktopTrayPopover />));
  expect(container.textContent).toBe('');
  expect(getDeviceId()).toBeNull();
});

it('keeps credentials on a non-revocation 401 during tray startup', async () => {
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  rememberDeviceSession(id, key);
  vi.mocked(getAuthSession).mockRejectedValue(new AuthRequestError(401, 'Invalid signature', 'AUTH_REQUIRED'));
  await act(async () => root.render(<DesktopTrayPopover />));
  expect(container.textContent).toBe('');
  expect(getDeviceId()).toBe(id);
  expect(getDeviceSigningKey()).toBe(key);
  expect(localStorage.getItem(`grove_auth_remembered:${window.location.origin}`)).toContain(key);
  expect(errorLog).toHaveBeenCalledOnce();
});

it('stops the mounted tray when a request reports revocation', async () => {
  await act(async () => root.render(<DesktopTrayPopover />));
  vi.mocked(getAuthSession).mockRejectedValue(new AuthRequestError(401, 'Unauthorized'));
  await act(async () => window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT)));
  expect(container.textContent).toBe('');
});
