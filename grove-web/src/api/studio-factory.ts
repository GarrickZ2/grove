import { apiClient } from './client';
import type { StudioFileEntry, StudioWorkDirEntry } from './studio-types';

// ============================================================================
// Studio File/Workdir API Factory
// ============================================================================

export interface StudioFileApi<T extends StudioFileEntry = StudioFileEntry> {
  list(path?: string): Promise<{ files: T[] }>;
  upload(files: File[], path?: string): Promise<T[]>;
  createFolder(path: string): Promise<void>;
  move(from: string, to: string, options?: { force?: boolean; renameTo?: string }): Promise<void>;
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
    list(path?: string) {
      const url = path ? `${basePath}?${new URLSearchParams({ path })}` : basePath;
      return apiClient.get<{ files: T[] }>(url);
    },

    upload(files: File[], path?: string) {
      const formData = new FormData();
      for (const file of files) formData.append('file', file);
      const url = path
        ? `${basePath}/upload?${new URLSearchParams({ path })}`
        : `${basePath}/upload`;
      return apiClient.postFormData<T[]>(url, formData);
    },

    createFolder(path: string) {
      return apiClient.post<{ path: string }, void>(`${basePath}/folder`, { path });
    },

    move(from: string, to: string, options?: { force?: boolean; renameTo?: string }) {
      return apiClient.post<
        { from: string; to: string; force?: boolean; rename_to?: string },
        void
      >(`${basePath}/move`, { from, to, force: options?.force, rename_to: options?.renameTo });
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
