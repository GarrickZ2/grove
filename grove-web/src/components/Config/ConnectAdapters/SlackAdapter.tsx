import { Button } from '../../ui';
import { ExternalAnchor, PairingCode, Steps, TokenForm } from './PairingAuthorization';
import type { AuthorizationProps, SettingsProps } from './types';

/** Everything Grove needs: DMs, buttons and `/grove` over Socket Mode. */
const MANIFEST = {
  display_information: { name: 'Grove', description: 'Talk to your Grove agents', background_color: '#1f2937' },
  features: {
    app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    bot_user: { display_name: 'Grove', always_online: true },
    slash_commands: [{ command: '/grove', description: 'Grove commands: new, target, config, status, cancel, help', usage_hint: 'help', should_escape: false }],
  },
  oauth_config: { scopes: { bot: ['chat:write', 'im:history', 'im:read', 'im:write', 'reactions:write', 'files:read', 'commands', 'users:read'] } },
  settings: { event_subscriptions: { bot_events: ['message.im'] }, interactivity: { is_enabled: true }, org_deploy_enabled: false, socket_mode_enabled: true, token_rotation_enabled: false },
};
export const SLACK_MANIFEST_URL = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(MANIFEST))}`;

const token = (prefix: string) => (value: string) => value.startsWith(prefix) && value.length > 20 && !/\s/.test(value);

export function SlackAuthorization(props: AuthorizationProps) {
  const { flow } = props;
  if (!flow || flow.state === 'waiting_for_input') {
    return <TokenForm {...props} fields={[
      { key: 'bot_token', label: 'Bot User OAuth Token', placeholder: 'xoxb-…', valid: token('xoxb-') },
      { key: 'app_token', label: 'App-Level Token', placeholder: 'xapp-…', valid: token('xapp-') },
    ]}>
      <Steps steps={[
        <><ExternalAnchor href={SLACK_MANIFEST_URL}>Create the Grove Slack app</ExternalAnchor> from the prefilled manifest and pick your workspace.</>,
        <>Choose <strong>Install App</strong> → <strong>Install to Workspace</strong>, then copy the <strong>Bot User OAuth Token</strong>.</>,
        <>In <strong>Basic Information</strong> → <strong>App-Level Tokens</strong>, generate a token with the <code>connections:write</code> scope.</>,
        'Paste both tokens below. Slack connects over Socket Mode, so Grove needs no public URL.',
      ]} />
    </TokenForm>;
  }
  return <PairingCode {...props} openLabel="Open Slack">
    <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">Send this code to the Grove app in a direct message. Only the Slack account that sends it can use this connection.</p>
  </PairingCode>;
}

export function SlackSettings({ busy, reauthorize }: SettingsProps) {
  return <section className="rounded-xl border border-[var(--color-border)] p-4">
    <p className="mb-3 text-xs leading-relaxed text-[var(--color-text-muted)]">Message the Grove app directly in Slack. Type <code>/grove help</code> for commands. Slack treats every message that starts with “/” as a command, so use <code>/grove new</code> instead of <code>/new</code>. If a token is revoked, connect again with the same Slack account; your Grove target is retained.</p>
    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void reauthorize()}>Connect Slack again</Button>
  </section>;
}
