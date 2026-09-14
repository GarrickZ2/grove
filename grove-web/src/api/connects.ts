import { apiClient } from './client';

export type ConnectRuntimeState = 'disabled' | 'offline' | 'connecting' | 'online' | 'error';

export interface ConnectItem {
  id: string;
  name: string;
  platform: string;
  domain: string;
  enabled: boolean;
  adapter_config: Record<string, unknown>;
  project_id: string;
  task_id: string;
  session_id: string;
  bound_chat_id?: string;
  bound_user_id?: string;
  created_at: number;
  updated_at: number;
  runtime: { state: ConnectRuntimeState; detail?: string };
  target: {
    agent: string;
    state: 'offline' | 'idle' | 'working';
    queue_mode: 'separate' | 'compact';
    model?: string;
    mode?: string;
    thought_level?: string;
  };
}

export interface ConnectInput {
  name: string;
  platform: string;
  domain: string;
  enabled: boolean;
  /** Opaque platform-owned setup JSON. The Connect core does not interpret it. */
  adapter_config: Record<string, unknown>;
  project_id: string;
  task_id: string;
  session_id: string;
}

export interface ConnectPlatform {
  id: string;
  name: string;
  description: string;
  available: boolean;
  setup_modes: string[];
  config_fields: Array<{ key: string; label: string; secret: boolean; required: boolean; placeholder: string }>;
  capabilities: {
    private_chat: boolean;
    group_chat: boolean;
    reactions: boolean;
    cards: boolean;
    qr_registration: boolean;
  };
}

export interface ConnectRegistration {
  id: string;
  platform: string;
  state: 'waiting_for_scan' | 'authorized' | 'error';
  verification_url: string;
  qr_svg: string;
  expires_at: number;
  domain: string;
  error?: string;
}

export const listConnects = () => apiClient.get<ConnectItem[]>('/api/v1/connects');
export const createConnect = (input: ConnectInput) => apiClient.post<ConnectInput, ConnectItem>('/api/v1/connects', input);
export const updateConnect = (id: string, input: ConnectInput) => apiClient.put<ConnectInput, ConnectItem>(`/api/v1/connects/${id}`, input);
export const deleteConnect = (id: string) => apiClient.delete(`/api/v1/connects/${id}`);
export const verifyConnect = (id: string) => apiClient.postNoContent(`/api/v1/connects/${id}/verify`);
export const verifyConnectCredentials = (input: { platform: string; domain: string; adapter_config: Record<string, unknown> }) => apiClient.post<typeof input, void>('/api/v1/connects/credentials/verify', input);
export const listConnectPlatforms = () => apiClient.get<ConnectPlatform[]>('/api/v1/connect-platforms');
export const beginConnectRegistration = (domain: string, platform = 'feishu') => apiClient.post<{ platform: string; domain: string }, ConnectRegistration>('/api/v1/connects/registration', { platform, domain });
export const getConnectRegistration = (id: string) => apiClient.get<ConnectRegistration>(`/api/v1/connects/registration/${id}`);
export const finishConnectRegistration = (input: { flow_id: string; name: string; enabled: boolean; project_id?: string; task_id?: string; session_id?: string }) => apiClient.post<typeof input, ConnectItem>('/api/v1/connects/registration/finish', input);
