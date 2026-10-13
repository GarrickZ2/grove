import type { ComponentType, Dispatch, SetStateAction } from 'react';
import type { ConnectInput, ConnectItem, ConnectPlatform, ConnectRegistration } from '../../../api';

export interface AuthorizationProps {
  platform?: ConnectPlatform;
  draft: ConnectInput;
  setDraft: Dispatch<SetStateAction<ConnectInput>>;
  flow: ConnectRegistration | null;
  busy: boolean;
  refresh: () => Promise<void>;
  verifyManual: () => Promise<void>;
  submit: (input: Record<string, unknown>) => Promise<void>;
}

export interface SettingsProps {
  item: ConnectItem;
  draft: ConnectInput;
  busy: boolean;
  save: (draft: ConnectInput) => Promise<void>;
  reauthorize: () => Promise<void>;
}

export interface ConnectFrontendAdapter {
  extraConfigKeys: readonly string[];
  description: (label: string) => string;
  Authorization: ComponentType<AuthorizationProps>;
  Settings?: ComponentType<SettingsProps>;
  Mark?: ComponentType<{ size: number }>;
  regionLabel?: string;
  connectionDetail?: (item: ConnectItem) => string | undefined;
}
