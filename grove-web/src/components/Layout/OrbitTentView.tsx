import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useTent } from "../../hooks/useBookFold";
import { IOS_ACTIVITY_EVENT, currentActivity } from "../../ios/activityFeed";
import type { ChatState, Phase } from "../../ios/activityState";
import "./orbit-tent.css";

const PHASE_LABEL: Record<Phase, string> = {
  waiting: "Needs you",
  running: "Running",
  connecting: "Connecting",
  idle: "Idle",
  finished: "Done",
  completed: "Done",
  cancelled: "Stopped",
  failed: "Failed",
  disconnected: "Offline",
};
const ORDER: Phase[] = ["waiting", "running", "connecting", "failed", "finished", "completed", "cancelled", "idle", "disconnected"];

function since(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}

/**
 * iPhone Duo half open and stood on a table, the outer screen facing out:
 * a board to glance at from a distance. Every Session the server is running,
 * the ones waiting on you first; tap one to see it large.
 */
export function OrbitTentView() {
  const tentState = useTent();
  const tent = !!tentState;
  const turn = tentState?.turn ?? 0;
  const [chats, setChats] = useState<ChatState[]>(currentActivity);
  const [picked, setPicked] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const update = (event: Event) => setChats((event as CustomEvent<ChatState[]>).detail);
    window.addEventListener(IOS_ACTIVITY_EVENT, update);
    return () => window.removeEventListener(IOS_ACTIVITY_EVENT, update);
  }, []);

  useEffect(() => {
    if (!tent) return;
    const clock = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(clock);
  }, [tent]);

  const sorted = useMemo(
    () => [...chats].sort((a, b) => ORDER.indexOf(a.phase) - ORDER.indexOf(b.phase) || b.changedAt - a.changedAt),
    [chats],
  );
  if (!tent) return null;

  const key = (c: ChatState) => `${c.project}/${c.task}/${c.chat}`;
  const current = sorted.find((c) => key(c) === picked) ?? sorted[0];
  const running = chats.filter((c) => c.phase === "running" || c.phase === "waiting" || c.phase === "connecting").length;

  return (
    <div
      className={`orbit-tent${turn ? " is-turned" : ""}`}
      style={turn ? ({ "--tent-turn": `${turn}deg` } as CSSProperties) : undefined}
      role="dialog"
      aria-label="Sessions"
    >
      <div className="orbit-tent-list">
        <div className="orbit-tent-count">{running ? `${running} running` : "Nothing running"}</div>
        {sorted.map((c) => (
          <button
            key={key(c)}
            type="button"
            className={`orbit-tent-row is-${c.phase}${current && key(c) === key(current) ? " is-on" : ""}`}
            onClick={() => setPicked(key(c))}
          >
            <span className="orbit-tent-dot" aria-hidden="true" />
            <span className="orbit-tent-row-text">
              <span className="orbit-tent-row-name">{c.sessionName || c.taskName || "Session"}</span>
              <span className="orbit-tent-row-meta">{PHASE_LABEL[c.phase]} · {since(c.changedAt, now)}</span>
            </span>
          </button>
        ))}
      </div>
      {current ? (
        <div className={`orbit-tent-focus is-${current.phase}`}>
          <div className="orbit-tent-focus-task">{current.taskName}</div>
          <div className="orbit-tent-focus-name">{current.sessionName || current.taskName || "Session"}</div>
          <div className="orbit-tent-focus-phase">
            <span className="orbit-tent-dot" aria-hidden="true" />
            {PHASE_LABEL[current.phase]}
            <span className="orbit-tent-focus-since">{since(current.changedAt, now)}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
