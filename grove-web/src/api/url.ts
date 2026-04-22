// URL metadata client — used by the Add Link dialog to auto-fill Name.
//
// Backend: POST /api/v1/url/metadata { url } -> { title, description? }
// The backend fails-open (empty title on error), so callers should still
// fall back to a hostname-derived default when `title` is empty.

import { apiClient } from './client';

export interface UrlMetadata {
  title: string;
  description?: string;
}

export async function fetchUrlMetadata(url: string): Promise<UrlMetadata> {
  return apiClient.post<{ url: string }, UrlMetadata>('/api/v1/url/metadata', { url });
}
