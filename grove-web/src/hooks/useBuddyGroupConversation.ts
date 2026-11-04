import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listBuddyGroupMessages, sendBuddyGroupMessage, stopBuddyGroup, type BuddyGroup, type BuddyGroupMessage } from "../api/buddyGroups";
import { friendlyStep } from "../components/Buddy/timeline/activityLabels";
import type { useBuddyComposer } from "./useBuddyComposer";
import { fileData } from "./useBuddyComposer";
import { errorMessage } from "../utils/errorMessage";
import { useRadioEvents } from "./useRadioEvents";

interface TurnRadioEvent { type: "turn"; chat_id: string; event: { state: string; title?: string | null } }

/** The shared log of one group, plus what each working member is doing right now. */
export function useBuddyGroupConversation(group: BuddyGroup, onSent: () => void) {
  const id = group.id;
  const [messages, setMessages] = useState<BuddyGroupMessage[]>([]);
  const [hasEarlier, setHasEarlier] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [activity, setActivity] = useState<Record<string, string>>({});
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++request.current;
    try {
      const page = await listBuddyGroupMessages(id);
      if (current !== request.current) return;
      // Keep pages already loaded; only the tail changes.
      setMessages((known) => [...known.filter((message) => message.group_id === id && message.seq < (page.messages[0]?.seq ?? 0)), ...page.messages]);
      setHasEarlier((known) => known || page.has_earlier);
      setError(null);
    } catch (reason) { if (current === request.current) setError(errorMessage(reason)); }
  }, [id]);
  useEffect(() => { void Promise.resolve().then(refresh); }, [refresh]);
  const sessions = useMemo(() => new Map(group.members.map((member) => [member.session_id, member.buddy_id])), [group.members]);
  useRadioEvents({
    onConnected: () => { void refresh(); },
    onEvent: (raw) => {
      const event = raw as { type?: string; group_id?: string };
      if (event.type === "buddy_group_changed" && event.group_id === id) { void refresh(); return; }
      if (event.type !== "turn") return;
      const turn = raw as TurnRadioEvent, buddy = sessions.get(turn.chat_id);
      if (!buddy) return;
      if (turn.event.state === "tool_changed" && turn.event.title) { const step = friendlyStep(turn.event.title); setActivity((current) => ({ ...current, [buddy]: step })); }
      else if (["completed", "failed", "session_ended"].includes(turn.event.state)) setActivity((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== buddy)));
    },
  });
  const loadEarlier = useCallback(async () => {
    const first = messages[0]?.seq;
    if (!first || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const page = await listBuddyGroupMessages(id, first);
      setMessages((known) => [...page.messages, ...known]);
      setHasEarlier(page.has_earlier);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setLoadingEarlier(false); }
  }, [id, loadingEarlier, messages]);
  const transport: ReturnType<typeof useBuddyComposer> = {
    send: async (text, files) => {
      setSending(true);
      try {
        const attachments = await Promise.all(files.map(async (file) => ({ name: file.name, mime_type: file.type || "application/octet-stream", data: await fileData(file) })));
        await sendBuddyGroupMessage(id, text, attachments);
        await refresh();
        onSent();
      } finally { setSending(false); }
    },
    stop: () => { void stopBuddyGroup(id).catch((reason) => setError(errorMessage(reason))); },
    sending,
    connected: true,
  };
  return { messages, hasEarlier, loadingEarlier, loadEarlier, error, activity, transport };
}
