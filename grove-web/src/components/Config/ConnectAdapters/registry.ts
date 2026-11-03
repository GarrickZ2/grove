import { FeishuAuthorization, FeishuSettings } from './FeishuAdapter';
import { ProviderAuthorization } from './ProviderAdapter';
import { WeixinAuthorization, WeixinSettings } from './WeixinAdapter';
import { WeixinMark } from './WeixinMark';
import { TelegramAuthorization, TelegramSettings } from './TelegramAdapter';
import { SlackAuthorization, SlackSettings } from './SlackAdapter';
import { FeishuMark } from './FeishuMark';
import { ADVANCED_CONFIG_FIELDS } from './feishuConfig';
import type { ConnectFrontendAdapter } from './types';

const feishuAdapter: ConnectFrontendAdapter = {
  extraConfigKeys: ADVANCED_CONFIG_FIELDS.map((field) => field.key),
  description: (label) => `Scan with ${label} to create and authorize the Grove bot, or connect an existing app with its credentials.`,
  Authorization: FeishuAuthorization,
  Settings: FeishuSettings,
  Mark: FeishuMark,
  regionLabel: 'China',
  connectionDetail: (item) => item.adapter_config.app_id === undefined ? undefined : String(item.adapter_config.app_id),
};
const weixinAdapter: ConnectFrontendAdapter = {
  extraConfigKeys: ['base_url'],
  description: () => 'Scan with WeChat to connect ClawBot to Grove.',
  Authorization: WeixinAuthorization,
  Settings: WeixinSettings,
  Mark: WeixinMark,
};
const telegramAdapter: ConnectFrontendAdapter = {
  extraConfigKeys: [],
  description: () => 'Connect your own Telegram bot, then press Start to pair it with your account.',
  Authorization: TelegramAuthorization,
  Settings: TelegramSettings,
  connectionDetail: (item) => typeof item.adapter_config.bot_username === 'string' && item.adapter_config.bot_username ? `@${item.adapter_config.bot_username}` : undefined,
};
const slackAdapter: ConnectFrontendAdapter = {
  extraConfigKeys: [],
  description: () => 'Create a Slack app from Grove’s manifest, then DM it a code to pair it with your account.',
  Authorization: SlackAuthorization,
  Settings: SlackSettings,
  connectionDetail: (item) => typeof item.adapter_config.team_id === 'string' && item.adapter_config.team_id ? item.adapter_config.team_id : undefined,
};
const providerAdapter: ConnectFrontendAdapter = {
  extraConfigKeys: [],
  description: (label) => `Authorize Grove with ${label}. The provider controls the external authorization flow.`,
  Authorization: ProviderAuthorization,
};
const adapters: Record<string, ConnectFrontendAdapter> = { feishu: feishuAdapter, lark: { ...feishuAdapter, regionLabel: 'Global' }, weixin: weixinAdapter, telegram: telegramAdapter, slack: slackAdapter };
export function getConnectFrontendAdapter(platform: string): ConnectFrontendAdapter { return adapters[platform] ?? providerAdapter; }
