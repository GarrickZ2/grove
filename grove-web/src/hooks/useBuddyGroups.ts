import { useCallback, useEffect, useRef, useState } from "react";
import { listBuddyGroups, type BuddyGroup } from "../api/buddyGroups";
import { getApiBaseUrl } from "../api/client";
import { readBuddySnapshot } from "../components/Buddy/buddyMachineSnapshot";
import { errorMessage } from "../utils/errorMessage";
import { useRadioEvents } from "./useRadioEvents";

/** The user's groups, kept current from Radio. */
export function useBuddyGroups() {
  const [items, setItems] = useState<BuddyGroup[]>(() => readBuddySnapshot(getApiBaseUrl())?.groups ?? []);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++request.current;
    try { const next = await listBuddyGroups(); if (current === request.current) { setItems(next); setError(null); } }
    catch (reason) { if (current === request.current) setError(errorMessage(reason)); }
  }, []);
  useEffect(() => { void Promise.resolve().then(refresh); }, [refresh]);
  useRadioEvents({
    onConnected: () => { void refresh(); },
    onEvent: (event) => { if ((event as { type?: string }).type === "buddy_group_changed") void refresh(); },
    onChatStatus: (_project, _task, chat) => { if (items.some((group) => group.members.some((member) => member.session_id === chat))) void refresh(); },
  });
  return { items, error, refresh };
}
