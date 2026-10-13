export const ADVANCED_CONFIG_FIELDS = [
  { key: 'reconnect_count', label: 'Reconnect attempts', placeholder: 'Feishu default (unlimited)', min: '-1', description: '-1 uses the official unlimited reconnect behavior.' },
  { key: 'reconnect_interval_secs', label: 'Reconnect interval (seconds)', placeholder: 'Feishu default (120)', min: '1', description: 'Leave blank to use the interval returned by Feishu.' },
  { key: 'heartbeat_timeout_secs', label: 'Heartbeat timeout (seconds)', placeholder: 'Disabled by default', min: '1', description: 'Optional local liveness guard; leave blank for SDK behavior.' },
] as const;
