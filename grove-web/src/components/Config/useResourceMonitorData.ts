import { useEffect, useRef, useState } from 'react';
import { getResourceProcesses, getResourceStorage, refreshResourceStorage, type ProcessSnapshot, type StorageStatus } from '../../api/resourceMonitor';
import { message } from './resourceFormat';

export type Sample = { at: string; cpu: number | null; memory: number | null };

/** Polls process (10s) and storage (2s while scanning, else 5s) usage; pauses while the page is hidden. */
export function useResourceMonitorData() {
  const [processes, setProcesses] = useState<ProcessSnapshot | null>(null);
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [processError, setProcessError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(false);
  const storageGeneration = useRef(0);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    let processTimer: ReturnType<typeof setTimeout>;
    let storageTimer: ReturnType<typeof setTimeout>;
    async function pollProcesses() {
      try {
        if (document.visibilityState !== 'hidden') {
          const data = await getResourceProcesses(controller.signal);
          if (controller.signal.aborted) return;
          setProcesses(data); setProcessError(null);
          setSamples(previous => previous.at(-1)?.at === data.sampled_at ? previous : [...previous.slice(-59), { at: data.sampled_at, cpu: data.cpu_percent, memory: data.memory_unavailable_count ? null : data.memory_bytes }]);
        }
      } catch (error) { if (!controller.signal.aborted) setProcessError(message(error)); }
      if (!controller.signal.aborted) processTimer = setTimeout(pollProcesses, 10000);
    }
    async function pollStorage() {
      const generation = storageGeneration.current;
      let scanning = true;
      try {
        if (document.visibilityState !== 'hidden') {
          const data = await getResourceStorage(controller.signal);
          if (controller.signal.aborted) return;
          if (generation === storageGeneration.current) { setStorage(data); setStorageError(null); }
          scanning = data.scanning;
        }
      } catch (error) { if (!controller.signal.aborted && generation === storageGeneration.current) setStorageError(message(error)); }
      if (!controller.signal.aborted) storageTimer = setTimeout(pollStorage, scanning ? 2000 : 5000);
    }
    void pollProcesses(); void pollStorage();
    return () => { mounted.current = false; controller.abort(); clearTimeout(processTimer); clearTimeout(storageTimer); };
  }, []);

  async function refreshStorage() {
    setRefreshing(true);
    storageGeneration.current++;
    try { const data = await refreshResourceStorage(); if (mounted.current) { setStorage(data); setStorageError(null); } }
    catch (error) { if (mounted.current) setStorageError(message(error)); }
    finally { if (mounted.current) setRefreshing(false); }
  }


  return { processes, storage, samples, processError, storageError, refreshing, refreshStorage };
}
