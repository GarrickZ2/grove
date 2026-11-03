import { act, type ButtonHTMLAttributes, type InputHTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectRegistration } from '../../../api';
import { SLACK_MANIFEST_URL, SlackAuthorization } from './SlackAdapter';
import { TelegramAuthorization } from './TelegramAdapter';
import type { AuthorizationProps } from './types';

vi.mock('../../ui', () => ({
  Button: ({ children, onClick, disabled, type }: ButtonHTMLAttributes<HTMLButtonElement>) => <button type={type ?? 'button'} onClick={onClick} disabled={disabled}>{children}</button>,
  Input: ({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label?: string }) => <label>{label}<input aria-label={label} {...props} /></label>,
}));

const flow = (state: ConnectRegistration['state'], extra: Partial<ConnectRegistration> = {}): ConnectRegistration => ({
  id: 'flow', platform: 'slack', domain: 'slack', state, verification_url: '', qr_svg: '', expires_at: Math.floor(Date.now() / 1000) + 600, ...extra,
});

function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('bring-your-own-bot authorization', () => {
  let container: HTMLDivElement;
  let root: Root;
  const props = (overrides: Partial<AuthorizationProps>): AuthorizationProps => ({
    draft: { name: '', platform: 'slack', domain: 'slack', enabled: true, adapter_config: {}, project_id: '', task_id: '', session_id: '' },
    setDraft: vi.fn(), flow: null, busy: false, refresh: vi.fn().mockResolvedValue(undefined), verifyManual: vi.fn(), submit: vi.fn().mockResolvedValue(undefined), ...overrides,
  });

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('submits both Slack tokens only once each has the right kind', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    await act(async () => root.render(<SlackAuthorization {...props({ flow: flow('waiting_for_input'), submit })} />));
    const manifest = decodeURIComponent(SLACK_MANIFEST_URL.split('manifest_json=')[1]);
    expect(JSON.parse(manifest).settings.socket_mode_enabled).toBe(true);
    const verify = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Verify and continue')!;
    const [bot, app] = [...container.querySelectorAll('input')];
    await act(async () => { setValue(bot, 'xapp-wrong-kind-of-token'); setValue(app, 'xapp-1-A1-2-abcdefghijk'); });
    expect(verify.disabled).toBe(true);
    await act(async () => { setValue(bot, ' xoxb-1234567890-abcdefghij '); });
    expect(verify.disabled).toBe(false);
    await act(async () => { verify.click(); });
    expect(submit).toHaveBeenCalledWith({ bot_token: 'xoxb-1234567890-abcdefghij', app_token: 'xapp-1-A1-2-abcdefghijk' });
  });

  it('shows the Slack pairing code and surfaces submission errors', async () => {
    await act(async () => root.render(<SlackAuthorization {...props({ flow: flow('waiting_for_scan', { code: 'AB12-CD34', verification_url: 'https://slack.com/app_redirect?app=A1&team=T1' }) })} />));
    expect(container.textContent).toContain('AB12-CD34');
    expect(container.querySelector('a[href^="https://slack.com/app_redirect"]')).not.toBeNull();
    const submit = vi.fn().mockRejectedValue(new Error('invalid_auth'));
    await act(async () => root.render(<TelegramAuthorization {...props({ flow: flow('waiting_for_input', { platform: 'telegram' }), submit })} />));
    const input = container.querySelector('input')!;
    await act(async () => { setValue(input, '123456:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789'); });
    await act(async () => { [...container.querySelectorAll('button')].find((button) => button.textContent === 'Verify and continue')!.click(); });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('invalid_auth');
  });

  it('offers the Telegram deep link and its manual fallback', async () => {
    await act(async () => root.render(<TelegramAuthorization {...props({ flow: flow('waiting_for_scan', { platform: 'telegram', code: 'abc123', verification_url: 'https://t.me/GroveBot?start=abc123', qr_svg: '<svg></svg>' }) })} />));
    expect(container.textContent).toContain('/start abc123');
    expect(container.querySelector('a[href="https://t.me/GroveBot?start=abc123"]')).not.toBeNull();
  });
});
