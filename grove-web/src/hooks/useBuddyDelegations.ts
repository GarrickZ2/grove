import { useCallback, useEffect, useRef, useState } from "react";
import { cancelBuddyDelegation, listBuddyDelegations, type BuddyDelegation, type BuddySummary } from "../api/buddies";
import { BUDDIES_MOCK_ENABLED } from "../api/buddies.mock";
import { connectBuddySession } from "../api/buddySessionConnection";
import { getChatSocket, sendSessionInput } from "../api/chatSockets";
import { emptyBuddyTimeline, reduceBuddyEvent, type BuddyEvent, type BuddyTimelineState } from "../components/Buddy/timeline/buddyTimelineState";
import { restoreBuddyHistory } from "../components/Buddy/timeline/buddySegmentHistory";
import { errorMessage } from "../utils/errorMessage";
import { useRadioEvents } from "./useRadioEvents";
import { createClientMessageId } from "../utils/clientMessageId";

export const isOpenDelegation = (delegation: BuddyDelegation) => delegation.status === "running" || delegation.status === "waiting";

/** Delegation list for one Buddy. The stream never carries status; the list is the only source of truth. */
export function useBuddyDelegations(buddy: Pick<BuddySummary, "id" | "status" | "last_activity_at" | "running_delegations" | "waiting_delegations"> | null) {
  const id = buddy?.id ?? "";
  const [state, setState] = useState<{ id: string; items: BuddyDelegation[]; error: string | null }>({ id: "", items: [], error: null });
  const request = useRef(0);
  const refresh = useCallback(async () => {
    if (!id) return;
    const current = ++request.current;
    try { const items = await listBuddyDelegations(id); if (current === request.current) setState({ id, items, error: null }); }
    catch (reason) { if (current === request.current) setState(previous => ({ ...previous, id, error: errorMessage(reason) })); }
  }, [id]);
  // Summary changes follow the Buddy's own events: new delegate calls and delivered results.
  const signal = buddy ? `${buddy.status}|${buddy.last_activity_at}|${buddy.running_delegations}|${buddy.waiting_delegations}` : "";
  useEffect(() => { void Promise.resolve().then(refresh); }, [refresh, signal]);
  const items = state.id === id ? state.items : [];
  const open = items.some(isOpenDelegation);
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => { void refresh(); }, 10000);
    return () => window.clearInterval(timer);
  }, [open, refresh]);
  useRadioEvents({ onChatStatus: (_project, _task, chat) => { if (items.some(item => item.target_session === chat)) void refresh(); } });
  const cancel = useCallback(async (delegationId: string) => { await cancelBuddyDelegation(id, delegationId); await refresh(); }, [id, refresh]);
  return { items, error: state.id === id ? state.error : null, refresh, cancel };
}

export interface DelegationRequests {
  timeline: BuddyTimelineState;
  connected: boolean;
  sendEvent: (event: BuddyEvent) => void;
  dispatch: (event: BuddyEvent) => void;
  sendText: (text: string) => Promise<void>;
}

/** Read-only subscriptions to waiting subagent sessions; connecting replays their pending requests. */
export function useDelegationRequests(delegations: BuddyDelegation[]): Record<string, DelegationRequests> {
  const waiting = BUDDIES_MOCK_ENABLED ? [] : delegations.filter(item => item.status === "waiting");
  const key = JSON.stringify(waiting.map(item => [item.id, item.target_project, item.target_task, item.target_session]));
  const [states, setStates] = useState<Record<string, { timeline: BuddyTimelineState; connected: boolean }>>({});
  useEffect(() => {
    const targets = JSON.parse(key) as [string, string, string, string][];
    const disposers = targets.map(([id, project, task, session]) => {
      const update = (change: (value: { timeline: BuddyTimelineState; connected: boolean }) => { timeline: BuddyTimelineState; connected: boolean }) =>
        setStates(previous => ({ ...previous, [id]: change(previous[id] ?? { timeline: emptyBuddyTimeline(), connected: false }) }));
      return connectBuddySession({ project_hash: project, local_task_id: task, active_session_id: session }, {
        history: (events, busy) => update(value => ({ ...value, timeline: { ...restoreBuddyHistory(events), busy } })),
        event: event => update(value => ({ ...value, timeline: reduceBuddyEvent(value.timeline, event) })),
        ready: connected => update(value => ({ ...value, connected })),
        // A failed observer only hides inline cards; the delegation stays reachable from the panel.
        error: () => update(value => ({ ...value, connected: false })),
      }, { compact: false });
    });
    return () => disposers.forEach(dispose => dispose());
  }, [key]);
  const result: Record<string, DelegationRequests> = {};
  for (const delegation of waiting) {
    const value = states[delegation.id];
    if (!value) continue;
    const socket = () => {
      const current = getChatSocket(delegation.target_project, delegation.target_task, delegation.target_session);
      if (!current || current.readyState !== WebSocket.OPEN) throw new Error("Wait for the subagent session to reconnect.");
      return current;
    };
    result[delegation.id] = {
      ...value,
      sendEvent: event => socket().send(JSON.stringify(event)),
      dispatch: event => setStates(previous => previous[delegation.id] ? { ...previous, [delegation.id]: { ...previous[delegation.id], timeline: reduceBuddyEvent(previous[delegation.id].timeline, event) } } : previous),
      sendText: text => sendSessionInput(socket(), { text, attachments: [], id: createClientMessageId(), busy: value.timeline.busy }, new AbortController().signal),
    };
  }
  return result;
}
