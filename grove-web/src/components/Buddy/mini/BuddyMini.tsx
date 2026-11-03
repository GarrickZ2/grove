import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowUpRight, ChevronDown, Minus } from "lucide-react";
import { getBuddy, listBuddies, type Buddy, type BuddySummary } from "../../../api/buddies";
import { useShellAuth } from "../../../hooks/useShellAuth";
import { ConfigProvider } from "../../../context";
import { OrbitInterfaceProvider } from "../../../orbit/ui/OrbitInterfaceProvider";
import { useOrbitInterface } from "../../../orbit/ui/interfaceContext";
import "../../../orbit/tokens.css";
import { useRadioEvents } from "../../../hooks/useRadioEvents";
import { errorMessage } from "../../../utils/errorMessage";
import { BuddyAvatar } from "../BuddyAvatar";
import { BuddyConversation } from "../BuddyConversation";
import "../buddy.css";
import "./buddy-mini.css";

/** Pointer travel that turns a press on the bubble into a window drag. */
const DRAG_SLOP = 3;
/** How long a reply stays up beside the collapsed avatar (paused while hovered). */
const REPLY_MS = 8000;
/** Window room for each speech bubble; buddy-mini.css places them. */
const PEEK_SIZE = { none: [100, 100], typing: [154, 130], text: [340, 180] } as const;

/** What the collapsed Buddy says beside its avatar. */
type Peek = { kind: "typing" } | { kind: "reply" | "waiting"; text: string };

/**
 * The mini Buddy window (desktop app only): one Buddy at a time, floating
 * over other apps. Collapsed it is the avatar; a click grows a compact
 * conversation out of it, a drag moves the window. The arrow hands the
 * conversation back to Grove (and closes this window). While collapsed, the
 * conversation stays mounted off-screen, so it stays connected and reopens at
 * once; live status events keep the Buddy fresh, so a reply lights the bubble.
 */
export function BuddyMini() {
  const { authReady } = useShellAuth();
  // Config (and so the Orbit look the main window uses) loads once signed in.
  if (!authReady) return null;
  return <ConfigProvider><OrbitInterfaceProvider><MiniWindow /></OrbitInterfaceProvider></ConfigProvider>;
}

function MiniWindow() {
  const orbit = useOrbitInterface();
  const [id, setId] = useState(() => new URLSearchParams(location.search).get("id") ?? "");
  const [buddy, setBuddy] = useState<Buddy | null>(null);
  const [others, setOthers] = useState<BuddySummary[]>([]);
  /** `closing` plays the shrink into the bubble before the window shrinks. */
  const [phase, setPhase] = useState<"expanded" | "closing" | "collapsed">("expanded");
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Activity seen when collapsing; newer activity marks the bubble unread. */
  const [seenAt, setSeenAt] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  /** The panel's size, held off-screen so scrolling stays put while collapsed. */
  const [heldSize, setHeldSize] = useState<{ width: number; height: number }>();

  /** The reply shown after a turn finishes while collapsed. */
  const [reply, setReply] = useState<string | null>(null);
  const last = useRef<Buddy | null>(null);
  const phaseNow = useRef(phase);
  useEffect(() => { phaseNow.current = phase; }, [phase]);
  const dismissReply = useCallback(() => setReply(null), []);
  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const [detail, all] = await Promise.all([getBuddy(id), listBuddies()]);
      // A turn that finished while collapsed pops its reply out of the bubble.
      const before = last.current;
      if (phaseNow.current === "collapsed" && before?.id === detail.id && before.status !== "idle" && detail.status === "idle" && !detail.last_turn_quiet && detail.last_message_preview) setReply(detail.last_message_preview);
      last.current = detail;
      setBuddy(detail); setOthers(all); setError(null);
    } catch (reason) { setError(errorMessage(reason)); }
  }, [id]);
  useEffect(() => { void Promise.resolve().then(refresh); }, [refresh]);

  // Opening the mini window for another Buddy switches this one.
  useEffect(() => {
    let stop: (() => void) | undefined, cancelled = false;
    void listen<string>("buddy-mini:show", (event) => { setId(event.payload); setPhase("expanded"); })
      .then((unlisten) => { if (cancelled) unlisten(); else stop = unlisten; }).catch(() => {});
    return () => { cancelled = true; stop?.(); };
  }, []);
  useRadioEvents({
    onConnected: () => { void refresh(); },
    onChatStatus: (_project, _task, chat) => { if (chat === buddy?.active_session_id) void refresh(); },
  });

  // Expand: grow the window first (the bubble keeps its corner), then the panel grows out of it.
  const expand = () => { void invoke("buddy_mini_set_expanded", { expanded: true }).catch(() => {}).finally(() => setPhase("expanded")); };
  // Collapse: the panel shrinks into the corner, then the window follows.
  const collapse = () => {
    if (panel.current) setHeldSize({ width: panel.current.offsetWidth, height: panel.current.offsetHeight });
    setSeenAt(buddy?.last_activity_at ?? null); setSwitching(false); setPhase("closing");
  };
  const collapsed = () => { setPhase("collapsed"); void invoke("buddy_mini_set_expanded", { expanded: false }).catch(() => {}); };

  const waiting = buddy?.status === "waiting" || (buddy?.waiting_delegations ?? 0) > 0;
  const peek: Peek | null = phase !== "collapsed" || !buddy ? null
    : waiting ? { kind: "waiting", text: buddy.status === "waiting" ? "Needs your approval" : "A subagent needs you" }
    : reply ? { kind: "reply", text: reply }
    : buddy.status === "working" ? { kind: "typing" } : null;
  const isCollapsed = phase === "collapsed";
  return <>{isCollapsed && <Bubble buddy={buddy} peek={peek} unread={!!buddy?.last_activity_at && buddy.last_activity_at !== seenAt}
    onOpen={() => { setReply(null); expand(); }} onDismissReply={dismissReply} />}
  <div ref={panel} className={`buddy-app buddy-mini${orbit ? " orbit-ui" : ""}${phase === "closing" ? " is-closing" : ""}${isCollapsed ? " is-collapsed" : ""}`} style={isCollapsed ? heldSize : undefined}
    onAnimationEnd={(event) => { if (event.target === event.currentTarget && phase === "closing") collapsed(); }}
    onKeyDown={(event) => { if (event.key === "Escape" && !event.defaultPrevented && !switching) collapse(); }}>
    <header className="buddy-mini-header" data-tauri-drag-region>
      <button type="button" className="buddy-mini-who" aria-haspopup="listbox" aria-expanded={switching} onClick={() => setSwitching(!switching)} disabled={others.length < 2}>
        {buddy && <BuddyAvatar id={buddy.id} avatar={buddy.avatar} size={22} state={buddy.status} />}
        <span>{buddy?.name ?? "Buddy"}</span>{others.length > 1 && <ChevronDown size={14} aria-hidden="true" />}
      </button>
      <span className="buddy-mini-spacer" data-tauri-drag-region />
      <button type="button" className="buddy-icon-button" aria-label="Back to Grove" title="Back to Grove" onClick={() => { void invoke("buddy_mini_open_in_main", { buddyId: id }).catch(() => {}); }}><ArrowUpRight size={16} /></button>
      <button type="button" className="buddy-icon-button" aria-label="Collapse" title="Collapse (Esc)" onClick={collapse}><Minus size={16} /></button>
    </header>
    {switching && <ul className="buddy-mini-switch" role="listbox" aria-label="Switch Buddy">{others.map((item) => <li key={item.id} role="option" aria-selected={item.id === id}>
      <button type="button" onClick={() => { setId(item.id); setSwitching(false); }}><BuddyAvatar id={item.id} avatar={item.avatar} size={20} state={item.status} /><span>{item.name}</span>{item.role && <small>{item.role}</small>}</button>
    </li>)}</ul>}
    {error && <p role="alert" className="buddy-mini-error">{error}</p>}
    {buddy && <BuddyConversation key={`${buddy.id}-${buddy.active_session_id}`} buddy={buddy} open={!isCollapsed} onChanged={() => { void refresh(); }} others={others.filter((item) => item.id !== buddy.id)} />}
  </div></>;
}

/** The collapsed avatar: click to open, drag to move the window. Beside it, a speech bubble: typing dots while it works, its reply when done, or a request. */
function Bubble({ buddy, peek, unread, onOpen, onDismissReply }: { buddy: Buddy | null; peek: Peek | null; unread: boolean; onOpen: () => void; onDismissReply: () => void }) {
  const press = useRef<{ x: number; y: number } | null>(null);
  const down = (event: PointerEvent) => { if (event.button === 0) press.current = { x: event.screenX, y: event.screenY }; };
  const move = (event: PointerEvent) => {
    const start = press.current;
    if (!start || Math.hypot(event.screenX - start.x, event.screenY - start.y) < DRAG_SLOP) return;
    press.current = null;
    void getCurrentWindow().startDragging().catch(() => {});
  };
  const up = () => { if (press.current) { press.current = null; onOpen(); } };
  const tone = buddy?.status === "waiting" || (buddy?.waiting_delegations ?? 0) > 0 ? "waiting" : buddy?.status ?? "idle";

  // Room for the speech bubble: grow the window before it pops, shrink after it goes.
  const room = !peek ? "none" : peek.kind === "typing" ? "typing" : "text";
  useEffect(() => {
    const [width, height] = PEEK_SIZE[room];
    void invoke("buddy_mini_set_collapsed_size", { width, height }).catch(() => {});
  }, [room]);
  // A reply goes away by itself, unless the pointer is resting on it.
  const [hovered, setHovered] = useState(false);
  const replyText = peek?.kind === "reply" ? peek.text : null;
  useEffect(() => {
    if (!replyText || hovered) return;
    const timer = window.setTimeout(onDismissReply, REPLY_MS);
    return () => window.clearTimeout(timer);
  }, [replyText, hovered, onDismissReply]);

  return <>
    {peek && <button type="button" key={peek.kind} className={`buddy-mini-say is-${peek.kind}`} onClick={onOpen} onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
      aria-label={peek.kind === "typing" ? `${buddy?.name ?? "Buddy"} is working` : `${buddy?.name ?? "Buddy"}: ${peek.text}`}>
      {peek.kind === "typing" ? <span className="buddy-mini-dots" aria-hidden="true"><i /><i /><i /></span> : <span className="buddy-mini-say-text">{peek.text}</span>}
    </button>}
    <button type="button" className={`buddy-mini-bubble${unread ? " is-unread" : ""}`} aria-label={`Open ${buddy?.name ?? "Buddy"}${tone !== "idle" ? `, ${tone}` : ""}${unread ? ", new messages" : ""}`}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); } }}>
      {buddy && <BuddyAvatar id={buddy.id} avatar={buddy.avatar} size={56} state={buddy.status} />}
      {tone !== "idle" && !peek && <span className={`buddy-mini-state is-${tone}`} aria-hidden="true" />}
      {unread && !peek && <span className="buddy-mini-unread" aria-hidden="true" />}
    </button>
  </>;
}
