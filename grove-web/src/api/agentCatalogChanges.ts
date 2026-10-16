// Shared invalidation for every Agent catalog consumer. Backend events cover
// other tabs/devices and PATH scans; API mutations also notify immediately
// when the event socket is temporarily unavailable.
let revision = 0;
const listeners = new Set<() => void>();
let notificationTimer: ReturnType<typeof setTimeout> | undefined;

export function getAgentCatalogRevision(): number {
  return revision;
}

export function invalidateAgentCatalog(): void {
  revision += 1;
  // A PATH scan can change several rows. Coalesce those events into one reload.
  if (notificationTimer !== undefined) return;
  notificationTimer = setTimeout(() => {
    notificationTimer = undefined;
    for (const listener of listeners) listener();
  }, 50);
}

function onVisible(): void {
  if (document.visibilityState === "visible") invalidateAgentCatalog();
}

export function subscribeAgentCatalog(listener: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener("focus", invalidateAgentCatalog);
    window.addEventListener("grove:transport-ready", invalidateAgentCatalog);
    document.addEventListener("visibilitychange", onVisible);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener("focus", invalidateAgentCatalog);
      window.removeEventListener("grove:transport-ready", invalidateAgentCatalog);
      document.removeEventListener("visibilitychange", onVisible);
    }
  };
}

/** Coalesce concurrent reads, and never return a snapshot superseded by a
 * mutation while its request was in flight. There is no persistent cache. */
export function agentCatalogReader<T>(fetchSnapshot: () => Promise<T>): () => Promise<T> {
  let pending: { revision: number; promise: Promise<T> } | undefined;
  const read = (): Promise<T> => {
    const version = getAgentCatalogRevision();
    if (pending?.revision === version) return pending.promise;
    const promise = fetchSnapshot().then(
      (value) => version === getAgentCatalogRevision() ? value : read(),
      (error: unknown) => {
        if (version !== getAgentCatalogRevision()) return read();
        throw error;
      },
    );
    pending = { revision: version, promise };
    const clear = () => { if (pending?.promise === promise) pending = undefined; };
    void promise.then(clear, clear);
    return promise;
  };
  return read;
}
