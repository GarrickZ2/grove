import { act, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beginConnectRegistration, cancelConnectRegistration, finishConnectRegistration, getConnectRegistration, submitConnectRegistration, getProject, listChats, listTasks, updateConnect, listConnects, listConnectPlatforms, listProjects, verifyConnect, type ConnectItem, type ConnectPlatform, type ConnectRegistration, type TaskResponse, type ChatSessionResponse, type ProjectListItem, type ProjectResponse } from '../../api';
import { ConnectDialog } from './ConnectSettings';

vi.mock('../../api', () => ({
  listConnects: vi.fn(), listConnectPlatforms: vi.fn(), listProjects: vi.fn(), verifyConnect: vi.fn(),
  beginConnectRegistration: vi.fn(), createConnect: vi.fn(), deleteConnect: vi.fn(),
  submitConnectRegistration: vi.fn().mockResolvedValue(undefined), cancelConnectRegistration: vi.fn().mockResolvedValue(undefined), finishConnectRegistration: vi.fn(), getConnectRegistration: vi.fn(), getProject: vi.fn(),
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
    vi.mocked(cancelConnectRegistration).mockResolvedValue(undefined);
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

  const weixinPlatform: ConnectPlatform = {
    id: 'weixin', name: 'WeChat', description: 'Personal WeChat', available: true,
    setup_modes: ['qr'], config_fields: [],
    capabilities: { private_chat: true, group_chat: false, reactions: false, cards: false, qr_registration: true },
  };
  function registration(state: ConnectRegistration['state'] = 'waiting_for_scan'): ConnectRegistration {
    return { id: 'wechat-flow', platform: 'weixin', domain: 'weixin', state, verification_url: 'https://weixin.qq.com/qr', qr_svg: '', expires_at: Math.floor(Date.now() / 1000) + 480 };
  }
  async function clickButton(label: string) {
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent?.includes(label));
    expect(button).toBeDefined();
    await act(async () => button!.click());
  }
  async function startWeixin() {
    vi.mocked(listConnectPlatforms).mockResolvedValue([weixinPlatform]);
    await render();
    await clickButton('New connection');
    await clickButton('WeChat');
  }

  it('uses the WeChat adapter to submit a code through the generic authorization API', async () => {
    vi.mocked(beginConnectRegistration).mockResolvedValue(registration('waiting_for_input'));
    vi.mocked(submitConnectRegistration).mockResolvedValue(registration());
    await startWeixin();
    expect(beginConnectRegistration).toHaveBeenCalledWith('weixin', 'weixin');
    expect(container.textContent).toContain('WeChat verification code');
    expect(container.textContent).not.toContain('App Secret');
    const input = container.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '123456');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(submitConnectRegistration).toHaveBeenCalledWith('wechat-flow', { verify_code: '123456' });
    expect(container.querySelector('form')).toBeNull();
    expect(finishConnectRegistration).not.toHaveBeenCalled();
  });

  it('cancels a late QR creation after the user switches away', async () => {
    let resolveBegin!: (flow: ConnectRegistration) => void;
    vi.mocked(beginConnectRegistration).mockImplementation(() => new Promise((resolve) => { resolveBegin = resolve; }));
    await startWeixin();
    await chooseConnection();
    await act(async () => resolveBegin(registration('authorized')));
    expect(cancelConnectRegistration).toHaveBeenCalledWith('wechat-flow');
    expect(finishConnectRegistration).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Messages route to');
  });

  it('cancels an active flow and ignores an authorized poll arriving after close', async () => {
    vi.mocked(beginConnectRegistration).mockResolvedValue(registration());
    let resolvePoll!: (flow: ConnectRegistration) => void;
    vi.mocked(getConnectRegistration).mockImplementation(() => new Promise((resolve) => { resolvePoll = resolve; }));
    await startWeixin();
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(getConnectRegistration).toHaveBeenCalledWith('wechat-flow');
    await render(false);
    expect(cancelConnectRegistration).toHaveBeenCalledWith('wechat-flow');
    await act(async () => resolvePoll(registration('authorized')));
    expect(finishConnectRegistration).not.toHaveBeenCalled();
  });

  it('reauthorizes an existing connection by id instead of creating another connection', async () => {
    const saved: ConnectItem = { ...setupTargets(), platform: 'weixin', domain: 'weixin', adapter_config: { bot_id: 'bot', user_id: 'owner' } };
    vi.mocked(listConnects).mockResolvedValue([saved]);
    vi.mocked(listConnectPlatforms).mockResolvedValue([weixinPlatform]);
    vi.mocked(beginConnectRegistration).mockResolvedValue(registration('authorized'));
    vi.mocked(finishConnectRegistration).mockResolvedValue(saved);
    await render();
    await clickButton('Authorize WeChat again');
    expect(finishConnectRegistration).toHaveBeenCalledWith({ flow_id: 'wechat-flow', name: 'Local', enabled: true, connection_id: 'local' });
    expect(container.textContent).toContain('Messages route to');
    expect(updateConnect).not.toHaveBeenCalled();
  });

  function targetLabels() { return [...container.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="listbox"]')].map((button) => button.textContent); }

  function setupTargets() {
    const saved = { ...connection('online'), project_id: 'p1', task_id: 't1', session_id: 's1' };
    vi.mocked(listConnects).mockResolvedValue([saved]);
    vi.mocked(listProjects).mockResolvedValue({ projects: [{ id: 'p1', name: 'Project A' }, { id: 'p2', name: 'Project B' }] as ProjectListItem[], current_project_id: null });
    vi.mocked(getProject).mockResolvedValue({ local_task: { id: 'local', name: 'Local task', status: 'idle' } } as ProjectResponse);
    vi.mocked(listTasks).mockResolvedValue([{ id: 't1', name: 'Saved task', status: 'idle' }] as TaskResponse[]);
    vi.mocked(listChats).mockResolvedValue([{ id: 's1', title: 'Saved session', agent: 'codex' }] as ChatSessionResponse[]);
    vi.mocked(updateConnect).mockImplementation(async (_, input) => ({ ...saved, ...input }));
    return saved;
  }

  it('loads saved target options on first opening and every reopen without saving or reconnecting', async () => {
    setupTargets();
    await render();
    expect(targetLabels()[0]).toContain('Project A');
    expect(targetLabels()[1]).toContain('Saved task');
    expect(targetLabels()[2]).toContain('Saved session');
    await render(false);
    await render();
    expect(targetLabels()[1]).toContain('Saved task');
    expect(targetLabels()[2]).toContain('Saved session');
    expect(listTasks).toHaveBeenCalledTimes(2);
    expect(listChats).toHaveBeenCalledTimes(2);
    expect(updateConnect).not.toHaveBeenCalled();
    expect(verifyConnect).not.toHaveBeenCalled();
  });

  it('does not label an existing saved session as New while options load or fail, and can reload', async () => {
    setupTargets();
    let reject!: (reason: Error) => void;
    vi.mocked(listChats).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    await render();
    expect(targetLabels()[2]).toContain('Loading sessions');
    await act(async () => reject(new Error('session list failed')));
    expect(targetLabels()[2]).toContain('Saved session unavailable');
    expect(container.textContent).toContain('session list failed');
    const reload = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Reload targets'))!;
    await act(async () => reload.click());
    expect(targetLabels()[2]).toContain('Saved session');
    expect(updateConnect).not.toHaveBeenCalled();
  });

  it('includes the Local task in the automatically loaded task list', async () => {
    const saved = setupTargets();
    vi.mocked(listConnects).mockResolvedValue([{ ...saved, task_id: 'local', session_id: '' }]);
    await render();
    expect(targetLabels()[1]).toContain('Local task');
    expect(listChats).toHaveBeenCalledWith('p1', 'local');
  });

  it('refreshes a session created by IM while the panel is open without writing the old target back', async () => {
    const saved = setupTargets();
    vi.mocked(listConnects).mockResolvedValue([{ ...saved, session_id: '' }]);
    vi.mocked(listChats).mockResolvedValueOnce([]);
    await render();
    expect(targetLabels()[2]).toContain('New session');
    vi.mocked(listConnects).mockResolvedValue([saved]);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(targetLabels()[2]).toContain('Saved session');
    expect(listChats).toHaveBeenCalledTimes(2);
    expect(updateConnect).not.toHaveBeenCalled();
  });

  it('ignores task and session results from a previous opening', async () => {
    setupTargets();
    let oldTasks!: (items: TaskResponse[]) => void;
    let oldSessions!: (items: ChatSessionResponse[]) => void;
    vi.mocked(listTasks).mockImplementationOnce(() => new Promise((resolve) => { oldTasks = resolve; }));
    vi.mocked(listChats).mockImplementationOnce(() => new Promise((resolve) => { oldSessions = resolve; }));
    await render();
    await render(false);
    await render();
    expect(targetLabels()[2]).toContain('Saved session');
    await act(async () => {
      oldTasks([{ id: 't1', name: 'Old task' }] as TaskResponse[]);
      oldSessions([{ id: 's1', title: 'Old session' }] as ChatSessionResponse[]);
    });
    expect(targetLabels()[1]).toContain('Saved task');
    expect(targetLabels()[2]).toContain('Saved session');
  });

  it('keeps the new project and task options when older target requests finish late', async () => {
    setupTargets();
    let oldTasks!: (items: TaskResponse[]) => void;
    let oldSessions!: (items: ChatSessionResponse[]) => void;
    vi.mocked(listTasks).mockImplementationOnce(() => new Promise((resolve) => { oldTasks = resolve; }));
    vi.mocked(listChats).mockImplementationOnce(() => new Promise((resolve) => { oldSessions = resolve; }));
    vi.mocked(listTasks).mockResolvedValue([{ id: 't2', name: 'Task B', status: 'idle' }] as TaskResponse[]);
    vi.mocked(listChats).mockResolvedValue([{ id: 's2', title: 'Session B', agent: 'codex' }] as ChatSessionResponse[]);
    await render();
    const pick = async (index: number, title: string) => {
      await act(async () => container.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="listbox"]')[index].click());
      const option = [...document.querySelectorAll<HTMLButtonElement>('button[role="option"]')].find((entry) => entry.textContent?.includes(title));
      expect(option).toBeDefined();
      await act(async () => option!.click());
    };
    await pick(0, 'Project B');
    await pick(1, 'Task B');
    await act(async () => {
      oldTasks([{ id: 't1', name: 'Old task' }] as TaskResponse[]);
      oldSessions([{ id: 's1', title: 'Old session' }] as ChatSessionResponse[]);
    });
    expect(targetLabels()[0]).toContain('Project B');
    expect(targetLabels()[1]).toContain('Task B');
    await pick(2, 'Session B');
    expect(updateConnect).toHaveBeenLastCalledWith('local', expect.objectContaining({ project_id: 'p2', task_id: 't2', session_id: 's2' }));
    expect(verifyConnect).not.toHaveBeenCalled();
  });

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
