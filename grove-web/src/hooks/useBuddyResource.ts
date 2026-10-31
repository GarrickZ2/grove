import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../utils/errorMessage";

export function useBuddyResource<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const state = useRef({ mounted: false, request: 0 });
  const refresh = useCallback(async () => {
    const request = ++state.current.request;
    setLoading(true);
    try { const result = await load(); if (state.current.mounted && state.current.request === request) { setData(result); setError(null); } }
    catch (reason) { if (state.current.mounted && state.current.request === request) setError(errorMessage(reason)); }
    finally { if (state.current.mounted && state.current.request === request) setLoading(false); }
  }, [load]);
  useEffect(() => {
    const lifetime = state.current; lifetime.mounted = true;
    void Promise.resolve().then(refresh);
    return () => { lifetime.mounted = false; lifetime.request++; };
  }, [refresh]);
  return { data, error, loading, refresh };
}
