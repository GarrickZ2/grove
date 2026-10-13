import { FeishuAuthorization, FeishuSettings } from './FeishuAdapter';
import { ProviderAuthorization } from './ProviderAdapter';
import { WeixinAuthorization, WeixinSettings, WeixinMark } from './WeixinAdapter';
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
const providerAdapter: ConnectFrontendAdapter = {
  extraConfigKeys: [],
  description: (label) => `Authorize Grove with ${label}. The provider controls the external authorization flow.`,
  Authorization: ProviderAuthorization,
};
const adapters: Record<string, ConnectFrontendAdapter> = { feishu: feishuAdapter, lark: { ...feishuAdapter, regionLabel: 'Global' }, weixin: weixinAdapter };
export function getConnectFrontendAdapter(platform: string): ConnectFrontendAdapter { return adapters[platform] ?? providerAdapter; }
