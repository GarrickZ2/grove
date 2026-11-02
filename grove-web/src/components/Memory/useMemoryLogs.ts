import { useCallback, useEffect, useState } from "react";
import type { MemoryLog } from "../../api/memory";
import { errorMessage } from "./memoryFormat";
import { memorySource, type MemorySource } from "./memorySource";

/** Pending Memory Logs: search, paging, selection and (bulk) deletion. */
export function useMemoryLogs({ projectId, refreshTick, onChanged, source = memorySource }: { projectId: string; refreshTick: number; onChanged: () => void; source?: MemorySource }) {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [items, setItems] = useState<MemoryLog[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteTargetIds, setDeleteTargetIds] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const load = useCallback(async (append = false) => {
    setLoading(true);
    try {
      const page = await source.listMemoryLogs(projectId, submitted, append ? cursor : undefined);
      setItems((current) => append ? [...current, ...page.items] : page.items);
      setCursor(page.next_cursor);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setLoading(false); }
  }, [projectId, submitted, cursor, source]);
  useEffect(() => { void Promise.resolve().then(() => load(false)); }, [projectId, submitted, refreshTick, source]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const visibleIds = new Set(items.map((item) => item.id));
    void Promise.resolve().then(() => {
      setSelectedIds((current) => new Set([...current].filter((id) => visibleIds.has(id))));
    });
  }, [items]);

  const confirmDelete = async () => {
    if (deleteTargetIds.length === 0 || deleting) return;
    setDeleting(true);
    try {
      for (let offset = 0; offset < deleteTargetIds.length; offset += 200) {
        await source.deleteMemoryLogs(projectId, deleteTargetIds.slice(offset, offset + 200));
      }
      const deleted = new Set(deleteTargetIds);
      setItems((current) => current.filter((item) => !deleted.has(item.id)));
      setSelectedIds((current) => new Set([...current].filter((id) => !deleted.has(id))));
      setDeleteTargetIds([]);
      onChanged();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setDeleting(false);
    }
  };

  const setSelected = (id: string, selected: boolean) => setSelectedIds((current) => {
    const next = new Set(current);
    if (selected) next.add(id); else next.delete(id);
    return next;
  });

  const allLoadedSelected = items.length > 0 && items.every((item) => selectedIds.has(item.id));
  const toggleSelectLoaded = () => setSelectedIds(allLoadedSelected ? new Set() : new Set(items.map((item) => item.id)));

  return {
    query, setQuery, submitted, setSubmitted, items, cursor, loading, error, setError, load,
    selectedIds, setSelected, allLoadedSelected, toggleSelectLoaded,
    deleteTargetIds, setDeleteTargetIds, deleting, confirmDelete,
  };
}

export type MemoryLogsState = ReturnType<typeof useMemoryLogs>;
