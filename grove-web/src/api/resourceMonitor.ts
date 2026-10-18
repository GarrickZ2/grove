import { apiClient } from './client';

export interface ProcessNode {
  id: string;
  name: string;
  kind: 'project' | 'task' | 'shared' | 'process';
  detail: string;
  cpu_percent: number | null;
  memory_bytes: number;
  children: ProcessNode[];
}

export interface ProcessSnapshot {
  sampled_at: string;
  logical_cpus: number;
  cpu_percent: number | null;
  memory_bytes: number;
  process_count: number;
  groups: ProcessNode[];
}

export interface StorageNode {
  id: number;
  name: string;
  kind: string;
  detail: string;
  bytes: number;
  files: number;
  child_count: number;
  shared: boolean;
  unreadable: boolean;
}

export interface StorageStatus {
  scanning: boolean;
  error: string | null;
  scan_id: string | null;
  scanned_at: string | null;
  root: StorageNode | null;
  groups: StorageNode[];
  read_errors: number;
  size_basis: 'allocated' | 'logical';
}

export interface StoragePage { nodes: StorageNode[]; total: number }

const base = '/api/v1/resources';
export const getResourceProcesses = (signal?: AbortSignal) => apiClient.get<ProcessSnapshot>(`${base}/processes`, signal);
export const getResourceStorage = (signal?: AbortSignal) => apiClient.get<StorageStatus>(`${base}/storage`, signal);
export const refreshResourceStorage = () => apiClient.post<never, StorageStatus>(`${base}/storage/refresh`);
export function getStorageChildren(scanId: string, nodeId: number, offset: number, query: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ scan_id: scanId, node_id: String(nodeId), offset: String(offset), query });
  return apiClient.get<StoragePage>(`${base}/storage/children?${params}`, signal);
}
