import { act, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listConnects, listConnectPlatforms, listProjects, verifyConnect, type ConnectItem } from '../../api';
import { ConnectDialog } from './ConnectSettings';

vi.mock('../../api', () => ({
  listConnects: vi.fn(), listConnectPlatforms: vi.fn(), listProjects: vi.fn(), verifyConnect: vi.fn(),
  beginConnectRegistration: vi.fn(), createConnect: vi.fn(), deleteConnect: vi.fn(),
  finishConnectRegistration: vi.fn(), getConnectRegistration: vi.fn(), getProject: vi.fn(),
  listChats: vi.fn(), listTasks: vi.fn(), updateConnect: vi.fn(), verifyConnectCredentials: vi.fn(),
}));
vi.mock('../../context', () => ({ useTheme: () => ({ theme: { accentPalette: ['#3370ff'] } }) }));
vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => ({ isMobile: false }) }));
vi.mock('../Dialogs', () => ({ ConfirmDialog: () => null }));
vi.mock('../ui', () => ({
  DialogShell: ({ isOpen, children }: { isOpen: boolean; children: ReactNode }) => isOpen ? <div role="dialog">{children}</div> : null,
  Button: ({ children, onClick, disabled }: ButtonHTMLAttributes<HTMLButtonElement>) => <button onClick={onClick} disabled={disabled}>{children}</button>,
  Input: ({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label?: string }) => <label>{label}<input {...props} /></label>,
  Switch: ({ checked, onChange, disabled }: { checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) => <button role="switch" aria-checked={checked} onClick={() => onChange(!checked)} disabled={disabled} />,
}));

const connection = (state: ConnectItem['runtime']['state']): ConnectItem => ({
  id: 'local', name: 'Local', platform: 'feishu', domain: 'feishu', enabled: true,
  adapter_config: { app_id: 'cli_test' }, project_id: '', task_id: '', session_id: '',
  created_at: 0, updated_at: 0, runtime: { state }, target: { agent: 'codex', state: 'idle', queue_mode: 'separate' },
});

describe('Connect runtime status refresh', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(listConnects).mockResolvedValue([connection('online')]);
    vi.mocked(listConnectPlatforms).mockResolvedValue([]);
    vi.mocked(listProjects).mockResolvedValue({ projects: [], current_project_id: null });
    vi.mocked(verifyConnect).mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  async function render(isOpen = true) {
    await act(async () => root.render(<ConnectDialog isOpen={isOpen} onClose={() => {}} />));
  }

  async function chooseConnection() {
    const button = [...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find((button) => button.textContent?.includes('Local'));
    expect(button).toBeDefined();
    await act(async () => button!.click());
  }

  function status() { return container.querySelector('span.capitalize')?.textContent; }

  async function verify() {
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Verify connection'));
    expect(button).toBeDefined();
    await act(async () => button!.click());
  }

  it('updates Connecting to Online after Verify without reopening or verifying again', async () => {
    await render();
    await chooseConnection();
    expect(status()).toBe('online');
    vi.mocked(listConnects).mockResolvedValue([connection('connecting')]);
    await verify();
    expect(status()).toBe('connecting');
    vi.mocked(listConnects).mockResolvedValue([connection('online')]);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(status()).toBe('online');
    expect(verifyConnect).toHaveBeenCalledOnce();
    expect(verifyConnect).toHaveBeenCalledWith('local');
    expect(listConnects).toHaveBeenCalledTimes(3);
  });

  it('keeps the previous state on a refresh error and retries the next poll', async () => {
    vi.mocked(listConnects).mockResolvedValue([connection('connecting')]);
    await render();
    await chooseConnection();
    vi.mocked(listConnects).mockRejectedValueOnce(new Error('temporary failure'));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(status()).toBe('connecting');
    vi.mocked(listConnects).mockResolvedValue([connection('error')]);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(status()).toBe('error');
  });

  it('does not let an older pending poll overwrite a newer Verify refresh', async () => {
    await render();
    await chooseConnection();
    let resolveOld!: (items: ConnectItem[]) => void;
    vi.mocked(listConnects).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    await verify();
    expect(status()).toBe('online');
    await act(async () => resolveOld([connection('connecting')]));
    expect(status()).toBe('online');
  });

  it('stops polling when the dialog closes and ignores responses from its previous opening', async () => {
    await render();
    await chooseConnection();
    let resolveOld!: (items: ConnectItem[]) => void;
    vi.mocked(listConnects).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    await render(false);
    const count = vi.mocked(listConnects).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(listConnects).toHaveBeenCalledTimes(count);
    await render();
    await chooseConnection();
    await act(async () => resolveOld([connection('connecting')]));
    expect(status()).toBe('online');
    const reopenedCount = vi.mocked(listConnects).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(listConnects).toHaveBeenCalledTimes(reopenedCount + 1);
  });

  it('does not overlap periodic refresh requests while an earlier poll is pending', async () => {
    await render();
    let resolvePending!: (items: ConnectItem[]) => void;
    vi.mocked(listConnects).mockImplementationOnce(() => new Promise((resolve) => { resolvePending = resolve; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    const count = vi.mocked(listConnects).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(listConnects).toHaveBeenCalledTimes(count);
    await act(async () => resolvePending([connection('online')]));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(listConnects).toHaveBeenCalledTimes(count + 1);
  });
});
