import { useCallback, useEffect, useRef, useState } from "react";
import { archiveBuddy, createBuddy, getBuddy, listBuddies, reorderBuddies, type Buddy, type BuddySummary, type CreateBuddyInput } from "../api/buddies";
import { errorMessage } from "../utils/errorMessage";
import { readBuddyPreference, writeBuddyPreference } from "../components/Buddy/buddyStorage";
const BUDDIES_CHANGED = "grove-buddies-changed";

export function useBuddies() {
  const [items, setItems] = useState<BuddySummary[]>([]);
  const [selectedId, setSelectedId] = useState(() => readBuddyPreference("selected"));
  const [detail, setDetail] = useState<Buddy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0);
  const selection = useRef(selectedId);
  const mounted = useRef(false);
  const itemRevisions = useRef(new Map<string, number>());
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    try {
      const next = await listBuddies();
      if (!mounted.current || request !== revision.current) return;
      setItems(next);
      setSelectedId((current) => next.some((item) => item.id === current) ? current : next[0]?.id ?? "");
      setError(null);
    } catch (reason) { if (mounted.current && request === revision.current) setError(errorMessage(reason)); }
    finally { if (mounted.current && request === revision.current) setLoading(false); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void Promise.resolve().then(refresh);
    const changed = (event: Event) => { if ((event as CustomEvent).detail !== mounted) void refresh(); };
    window.addEventListener(BUDDIES_CHANGED, changed);
    return () => { mounted.current = false; window.removeEventListener(BUDDIES_CHANGED, changed); };
  }, [refresh]);
  useEffect(() => { writeBuddyPreference("selected", selectedId); }, [selectedId]);
  useEffect(() => {
    selection.current = selectedId;
    if (!selectedId) return;
    const request = (itemRevisions.current.get(selectedId) ?? 0) + 1;
    itemRevisions.current.set(selectedId, request);
    let active = true;
    void getBuddy(selectedId).then((buddy) => { if (active && itemRevisions.current.get(selectedId) === request) setDetail(buddy); })
      .catch((reason) => { if (active && itemRevisions.current.get(selectedId) === request) setError(errorMessage(reason)); });
    return () => { active = false; };
  }, [selectedId]);

  const accept = useCallback((buddy: Buddy) => {
    revision.current++;
    itemRevisions.current.set(buddy.id, (itemRevisions.current.get(buddy.id) ?? 0) + 1);
    setItems((current) => current.map((item) => item.id === buddy.id ? buddy : item));
    setDetail((current) => current?.id === buddy.id || selection.current === buddy.id ? buddy : current);
  }, []);
  const refreshItem = useCallback(async (id: string) => {
    const request = (itemRevisions.current.get(id) ?? 0) + 1;
    itemRevisions.current.set(id, request);
    try {
      const buddy = await getBuddy(id);
      if (!mounted.current || itemRevisions.current.get(id) !== request) return;
      accept(buddy);
    } catch (reason) { if (mounted.current) setError(errorMessage(reason)); }
  }, [accept]);
  const create = async (input: CreateBuddyInput) => {
    const buddy = await createBuddy(input);
    revision.current++;
    setItems((current) => [...current, buddy]);
    setDetail(buddy);
    setSelectedId(buddy.id);
    setLoading(false);
    window.dispatchEvent(new CustomEvent(BUDDIES_CHANGED, { detail: mounted }));
    return buddy;
  };
  const archive = async (id: string) => {
    await archiveBuddy(id);
    revision.current++;
    setItems((current) => current.filter((item) => item.id !== id));
    setSelectedId((current) => current === id ? items.find((item) => item.id !== id)?.id ?? "" : current);
    window.dispatchEvent(new CustomEvent(BUDDIES_CHANGED, { detail: mounted }));
  };
  const reorder = async (ids: string[]) => {
    await reorderBuddies(ids);
    revision.current++;
    setItems((current) => ids.flatMap((id) => current.filter((item) => item.id === id)));
    window.dispatchEvent(new CustomEvent(BUDDIES_CHANGED, { detail: mounted }));
  };
  return { items, selectedId, select: setSelectedId, buddy: detail?.id === selectedId ? detail : null, loading, error, refresh, refreshItem, accept, create, archive, reorder };
}
