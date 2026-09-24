import { useEffect, useState } from 'react';
import { apiClient } from '../api/client';

/** Load a Grove file through the signed API, then hand the browser a local URL. */
export function useAuthenticatedFileUrl(path: string | null): { url: string | null; error: boolean } {
  const [loaded, setLoaded] = useState<{ path: string; url: string | null; error: boolean } | null>(null);

  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    apiClient.getBlob(path, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setLoaded({ path, url: objectUrl, error: false });
    }).catch(() => {
      if (!controller.signal.aborted) setLoaded({ path, url: null, error: true });
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  return loaded?.path === path
    ? { url: loaded.url, error: loaded.error }
    : { url: null, error: false };
}
