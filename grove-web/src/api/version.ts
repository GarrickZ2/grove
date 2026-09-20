// Version API

import { apiClient } from './client';

export interface VersionResponse {
  version: string;
  /** Whether the backend renders OS notifications for a human at its own
   *  machine. `false` on headless serving (grove mobile) — the frontend
   *  notification engine should render client-side instead. */
  renders_os_notifications?: boolean;
  /** The authoritative transient-notification owner for new backends. */
  notification_owner?: 'backend' | 'client';
}

export interface UpdateCheckResponse {
  current_version: string;
  latest_version: string | null;
  has_update: boolean;
  install_method: string;
  update_command: string;
  check_time: string | null;
  can_auto_update: boolean;
}

export interface AppUpdateProgress {
  stage: 'idle' | 'downloading' | 'ready' | 'installing' | 'error';
  downloaded: number;
  total: number;
  version: string | null;
  error: string | null;
}

export async function getVersion(): Promise<VersionResponse> {
  return apiClient.get<VersionResponse>('/api/v1/version');
}

export async function checkUpdate(): Promise<UpdateCheckResponse> {
  return apiClient.get<UpdateCheckResponse>('/api/v1/update-check');
}

export async function startAppUpdate(): Promise<void> {
  await apiClient.post('/api/v1/app-update/start', {});
}

export async function getAppUpdateProgress(): Promise<AppUpdateProgress> {
  return apiClient.get<AppUpdateProgress>('/api/v1/app-update/progress');
}

export async function installAppUpdate(): Promise<void> {
  await apiClient.post('/api/v1/app-update/install', {});
}
