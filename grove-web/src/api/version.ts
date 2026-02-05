// Version API

import { apiClient } from './client';

export interface VersionResponse {
  version: string;
}

export async function getVersion(): Promise<VersionResponse> {
  return apiClient.get<VersionResponse>('/api/v1/version');
}
