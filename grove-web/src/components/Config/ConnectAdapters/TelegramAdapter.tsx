import { Button } from '../../ui';
import { QrAuthorization } from './QrAuthorization';
import { ExternalAnchor, Steps, TokenForm } from './PairingAuthorization';
import type { AuthorizationProps, SettingsProps } from './types';

const TOKEN = /^\d+:[A-Za-z0-9_-]{30,}$/;

export function TelegramAuthorization(props: AuthorizationProps) {
  const { flow } = props;
  if (!flow || flow.state === 'waiting_for_input') {
    return <TokenForm {...props} fields={[{ key: 'bot_token', label: 'Bot token', placeholder: '123456789:AA…', valid: (value) => TOKEN.test(value) }]}>
      <Steps steps={[
        <>Open <ExternalAnchor href="https://t.me/BotFather">@BotFather</ExternalAnchor> in Telegram and send <code>/newbot</code> (or <code>/token</code> for an existing bot).</>,
        'Paste the token it gives you below. Use a bot dedicated to Grove: Grove takes over its message delivery.',
        'Next, you will press Start in your chat with the bot so Grove knows the bot belongs to you.',
      ]} />
    </TokenForm>;
  }
  return <QrAuthorization {...props}>
    <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">Scan with your phone or open the link, then press <strong>Start</strong> in Telegram. Only the account that presses Start can use this connection.</p>
    {flow.code && <p className="text-[11px] text-[var(--color-text-muted)]">Or send <code className="select-all">/start {flow.code}</code> to the bot.</p>}
  </QrAuthorization>;
}

export function TelegramSettings({ item, busy, reauthorize }: SettingsProps) {
  const username = typeof item.adapter_config.bot_username === 'string' ? item.adapter_config.bot_username : '';
  return <section className="rounded-xl border border-[var(--color-border)] p-4">
    <p className="mb-3 text-xs text-[var(--color-text-muted)]">{username ? <>Messages to <ExternalAnchor href={`https://t.me/${username}`}>@{username}</ExternalAnchor> from your account reach this connection. </> : null}If you revoke the bot token, connect it again with the same Telegram account. Your current Grove target is retained.</p>
    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void reauthorize()}>Connect Telegram again</Button>
  </section>;
}
