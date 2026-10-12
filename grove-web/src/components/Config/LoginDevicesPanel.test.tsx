import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canTrustDevice, getAuthInfo, listLoginDevices, revokeLoginDevice, logoutDevice, trustCurrentDevice } from '../../api/auth';
import { LoginDevicesPanel } from './LoginDevicesPanel';

vi.mock('../../api/auth', () => ({
  getAuthInfo: vi.fn(), listLoginDevices: vi.fn(),
  canTrustDevice: vi.fn(), canUseTrustedDeviceCookie: () => false, logoutDevice: vi.fn(), renameLoginDevice: vi.fn(),
  revokeLoginDevice: vi.fn(), trustCurrentDevice: vi.fn(),
}));
vi.mock('../ui/DialogShell', () => ({
  DialogShell: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) => isOpen ? <div role="dialog">{children}</div> : null,
}));

describe('Login devices on local Grove Web', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(getAuthInfo).mockResolvedValue({ required: false, device_sessions: true });
    vi.mocked(canTrustDevice).mockReturnValue(false);
    vi.mocked(listLoginDevices).mockResolvedValue({ devices: [{
      id: 'local-management-id', name: 'My iPhone', client: 'iPhone · Safari', trusted: true,
      created_at: 100, last_used_at: 100,
      port: 3001,
    }], current_device_id: null, required: false });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it('lists Mobile authorizations and can sign them out without logging out the local Web UI', async () => {
    await act(async () => root.render(<LoginDevicesPanel />));
    expect(container.textContent).toContain('My iPhone');
    expect(container.textContent).not.toContain('This device');
    expect(container.textContent).not.toContain('Sign out all');
    const signOut = container.querySelector('button[aria-label="Sign out My iPhone"]') as HTMLButtonElement;
    vi.mocked(listLoginDevices).mockResolvedValue({ devices: [], current_device_id: null, required: false });
    await act(async () => signOut.click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(revokeLoginDevice).toHaveBeenCalledWith('local-management-id');
    expect(container.textContent).toContain('No active device authorizations');
  });

  it('trusts the current device immediately without a confirmation step or duration copy', async () => {
    const current = { id: 'current-device', name: 'My iPhone', client: 'iPhone · Safari', trusted: false, created_at: 100, last_used_at: 100 };
    vi.mocked(canTrustDevice).mockReturnValue(true);
    vi.mocked(listLoginDevices).mockResolvedValue({ devices: [current], current_device_id: current.id, required: true });
    await act(async () => root.render(<LoginDevicesPanel />));
    const trust = container.querySelector('button[aria-label="Trust this device"]') as HTMLButtonElement;
    await act(async () => trust.click());
    expect(trustCurrentDevice).toHaveBeenCalledWith(false);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).not.toContain('30 days');
    expect(container.textContent).not.toContain('Expires');
  });

  it('groups multiple ports and signs out only the selected authorization, then collapses to a flat list', async () => {
    const first = { id: 'port-3001-handle', name: 'My iPhone', client: 'iPhone · Safari', trusted: true, created_at: 100, last_used_at: 100, port: 3001 };
    const second = { ...first, id: 'port-3002-handle', port: 3002 };
    vi.mocked(listLoginDevices).mockResolvedValue({ devices: [second, first], current_device_id: null, required: false });
    await act(async () => root.render(<LoginDevicesPanel />));
    expect([...container.querySelectorAll('h3')].map(heading => heading.textContent)).toEqual(['Port 3001', 'Port 3002']);
    const group = container.querySelector('section[aria-label="Port 3002"]')!;
    expect(group.textContent).toContain('My iPhone');
    const signOut = group.querySelector('button[aria-label="Sign out My iPhone"]') as HTMLButtonElement;
    vi.mocked(listLoginDevices).mockResolvedValue({ devices: [first], current_device_id: null, required: false });
    await act(async () => signOut.click());
    expect(revokeLoginDevice).toHaveBeenCalledOnce();
    expect(revokeLoginDevice).toHaveBeenCalledWith(second.id);
    expect(container.querySelector('h3')).toBeNull();
    expect(container.textContent).toContain('My iPhone');
  });

  it('keeps the device visible and reports failure when sign-out fails', async () => {
    const current = { id: 'current-device', name: 'My iPhone', client: 'iPhone · Safari', trusted: true, created_at: 100, last_used_at: 100 };
    vi.mocked(listLoginDevices).mockResolvedValue({ devices: [current], current_device_id: current.id, required: true });
    vi.mocked(logoutDevice).mockRejectedValue(new Error('offline'));
    await act(async () => root.render(<LoginDevicesPanel />));
    await act(async () => (container.querySelector('button[aria-label="Sign out My iPhone"]') as HTMLButtonElement).click());
    expect(container.textContent).toContain('My iPhone');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Unable to sign out');
    expect(listLoginDevices).toHaveBeenCalledOnce();
  });

  it('shows a rebuild notice on an old backend instead of hiding device management', async () => {
    vi.mocked(getAuthInfo).mockResolvedValue({ required: false });
    await act(async () => root.render(<LoginDevicesPanel />));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Rebuild and restart Grove');
    expect(listLoginDevices).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('No active device authorizations');
  });
});
