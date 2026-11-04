import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Buddy } from "../api/buddies";
import { BUDDIES_MOCK_ENABLED, buddiesMock } from "../api/buddies.mock";
import { connectBuddySession, onBuddyAgentRestarted, type PromptCapabilities } from "../api/buddySessionConnection";
import { getChatHistory } from "../api/tasks";
import { getChatSocket } from "../api/chatSockets";
import { emptyBuddyTimeline, reduceBuddyEvent, type BuddyEvent, type BuddyTimelineState } from "../components/Buddy/timeline/buddyTimelineState";
import { prependHistory, restoreBuddyHistory, settleHistory, withPreviousSegments } from "../components/Buddy/timeline/buddySegmentHistory";
import { adoptSession, parkSession } from "../components/Tasks/TaskView/sessionPool";

/** Turns per page: the latest page loads with the conversation, older ones as the user scrolls up. */
export const BUDDY_HISTORY_PAGE_TURNS = 20;

/** Where the next earlier page comes from: a Session and the history index to page back from (undefined = its end). */
interface HistoryCursor { session: string; before?: number; endedAt?: string }
interface SessionState { previous: BuddyTimelineState; current: BuddyTimelineState }
type Action = { type: "history"; events: BuddyEvent[]; busy: boolean } | { type: "older"; page: BuddyTimelineState; key: string } | { type: "event"; event: BuddyEvent } | { type: "restore"; timelines: SessionState };
/** What survives this hook unmounting, so reopening the Buddy shows it at once. */
interface ParkedBuddy { timelines: SessionState; cursors: HistoryCursor[]; promptCaps: PromptCapabilities | null; segmentKey: string; loaded: boolean }
function reducer(state: SessionState, action: Action): SessionState {
  if (action.type === "restore") return action.timelines;
  if (action.type === "history") return { previous: emptyBuddyTimeline(), current: { ...restoreBuddyHistory(action.events), busy: action.busy } };
  if (action.type === "older") return { ...state, previous: prependHistory(action.page, action.key, state.previous) };
  return { ...state, current: reduceBuddyEvent(state.current, action.event) };
}
export function useBuddySession(buddy: Buddy) {
  const [timelines, dispatch] = useReducer(reducer, undefined, () => ({ previous: emptyBuddyTimeline(), current: emptyBuddyTimeline() }));
  const { previous, current } = timelines;
  const timelinesRef = useRef(timelines);
  useEffect(() => { timelinesRef.current = timelines; }, [timelines]);
  const state = useMemo(() => withPreviousSegments(previous, current), [previous, current]);
  const [connected, setConnected] = useState(BUDDIES_MOCK_ENABLED);
  const [loading, setLoading] = useState(!BUDDIES_MOCK_ENABLED);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  /** Unknown until the session reports it; the composer then sends media the agent can't read as files. */
  const [promptCaps, setPromptCaps] = useState<PromptCapabilities | null>(null);
  const promptCapsRef = useRef(promptCaps);
  useEffect(() => { promptCapsRef.current = promptCaps; }, [promptCaps]);
  const { id, project_hash, local_task_id, active_session_id } = buddy;
  // Profile/status refreshes must not reconnect a live socket. Track only the
  // Segment identities/order and closure timestamps needed to restore history.
  const segmentKey = JSON.stringify(buddy.segments.map(({ session_id, seq, ended_at }) => ({ session_id, seq, ended_at })));
  // Pages walk back through the current Segment, then each ended Segment, newest first.
  const cursors = useRef<HistoryCursor[]>([]);
  const [hasEarlier, setHasEarlier] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const loadingRef = useRef(false);
  const generation = useRef(0);
  // A manual Reconnect restarts from the server, never from parked state.
  const reconnecting = useRef(false);
  const refreshMock = useCallback(() => {
    if (!BUDDIES_MOCK_ENABLED) return;
    dispatch({ type: "history", events: buddiesMock.events(id), busy: buddiesMock.get(id).status === "working" });
  }, [id]);
  useEffect(() => {
    if (BUDDIES_MOCK_ENABLED) { refreshMock(); return; }
    const key = `buddy:${project_hash}:${local_task_id}:${active_session_id}`;
    const parked = reconnecting.current ? null : adoptSession<ParkedBuddy>(key);
    reconnecting.current = false;
    const resumed = parked?.data.segmentKey === segmentKey ? parked : null;
    if (resumed) {
      cursors.current = resumed.data.cursors;
      generation.current += 1;
      dispatch({ type: "restore", timelines: resumed.data.timelines });
      setHasEarlier(cursors.current.length > 0); setPromptCaps(resumed.data.promptCaps); setLoading(false); setError(null);
    }
    const live = resumed?.data.loaded ? resumed.socket : null;
    if (parked && !live) parked.socket?.close();
    let hydrated = !!resumed, lastActivity = resumed?.lastActivityAt ?? Date.now();
    const dispose = connectBuddySession({ project_hash, local_task_id, active_session_id }, {
      history: (events, busy, start) => {
        hydrated = true;
        const ended = (JSON.parse(segmentKey) as { session_id: string; seq: number; ended_at: string | null }[])
          .filter(segment => segment.session_id !== active_session_id && segment.ended_at).sort((a, b) => b.seq - a.seq)
          .map(segment => ({ session: segment.session_id, endedAt: segment.ended_at! }));
        cursors.current = [...(start > 0 ? [{ session: active_session_id, before: start }] : []), ...ended];
        generation.current += 1;
        setHasEarlier(cursors.current.length > 0);
        dispatch({ type: "history", events, busy }); setLoading(false);
      },
      event: event => { lastActivity = Date.now(); dispatch({ type: "event", event }); }, ready: setConnected, capabilities: setPromptCaps, error: message => { setError(message); setLoading(false); },
    }, { recentTurns: BUDDY_HISTORY_PAGE_TURNS, socket: live });
    return () => {
      if (reconnecting.current || !hydrated) { dispose(); return; }
      const socket = dispose({ keepSocket: true }) ?? null;
      const now = Date.now();
      parkSession<ParkedBuddy>(key, {
        data: { timelines: timelinesRef.current, cursors: cursors.current, promptCaps: promptCapsRef.current, segmentKey, loaded: !!socket },
        socket, viewedAt: now, lastMessageAt: now, lastActivityAt: lastActivity,
        apply: (data, event) => { data.timelines = { ...data.timelines, current: reduceBuddyEvent(data.timelines.current, event as BuddyEvent) }; },
        isBusy: data => data.loaded && data.timelines.current.busy,
        onSocketLost: data => { data.loaded = false; },
      });
    };
  }, [project_hash, local_task_id, active_session_id, segmentKey, revision, refreshMock]);
  const loadEarlier = useCallback(async () => {
    if (loadingRef.current || !cursors.current.length) return;
    loadingRef.current = true; setLoadingEarlier(true);
    const run = generation.current;
    try {
      // Skip empty Segments so one scroll always brings something in.
      while (cursors.current.length && run === generation.current) {
        const cursor = cursors.current[0];
        const page = await getChatHistory(project_hash, local_task_id, cursor.session, 0, { recentTurns: BUDDY_HISTORY_PAGE_TURNS, before: cursor.before });
        if (run !== generation.current) return;
        const start = page.start ?? 0;
        cursors.current = start > 0 ? [{ ...cursor, before: start }, ...cursors.current.slice(1)] : cursors.current.slice(1);
        if (page.events.length) { dispatch({ type: "older", page: settleHistory(page.events as BuddyEvent[], cursor.endedAt), key: `${cursor.session}@${start}` }); break; }
      }
    } catch (reason) {
      if (run === generation.current) setError(reason instanceof Error ? reason.message : "Could not load earlier messages.");
    } finally {
      loadingRef.current = false; setLoadingEarlier(false); setHasEarlier(cursors.current.length > 0);
    }
  }, [project_hash, local_task_id]);
  const reconnect = useCallback(() => { reconnecting.current = true; setError(null); setConnected(false); setLoading(true); setRevision(value => value + 1); }, []);
  useEffect(() => onBuddyAgentRestarted(active_session_id, reconnect), [active_session_id, reconnect]);
  const sendEvent = (event: BuddyEvent) => {
    if (BUDDIES_MOCK_ENABLED) { dispatch({ type: "event", event: buddiesMock.respond(id, event) }); return; }
    const socket = getChatSocket(project_hash, local_task_id, active_session_id);
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Wait for the session to reconnect.");
    socket.send(JSON.stringify(event));
  };
  return { state, connected, loading, error, promptCaps, refreshMock, hasEarlier, loadingEarlier, loadEarlier, dispatch: (event: BuddyEvent) => dispatch({ type: "event", event }), sendEvent,
    reconnect,
    stop: () => { if (BUDDIES_MOCK_ENABLED) { buddiesMock.stop(id); refreshMock(); } else sendEvent({ type: "cancel" }); },
  };
}
