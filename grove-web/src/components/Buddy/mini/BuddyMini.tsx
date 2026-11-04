import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowUpRight, ChevronDown, Minus } from "lucide-react";
import { getBuddy, listBuddies, type Buddy, type BuddyStatus, type BuddySummary } from "../../../api/buddies";
import { getBuddyGroup, GROUP_REF_PREFIX, listBuddyGroupMessages, listBuddyGroups, type BuddyGroup } from "../../../api/buddyGroups";
import { useShellAuth } from "../../../hooks/useShellAuth";
import { ConfigProvider } from "../../../context";
import { OrbitInterfaceProvider } from "../../../orbit/ui/OrbitInterfaceProvider";
import { useOrbitInterface } from "../../../orbit/ui/interfaceContext";
import "../../../orbit/tokens.css";
import { useConfig } from "../../../context";
import { useRadioEvents } from "../../../hooks/useRadioEvents";
import { BUDDY_MOTION_EVENT, type BuddyMotion } from "../../Config/useBuddyMotionSetting";
import { errorMessage } from "../../../utils/errorMessage";
import { BuddyAvatar } from "../BuddyAvatar";
import { resolveBuddyAvatar } from "../buddyAvatarConfig";
import { BuddyConversation } from "../BuddyConversation";
import { BuddyGroupAvatar } from "../group/BuddyGroupAvatar";
import { BuddyGroupConversation } from "../group/BuddyGroupConversation";
import { latestGroupReply } from "../group/groupTimeline";
import { useMiniPresence } from "./useMiniPresence";
import "../buddy.css";
import "./buddy-mini.css";

/** Pointer travel that turns a press on the bubble into a window drag. */
const DRAG_SLOP = 3;
/** How long a reply stays up beside the collapsed avatar (paused while hovered). */
const REPLY_MS = 8000;
/** Window room for each speech bubble; buddy-mini.css places them. */
const PEEK_SIZE = { none: [100, 100], typing: [154, 130], text: [340, 180] } as const;

/** What the collapsed Buddy says beside its avatar. */
type Peek = { kind: "typing" } | { kind: "reply" | "waiting"; text: string; more?: number };

/**
 * The mini Buddy window (desktop app only): one Buddy or group at a time, floating
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
  const { config } = useConfig();
  const [motion, setMotion] = useState<BuddyMotion | null>(null);
  const [id, setId] = useState(() => new URLSearchParams(location.search).get("id") ?? "");
  const [buddy, setBuddy] = useState<Buddy | null>(null);
  const groupId = id.startsWith(GROUP_REF_PREFIX) ? id.slice(GROUP_REF_PREFIX.length) : "";
  const [group, setGroup] = useState<BuddyGroup | null>(null);
  const [groups, setGroups] = useState<BuddyGroup[]>([]);
  const [others, setOthers] = useState<BuddySummary[]>([]);
  /** `closing` plays the shrink into the bubble before the window shrinks. */
  const [phase, setPhase] = useState<"expanded" | "closing" | "collapsed">("collapsed");
  // Plays when summoned from the main window, not on every collapse.
  const [arriving, setArriving] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Activity seen when collapsing; newer activity marks the bubble unread. */
  const [seenAt, setSeenAt] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  /** The panel's size, held off-screen so scrolling stays put while collapsed. */
  const [heldSize, setHeldSize] = useState({ width: 380, height: 580 });

  /** The reply shown after a turn finishes while collapsed. */
  const [reply, setReply] = useState<{ text: string; more?: number } | null>(null);
  const last = useRef<Buddy | null>(null);
  /** Group replies count from here: when the window collapsed, or the last bubble went away. */
  const repliesSince = useRef<string | null>(null);
  /** What's already there when a conversation opens isn't news. */
  const opening = useRef(true);
  const settle = useCallback((activity: string | null) => {
    if (!opening.current) return;
    opening.current = false;
    setSeenAt(activity); repliesSince.current = activity;
  }, []);
  const phaseNow = useRef(phase);
  useEffect(() => { phaseNow.current = phase; }, [phase]);
  const groupNow = useRef(group);
  useEffect(() => { groupNow.current = group; }, [group]);
  const dismissReply = useCallback(() => { setReply(null); repliesSince.current = groupNow.current?.last_activity_at ?? null; }, []);
  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      if (groupId) {
        const [detail, all, listed] = await Promise.all([getBuddyGroup(groupId), listBuddies(), listBuddyGroups().catch(() => [])]);
        settle(detail.last_activity_at);
        if (phaseNow.current === "collapsed" && groupNow.current?.last_activity_at !== detail.last_activity_at) {
          const { messages } = await listBuddyGroupMessages(groupId);
          const nameOf = (buddy: string) => detail.members.find((member) => member.buddy_id === buddy)?.name ?? "A Buddy";
          const latest = latestGroupReply(messages, repliesSince.current, nameOf);
          if (latest) setReply(latest);
        }
        setGroup(detail); setBuddy(null); setOthers(all); setGroups(listed); setError(null);
        return;
      }
      const [detail, all, listed] = await Promise.all([getBuddy(id), listBuddies(), listBuddyGroups().catch(() => [])]);
      settle(detail.last_activity_at);
      // A turn that finished while collapsed pops its reply out of the bubble.
      const before = last.current;
      if (phaseNow.current === "collapsed" && before?.id === detail.id && before.status !== "idle" && detail.status === "idle" && !detail.last_turn_quiet && detail.last_message_preview) setReply({ text: detail.last_message_preview });
      last.current = detail;
      setBuddy(detail); setGroup(null); setOthers(all); setGroups(listed); setError(null);
    } catch (reason) { setError(errorMessage(reason)); }
  }, [id, groupId, settle]);
  useEffect(() => { void Promise.resolve().then(refresh); }, [refresh]);

  // Opening the mini window for another Buddy switches this one, collapsed.
  useEffect(() => {
    let stop: (() => void) | undefined, cancelled = false;
    void listen<string>("buddy-mini:show", (event) => { opening.current = true; setId(event.payload); setReply(null); setSwitching(false); setPhase("collapsed"); setArriving(true); })
      .then((unlisten) => { if (cancelled) unlisten(); else stop = unlisten; }).catch(() => {});
    return () => { cancelled = true; stop?.(); };
  }, []);
  useRadioEvents({
    onConnected: () => { void refresh(); },
    onChatStatus: (_project, _task, chat) => { if (chat === buddy?.active_session_id || group?.members.some((member) => member.session_id === chat)) void refresh(); },
    onEvent: (event) => { const update = event as { type?: string; group_id?: string }; if (update.type === "buddy_group_changed" && update.group_id === groupId) void refresh(); },
  });

  // Settings live in the main window; a change there reaches this one as an event.
  useEffect(() => {
    let stop: (() => void) | undefined, cancelled = false;
    void listen<BuddyMotion>(BUDDY_MOTION_EVENT, (event) => setMotion(event.payload))
      .then((unlisten) => { if (cancelled) unlisten(); else stop = unlisten; }).catch(() => {});
    return () => { cancelled = true; stop?.(); };
  }, []);

  // Expand: grow the window first (the bubble keeps its corner), then the panel grows out of it.
  const expand = () => { setArriving(false); void invoke("buddy_mini_set_expanded", { expanded: true }).catch(() => {}).finally(() => setPhase("expanded")); };
  // Collapse: the panel shrinks into the corner, then the window follows.
  const collapse = () => {
    if (panel.current) setHeldSize({ width: panel.current.offsetWidth, height: panel.current.offsetHeight });
    const seen = (group ?? buddy)?.last_activity_at ?? null;
    setSeenAt(seen); repliesSince.current = seen; setSwitching(false); setPhase("closing");
  };
  const collapsed = () => { setPhase("collapsed"); void invoke("buddy_mini_set_expanded", { expanded: false }).catch(() => {}); };

  const subject = group ?? buddy;
  const waitingMember = group?.members.find((member) => member.status === "waiting");
  const waiting = !!waitingMember || buddy?.status === "waiting" || (buddy?.waiting_delegations ?? 0) > 0;
  const peek: Peek | null = phase !== "collapsed" || !subject ? null
    : waiting ? { kind: "waiting", text: waitingMember ? `${waitingMember.name} needs your approval` : buddy?.status === "waiting" ? "Needs your approval" : "A subagent needs you" }
    : reply ? { kind: "reply", ...reply }
    : subject.status === "working" ? { kind: "typing" } : null;
  const isCollapsed = phase === "collapsed";
  const tone: BuddyStatus = waiting ? "waiting" : subject?.status ?? "idle";
  const face = (size: number) => group ? <BuddyGroupAvatar members={group.members} size={size} /> : buddy && <BuddyAvatar id={buddy.id} avatar={buddy.avatar} size={size} state={buddy.status} />;
  const lead = group ? group.members[0] && { id: group.members[0].buddy_id, avatar: group.members[0].avatar } : buddy;
  const color = lead ? resolveBuddyAvatar(lead.id, lead.avatar).color : undefined;
  return <>{isCollapsed && <Bubble name={subject?.name ?? "Buddy"} face={face(56)} arriving={arriving && !!subject} color={color} onArrived={() => setArriving(false)} tone={tone} peek={peek} activity={subject?.last_activity_at} lively={(motion ?? config?.web.buddy_motion) !== "standard"} unread={!!subject?.last_activity_at && subject.last_activity_at !== seenAt}
    onOpen={() => { setReply(null); expand(); }} onDismissReply={dismissReply} />}
  <div ref={panel} className={`buddy-app buddy-mini${orbit ? " orbit-ui" : ""}${phase === "closing" ? " is-closing" : ""}${isCollapsed ? " is-collapsed" : ""}`} style={isCollapsed ? heldSize : undefined}
    onAnimationEnd={(event) => { if (event.target === event.currentTarget && phase === "closing") collapsed(); }}
    onKeyDown={(event) => { if (event.key === "Escape" && !event.defaultPrevented && !switching) collapse(); }}>
    <header className="buddy-mini-header" data-tauri-drag-region>
      <button type="button" className="buddy-mini-who" aria-haspopup="listbox" aria-expanded={switching} onClick={() => setSwitching(!switching)} disabled={others.length + groups.length < 2}>
        {face(22)}
        <span>{subject?.name ?? "Buddy"}</span>{others.length + groups.length > 1 && <ChevronDown size={14} aria-hidden="true" />}
      </button>
      <span className="buddy-mini-spacer" data-tauri-drag-region />
      <button type="button" className="buddy-icon-button" aria-label="Back to Grove" title="Back to Grove" onClick={() => { void invoke("buddy_mini_open_in_main", { buddyId: id }).catch(() => {}); }}><ArrowUpRight size={16} /></button>
      <button type="button" className="buddy-icon-button" aria-label="Collapse" title="Collapse (Esc)" onClick={collapse}><Minus size={16} /></button>
    </header>
    {switching && <ul className="buddy-mini-switch" role="listbox" aria-label="Switch Buddy">{groups.map((item) => <li key={item.id} role="option" aria-selected={item.id === groupId}>
      <button type="button" onClick={() => { setId(`${GROUP_REF_PREFIX}${item.id}`); setSwitching(false); }}><BuddyGroupAvatar members={item.members} size={20} /><span>{item.name}</span><small>{item.members.length} Buddies</small></button>
    </li>)}{others.map((item) => <li key={item.id} role="option" aria-selected={item.id === id}>
      <button type="button" onClick={() => { setId(item.id); setSwitching(false); }}><BuddyAvatar id={item.id} avatar={item.avatar} size={20} state={item.status} /><span>{item.name}</span>{item.role && <small>{item.role}</small>}</button>
    </li>)}</ul>}
    {error && <p role="alert" className="buddy-mini-error">{error}</p>}
    {group && <BuddyGroupConversation key={group.id} group={group} buddies={others} compact onChanged={() => { void refresh(); }} />}
    {buddy && <BuddyConversation key={`${buddy.id}-${buddy.active_session_id}`} buddy={buddy} open={!isCollapsed} onChanged={() => { void refresh(); }} others={others.filter((item) => item.id !== buddy.id)} />}
  </div></>;
}

/** The collapsed avatar: click to open, drag to move the window. Beside it, a speech bubble: typing dots while it works, its reply when done, or a request. */
function Bubble({ name, face, arriving, color, onArrived, tone, peek, activity, lively, unread, onOpen, onDismissReply }: { name: string; face: React.ReactNode; arriving: boolean; color?: string; onArrived: () => void; tone: BuddyStatus; peek: Peek | null; activity: string | null | undefined; lively: boolean; unread: boolean; onOpen: () => void; onDismissReply: () => void }) {
  const avatar = useRef<HTMLButtonElement>(null);
  const { sleeping, waking, following, hovered: cursorOver, notice } = useMiniPresence({ collapsed: true, tone, activity, lively, bubble: avatar });
  const press = useRef<{ x: number; y: number } | null>(null);
  const down = (event: PointerEvent) => { if (event.button === 0) press.current = { x: event.screenX, y: event.screenY }; };
  const move = (event: PointerEvent) => {
    const start = press.current;
    if (!start || Math.hypot(event.screenX - start.x, event.screenY - start.y) < DRAG_SLOP) return;
    press.current = null;
    void getCurrentWindow().startDragging().catch(() => {});
  };
  const up = () => { if (press.current) { press.current = null; onOpen(); } };

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
      aria-label={peek.kind === "typing" ? `${name} is working` : `${name}: ${peek.text}`}>
      {peek.kind === "typing" ? <span className="buddy-mini-dots" aria-hidden="true"><i /><i /><i /></span> : <><span className="buddy-mini-say-text">{peek.text}</span>{!!peek.more && <span className="buddy-mini-say-more">+{peek.more}</span>}</>}
    </button>}
    <button type="button" ref={avatar} onPointerEnter={notice} style={color ? { "--buddy-color": color } as CSSProperties : undefined} onAnimationEnd={(event) => { if (event.target === event.currentTarget && event.animationName === "buddy-mini-arrive") onArrived(); }} className={`buddy-mini-bubble${arriving ? " is-arriving" : ""}${unread ? " is-unread" : ""}${sleeping ? " is-sleeping" : ""}${waking ? " is-waking" : ""}${following ? " is-following" : ""}${cursorOver ? " is-hovered" : ""}`} aria-label={`Open ${name}${tone !== "idle" ? `, ${tone}` : ""}${unread ? ", new messages" : ""}`}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); } }}>
      {face}
      {sleeping && <span className="buddy-mini-z" aria-hidden="true"><i>z</i><i>z</i></span>}
      {tone !== "idle" && !peek && <span className={`buddy-mini-state is-${tone}`} aria-hidden="true" />}
      {unread && !peek && <span className="buddy-mini-unread" aria-hidden="true" />}
    </button>
  </>;
}
