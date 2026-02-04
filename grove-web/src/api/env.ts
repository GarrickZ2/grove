// Environment check API

import { apiClient } from './client';

// Types
export interface DependencyStatus {
  name: string;
  installed: boolean;
  version: string | null;
  install_command: string;
}

export interface EnvCheckResponse {
  dependencies: DependencyStatus[];
}

// API functions
export async function checkAllDependencies(): Promise<EnvCheckResponse> {
  return apiClient.get<EnvCheckResponse>('/api/v1/env/check');
}

export async function checkDependency(name: string): Promise<DependencyStatus | null> {
  return apiClient.get<DependencyStatus | null>(`/api/v1/env/check/${name}`);
}
