import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type { Buddy } from "../api/buddies";
import { BUDDIES_MOCK_ENABLED, buddiesMock } from "../api/buddies.mock";
import { connectBuddySession } from "../api/buddySessionConnection";
import { getChatSocket } from "../api/chatSockets";
import { emptyBuddyTimeline, reduceBuddyEvent, type BuddyEvent, type BuddyTimelineState } from "../components/Buddy/timeline/buddyTimelineState";
import { restoreBuddyHistory, restorePreviousSegments, withPreviousSegments, type BuddySegmentHistory } from "../components/Buddy/timeline/buddySegmentHistory";

type Action = { type: "history"; events: BuddyEvent[]; busy: boolean; previous?: BuddySegmentHistory[] } | { type: "event"; event: BuddyEvent };
interface SessionState { previous: BuddyTimelineState; current: BuddyTimelineState }
function reducer(state: SessionState, action: Action): SessionState {
  if (action.type === "history") return { previous: restorePreviousSegments(action.previous ?? []), current: { ...restoreBuddyHistory(action.events), busy: action.busy } };
  return { ...state, current: reduceBuddyEvent(state.current, action.event) };
}
export function useBuddySession(buddy: Buddy) {
  const [timelines, dispatch] = useReducer(reducer, undefined, () => ({ previous: emptyBuddyTimeline(), current: emptyBuddyTimeline() }));
  const { previous, current } = timelines;
  const state = useMemo(() => withPreviousSegments(previous, current), [previous, current]);
  const [connected, setConnected] = useState(BUDDIES_MOCK_ENABLED);
  const [loading, setLoading] = useState(!BUDDIES_MOCK_ENABLED);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const { id, project_hash, local_task_id, active_session_id } = buddy;
  // Profile/status refreshes must not reconnect a live socket. Track only the
  // Segment identities/order and closure timestamps needed to restore history.
  const segmentKey = JSON.stringify(buddy.segments.map(({ session_id, seq, ended_at }) => ({ session_id, seq, ended_at })));
  const refreshMock = useCallback(() => {
    if (!BUDDIES_MOCK_ENABLED) return;
    dispatch({ type: "history", events: buddiesMock.events(id), busy: buddiesMock.get(id).status === "working" });
  }, [id]);
  useEffect(() => {
    if (BUDDIES_MOCK_ENABLED) { refreshMock(); return; }
    return connectBuddySession({ project_hash, local_task_id, active_session_id, segments: JSON.parse(segmentKey) } as Buddy, {
      history: (events, busy, previous) => { dispatch({ type: "history", events, busy, previous }); setLoading(false); },
      event: event => dispatch({ type: "event", event }), ready: setConnected, error: message => { setError(message); setLoading(false); },
    });
  }, [project_hash, local_task_id, active_session_id, segmentKey, revision, refreshMock]);
  const sendEvent = (event: BuddyEvent) => {
    if (BUDDIES_MOCK_ENABLED) { dispatch({ type: "event", event: buddiesMock.respond(id, event) }); return; }
    const socket = getChatSocket(project_hash, local_task_id, active_session_id);
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Wait for the session to reconnect.");
    socket.send(JSON.stringify(event));
  };
  return { state, connected, loading, error, refreshMock, dispatch: (event: BuddyEvent) => dispatch({ type: "event", event }), sendEvent,
    reconnect: () => { setError(null); setConnected(false); setLoading(true); setRevision(value => value + 1); },
    stop: () => { if (BUDDIES_MOCK_ENABLED) { buddiesMock.stop(id); refreshMock(); } else sendEvent({ type: "cancel" }); },
  };
}
