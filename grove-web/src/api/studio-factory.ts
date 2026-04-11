import { apiClient } from './client';
import type { StudioFileEntry, StudioWorkDirEntry } from './studio-types';

// ============================================================================
// Studio File/Workdir API Factory
// ============================================================================

export interface StudioFileApi<T extends StudioFileEntry = StudioFileEntry> {
  list(): Promise<{ files: T[] }>;
  upload(files: File[]): Promise<T[]>;
  delete(path: string, extraParams?: Record<string, string>): Promise<void>;
  preview(path: string, extraParams?: Record<string, string>): Promise<string>;
  downloadUrl(path: string, extraParams?: Record<string, string>): string;

  listWorkdirs(): Promise<{ entries: StudioWorkDirEntry[] }>;
  addWorkdir(path: string): Promise<StudioWorkDirEntry>;
  deleteWorkdir(name: string): Promise<void>;
  openWorkdir(name: string): Promise<void>;
}

export function createStudioFileApi<T extends StudioFileEntry = StudioFileEntry>(
  basePath: string,
): StudioFileApi<T> {
  return {
    list() {
      return apiClient.get<{ files: T[] }>(basePath);
    },

    upload(files: File[]) {
      const formData = new FormData();
      for (const file of files) formData.append('file', file);
      return apiClient.postFormData<T[]>(`${basePath}/upload`, formData);
    },

    delete(path: string, extraParams?: Record<string, string>) {
      const params = new URLSearchParams({ path, ...extraParams });
      return apiClient.delete(`${basePath}?${params}`);
    },

    preview(path: string, extraParams?: Record<string, string>) {
      const params = new URLSearchParams({ path, ...extraParams });
      return apiClient.getText(`${basePath}/preview?${params}`);
    },

    downloadUrl(path: string, extraParams?: Record<string, string>) {
      const params = new URLSearchParams({ path, ...extraParams });
      return `${basePath}/download?${params}`;
    },

    listWorkdirs() {
      return apiClient.get<{ entries: StudioWorkDirEntry[] }>(`${basePath}/workdir`);
    },

    addWorkdir(path: string) {
      return apiClient.post<{ path: string }, StudioWorkDirEntry>(`${basePath}/workdir`, { path });
    },

    deleteWorkdir(name: string) {
      return apiClient.delete(`${basePath}/workdir?name=${encodeURIComponent(name)}`);
    },

    openWorkdir(name: string) {
      return apiClient.postNoContent(`${basePath}/workdir/open?name=${encodeURIComponent(name)}`);
    },
  };
}
