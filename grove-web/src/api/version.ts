// Version API

import { apiClient } from './client';

export interface VersionResponse {
  version: string;
}

export interface UpdateCheckResponse {
  current_version: string;
  latest_version: string | null;
  has_update: boolean;
  install_method: string;
  update_command: string;
  check_time: string | null;
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
