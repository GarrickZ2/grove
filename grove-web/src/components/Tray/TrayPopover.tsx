/**
 * Menubar tray popover.
 *
 * Pure list view — user clicks tray icon, sees the list, clicks Open to
 * surface the main Grove window. No auto-popup, no toast mode, no
 * cross-window navigation. All "Open" actions just bring the main window
 * to the foreground.
 *
 * State is owned by React: a single `Map<chat_id, ChatItem>` driven by
 * `chat_status` events on the existing radio WebSocket. Reducer applies
 * status transitions as a state machine:
 *   busy                → status="running"   (RESET timer)
 *   permission_required → status="permission" (inherit Running's timer)
 *   idle                → status="done"      (FREEZE duration_ms)
 *   disconnected        → drop entry
 *
 * Layout: three sections with fixed-shape rows per type so an item never
 * grows to push others out of view.
 *   NEEDS YOU (permission) — large card, inline action buttons
 *   RUNNING                — medium card, single-line prompt, pulse strip
 *   RECENT (done)          — single-line rows, sticky collapsible header
 */

import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, LayoutGroup, AnimatePresence } from "framer-motion";
import { Settings, ExternalLink, ChevronDown, ChevronLeft, X, Zap, Pin, PinOff, GripVertical, Smartphone } from "lucide-react";
import { useRadioEvents } from "../../hooks/useRadioEvents";
import { TrayComposer } from "./TrayComposer";
import { agentOptions } from "../../data/agents";
import { agentIconComponent } from "../../utils/agentIcon";
import type { RadioEvent } from "../../api/walkieTalkie";
import { apiClient } from "../../api/client";
import { MarkdownRenderer } from "../ui/MarkdownRenderer";
import type { RetentionPolicyWire } from "../../api/config";
import { labelFor, orderOptions } from "../../utils/permissionOptions";
import type { PermissionOption } from "../../utils/permissionOptions";
export type { PermissionOption } from "../../utils/permissionOptions";

// ─── Types ──────────────────────────────────────────────────────────────────

type ChatStatusKind = "running" | "permission" | "done";

export interface ChatItem {
  chat_id: string;
  project_id: string;
  task_id: string;
  project_name: string;
  task_name: string;
  chat_title: string | null;
  agent: string | null;
  status: ChatStatusKind;
  running_started_at: number | null;
  entered_state_at: number;
  done_duration_ms: number | null;
  pending_options: PermissionOption[] | null;
  pending_description: string | null;
  prompt: string | null;
  message: string | null;
  todo_completed: number | null;
  todo_total: number | null;
}

type ChatStatusEvent = Extract<RadioEvent, { type: "chat_status" }>;

// ─── Retention + persistence ────────────────────────────────────────────────

const TRAY_CHATS_LS_KEY = "grove.tray.chats.v1";
const LS_WRITE_DEBOUNCE_MS = 200;

/** Returns the retention window in ms, or `null` for "forever". */
function retentionMs(policy: RetentionPolicyWire | null | undefined): number | null {
  if (!policy) return null;
  // Externally-tagged union: the JSON wire shape is
  //   { "forever": null }  or  { "expire": { ... } }
  // Both variants are objects with a single tagged key. Reading the
  // tagged key directly (instead of `in`) sidesteps TS's
  // "both variants may overlap" union narrow issue.
  const obj = policy as Record<string, unknown>;
  if ("forever" in obj) return null;
  const e = obj.expire as { value?: number; unit?: "hours" | "days" } | undefined;
  if (!e) return null;
  const value = Math.max(1, Math.floor(e.value ?? 3));
  const unitMs = e.unit === "hours" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  return value * unitMs;
}

/** Drop done chats whose `entered_state_at + retentionMs` is in the past.
 *  Running / permission chats are always kept — they're live. */
function pruneChatsByRetention(
  chats: Map<string, ChatItem>,
  policy: RetentionPolicyWire | null | undefined,
  now: number,
): Map<string, ChatItem> {
  const ms = retentionMs(policy);
  if (ms == null) return chats;
  let removed = false;
  const next = new Map(chats);
  for (const [id, c] of next) {
    if (c.status !== "done") continue;
    if (now - c.entered_state_at > ms) {
      next.delete(id);
      removed = true;
    }
  }
  return removed ? next : chats;
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m ${String(r).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function resolveAgent(agent: string | null) {
  if (!agent) return null;
  const lower = agent.toLowerCase();
  return (
    agentOptions.find((a) => {
      const id = a.id.toLowerCase();
      const value = a.value.toLowerCase();
      return id === lower || value === lower;
    }) ?? null
  );
}

/** Clean, predictable label per ACP `kind`. ACP `name` fields are often
 *  function-call dumps (e.g. `Always Allow all mcp__grove__grove_reply_review`)
 *  which look terrible as button labels. Falls back to `name` for unknown
 *  kinds. */
/** Build the provenance line shown under the title.
 *  - When the task name equals the project name (the project's own
 *    "local task"), `project · project` is just visual noise — replace
 *    the duplicate with the literal label "Work".
 *  - When a chat_title exists and differs from the task name, include
 *    the task as middle context; otherwise just project.
 */
function provenanceOf(item: ChatItem): string {
  const isLocal = item.task_name === item.project_name;
  const taskLabel = isLocal ? "Work" : item.task_name;
  if (item.chat_title && item.chat_title !== item.task_name) {
    return `${item.project_name} · ${taskLabel}`;
  }
  return isLocal ? `${item.project_name} · Work` : item.project_name;
}

/** Truncate a single-line preview hard so it never wraps mid-card. */
function oneLine(s: string | null, max = 120): string | null {
  if (!s) return null;
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1) + "…";
}

/** Convert a snapshot row into a renderable ChatItem. Only `busy` and
 *  `permission_required` chats surface in the tray (idle ones aren't shown
 *  unless they just transitioned), so anything else returns null. The snapshot
 *  carries no real start timestamp, so elapsed counts from connect time. */
function chatItemFromSnapshot(s: ChatSnapshot, now: number): ChatItem | null {
  const base = {
    chat_id: s.chat_id,
    project_id: s.project_id,
    task_id: s.task_id,
    project_name: s.project_name ?? s.project_id,
    task_name: s.task_name ?? s.task_id,
    chat_title: s.chat_title ?? null,
    agent: s.agent ?? null,
    running_started_at: now,
    entered_state_at: now,
    done_duration_ms: null,
    message: null,
    todo_completed: s.todo_completed ?? null,
    todo_total: s.todo_total ?? null,
  };
  if (s.status === "busy") {
    return {
      ...base,
      status: "running",
      pending_options: null,
      pending_description: null,
      prompt: s.prompt ?? null,
    };
  }
  if (s.status === "permission_required") {
    return {
      ...base,
      status: "permission",
      pending_options: s.permission?.options ?? null,
      pending_description: s.permission?.description ?? null,
      prompt: s.prompt ?? null,
    };
  }
  return null;
}

interface TrayShowConfig {
  permission: boolean;
  running: boolean;
  done: boolean;
}

const DEFAULT_SHOW: TrayShowConfig = { permission: true, running: true, done: true };

// ─── Platform abstraction ─────────────────────────────────────────────────
// TrayPopover is pure presentation + the chat-status reducer. Where its actions
// land differs by host: the desktop popover drives Tauri commands / window
// controls; the phone page drives HTTP endpoints on the radio server. Each host
// supplies a `platform` so this component stays free of host-specific imports.

/** One active chat as returned by `GET /api/v1/tray/chats` (snapshot seed). */
export interface ChatSnapshot {
  chat_id: string;
  project_id: string;
  task_id: string;
  project_name?: string | null;
  task_name?: string | null;
  chat_title?: string | null;
  agent?: string | null;
  status: "idle" | "busy" | "permission_required";
  permission?: { description: string; options: PermissionOption[] } | null;
  prompt?: string | null;
  todo_completed?: number | null;
  todo_total?: number | null;
}

export interface TrayPlatform {
  /** Approve / deny a pending permission request. */
  resolvePermission: (item: ChatItem, opt: PermissionOption) => void;
  /** Send a follow-up prompt to a Done chat. Resolves on success; rejects so
   *  the composer can surface the failure (e.g. the session already exited). */
  sendPrompt?: (item: ChatItem, text: string) => Promise<void>;
  /** Enable the hold-to-record microphone in the composer (phone only). When
   *  set, the composer records audio and transcribes via `/api/v1/ai/transcribe`. */
  enableVoice?: boolean;
  /** Open a specific chat in the full app. Omit to make cards non-clickable. */
  openTask?: (item: ChatItem) => void;
  /** Surface the main Grove window. Omit to hide the header button. */
  openMain?: () => void;
  /** Open settings. Omit to hide the header button. */
  openSettings?: () => void;
  /** Start a "sync to phone" flow. Omit to hide the header button. */
  syncToPhone?: () => void;
  /** Desktop window controls (pin / drag / resize). Omit on phone. */
  pinning?: {
    isPinned: () => Promise<boolean>;
    setPinned: (v: boolean) => void;
    startDragging: () => void;
    startResize: () => void;
  };
  /** Fetch `GET /api/v1/tray/chats` once on mount to seed state. The desktop
   *  popover relies on its long-lived webview accumulating live events, so it
   *  leaves this off; a phone connects fresh and needs the snapshot. */
  seedFromSnapshot?: boolean;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function TrayPopover({ platform }: { platform: TrayPlatform }) {
  const [chats, setChats] = useState<Map<string, ChatItem>>(() => {
    // Only the desktop tray accumulates across launches; the phone page
    // seeds from the backend snapshot and should start empty.
    if (typeof window === "undefined") return new Map();
    if (platform.seedFromSnapshot) return new Map();
    try {
      const raw = window.localStorage.getItem(TRAY_CHATS_LS_KEY);
      if (!raw) return new Map();
      const parsed = JSON.parse(raw) as { chats?: ChatItem[] };
      if (!parsed.chats || !Array.isArray(parsed.chats)) return new Map();
      const map = new Map<string, ChatItem>();
      for (const c of parsed.chats) {
        if (c && typeof c.chat_id === "string") map.set(c.chat_id, c);
      }
      return map;
    } catch {
      return new Map();
    }
  });
  const [now, setNow] = useState(() => Date.now());
  const [show, setShow] = useState<TrayShowConfig>(DEFAULT_SHOW);
  const [recentOpen, setRecentOpen] = useState(true);
  // The Done chat being replied to — opens a focused reply view (full response
  // + composer) overlaying the list. Null = list view.
  const [replyTarget, setReplyTarget] = useState<ChatItem | null>(null);
  // Retention policy for done chats. Loaded from /api/v1/config on mount;
  // stored in a ref (not state) because no UI subscribes to it — prune runs
  // inside `setChatsPruned` on every state transition, and the ref is the
  // source of truth. Null = "not yet loaded" → no pruning (conservative).
  const retentionRef = useRef<RetentionPolicyWire | null>(null);

  // Wrapper around setChats that runs the retention prune at every state
  // transition. Done in the updater (not a separate effect) so we don't
  // trigger React's "setState in effect" lint and avoid a cascading render
  // for every fresh event. The retention policy is read from a ref so the
  // wrapper's identity stays stable across policy changes.
  const setChatsPruned = useCallback(
    (updater: (prev: Map<string, ChatItem>) => Map<string, ChatItem>) => {
      setChats((prev) => {
        const next = updater(prev);
        return pruneChatsByRetention(next, retentionRef.current, Date.now());
      });
    },
    [],
  );

  const hasLiveCard = useMemo(
    () =>
      Array.from(chats.values()).some(
        (c) => c.status === "running" || c.status === "permission",
      ),
    [chats],
  );
  useEffect(() => {
    if (!hasLiveCard) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [hasLiveCard]);

  useEffect(() => {
    // Phone shows every section regardless of the desktop's tray_show_* prefs,
    // so it skips this fetch and keeps DEFAULT_SHOW. (Theme still syncs — that's
    // a separate /api/v1/config fetch inside ThemeProvider.)
    if (platform.seedFromSnapshot) return;
    let cancelled = false;
    const reload = async () => {
      // apiClient signs requests with HMAC in mobile mode; raw fetch would 401.
      let cfg: { notifications?: { tray_show_permission?: unknown; tray_show_running?: unknown; tray_show_done?: unknown; tray_done_retention?: RetentionPolicyWire } };
      try {
        cfg = await apiClient.get("/api/v1/config");
      } catch (e) {
        console.error("[TrayPopover] Failed to fetch config:", e);
        return;
      }
      if (cancelled) return;
      const notif = cfg.notifications;
      if (!notif) return;
      setShow({
        permission: !!notif.tray_show_permission,
        running: !!notif.tray_show_running,
        done: !!notif.tray_show_done,
      });
      if (notif.tray_done_retention) {
        retentionRef.current = notif.tray_done_retention;
      }
    };
    reload();
    const onFocus = () => reload();
    const onVisible = () => {
      if (document.visibilityState === "visible") reload();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [platform.seedFromSnapshot]);

  // Seed state on connect (phone only). Preferred source is the desktop tray's
  // mirrored panel (full Running / NEEDS YOU / Done with durations + responses),
  // shaped as ready ChatItems; the backend falls back to a lossy ACP snapshot
  // (idle/busy/permission_required) when no desktop is mirroring. Live events
  // take precedence — we only fill chats not already tracked.
  useEffect(() => {
    if (!platform.seedFromSnapshot) return;
    let cancelled = false;
    (async () => {
      let resp: { chats?: Array<ChatItem | ChatSnapshot>; now?: number };
      try {
        resp = await apiClient.get("/api/v1/tray/chats");
      } catch (e) {
        console.error("[TrayPopover] seed fetch failed:", e);
        return;
      }
      if (cancelled || !resp.chats) return;
      const ts = Date.now();
      // Desktop-clock → phone-clock offset. Mirrored timestamps are stamped on
      // the desktop; rebasing by this skew keeps the live elapsed timer correct
      // regardless of clock drift between the two devices.
      const skew = typeof resp.now === "number" ? ts - resp.now : 0;
      setChatsPruned((prev) => {
        const next = new Map(prev);
        for (const s of resp.chats!) {
          if (next.has(s.chat_id)) continue;
          const st = (s as { status?: string }).status;
          if (st === "running" || st === "permission" || st === "done") {
            // Already a ChatItem (desktop mirror) — load it, rebasing the live
            // timestamps to the phone clock. `done_duration_ms` is absolute and
            // left untouched.
            const item = s as ChatItem;
            next.set(s.chat_id, {
              ...item,
              running_started_at:
                item.running_started_at != null ? item.running_started_at + skew : null,
              entered_state_at: item.entered_state_at + skew,
            });
          } else {
            const item = chatItemFromSnapshot(s as ChatSnapshot, ts);
            if (item) next.set(s.chat_id, item);
          }
        }
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [platform.seedFromSnapshot, setChatsPruned]);

  // Desktop mirror: the tray webview is the only surface that watches the event
  // stream continuously, so it pushes its accumulated state to the backend
  // (debounced) for a later phone connect to seed from. Phones don't mirror.
  useEffect(() => {
    if (platform.seedFromSnapshot) return;
    const id = window.setTimeout(() => {
      // Include the desktop clock so the phone can rebase live timestamps and
      // avoid cross-device clock skew in the running/permission elapsed timer.
      apiClient
        .post("/api/v1/tray/state", { chats: Array.from(chats.values()), now: Date.now() })
        .catch(() => {});
    }, 400);
    return () => window.clearTimeout(id);
  }, [chats, platform.seedFromSnapshot]);

  // LocalStorage persistence: write the (already-pruned) chats to LS on every
  // change so the desktop tray recovers after a reload. Phone is excluded —
  // it seeds from the backend snapshot, and its webview is short-lived.
  // Pruning happens inside `setChatsPruned` above, not here, so we never
  // call setState inside an effect.
  useEffect(() => {
    if (platform.seedFromSnapshot) return;
    const id = window.setTimeout(() => {
      try {
        window.localStorage.setItem(
          TRAY_CHATS_LS_KEY,
          JSON.stringify({ chats: Array.from(chats.values()) }),
        );
      } catch {
        // Quota exceeded / private mode — silently skip. In-memory state is
        // still authoritative; the next mount will re-seed from the backend
        // mirror or an empty Map.
      }
    }, LS_WRITE_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [chats, platform.seedFromSnapshot]);

  useRadioEvents({
    onChatStatus: (
      projectId,
      taskId,
      chatId,
      status,
      payload?: ChatStatusEvent,
    ) => {
      setChatsPruned((prev) => {
        const ts = Date.now();
        const originalExisting = prev.get(chatId);
        const next = new Map(prev);

        const project_name =
          payload?.project_name ?? originalExisting?.project_name ?? projectId;
        const task_name = payload?.task_name ?? originalExisting?.task_name ?? taskId;
        const chat_title = payload?.chat_title ?? originalExisting?.chat_title ?? null;
        const agent = payload?.agent ?? originalExisting?.agent ?? null;

        // Keep existing as a const to allow TypeScript's type narrowing!
        const existing = originalExisting
          ? {
              ...originalExisting,
              chat_title,
              project_name,
              task_name,
              agent,
            }
          : undefined;

        if (originalExisting && existing) {
          const hasMetaChanges =
            originalExisting.chat_title !== chat_title ||
            originalExisting.project_name !== project_name ||
            originalExisting.task_name !== task_name ||
            originalExisting.agent !== agent;
          if (hasMetaChanges) {
            next.set(chatId, existing);
          }
        }

        switch (status) {
          case "busy": {
            // Backend re-emits chat_status on plan_update with status="busy",
            // so repeat busy events arrive mid-turn. Preserve running_started_at
            // for those repeats — only reset on a genuinely new turn.
            const isFreshTurn = !existing || existing.status === "done";
            next.set(chatId, {
              chat_id: chatId,
              project_id: projectId,
              task_id: taskId,
              project_name,
              task_name,
              chat_title,
              agent,
              status: "running",
              running_started_at: isFreshTurn
                ? ts
                : (existing.running_started_at ?? ts),
              entered_state_at: isFreshTurn ? ts : existing.entered_state_at,
              done_duration_ms: null,
              pending_options: null,
              pending_description: null,
              prompt: payload?.prompt ?? existing?.prompt ?? null,
              message: null,
              todo_completed:
                payload?.todo_completed ?? existing?.todo_completed ?? null,
              todo_total: payload?.todo_total ?? existing?.todo_total ?? null,
            });
            break;
          }
          case "permission_required": {
            const isFreshTurn = !existing || existing.status === "done";
            next.set(chatId, {
              chat_id: chatId,
              project_id: projectId,
              task_id: taskId,
              project_name,
              task_name,
              chat_title,
              agent,
              status: "permission",
              running_started_at: isFreshTurn
                ? ts
                : (existing.running_started_at ?? ts),
              entered_state_at: ts,
              done_duration_ms: null,
              pending_options: payload?.permission?.options ?? null,
              pending_description: payload?.permission?.description ?? null,
              prompt: isFreshTurn ? null : existing.prompt,
              message: null,
              todo_completed:
                payload?.todo_completed ?? existing?.todo_completed ?? null,
              todo_total: payload?.todo_total ?? existing?.todo_total ?? null,
            });
            break;
          }
          case "idle": {
            if (
              existing &&
              (existing.status === "running" || existing.status === "permission")
            ) {
              const startedAt = existing.running_started_at ?? existing.entered_state_at;
              next.set(chatId, {
                ...existing,
                status: "done",
                entered_state_at: ts,
                done_duration_ms: ts - startedAt,
                pending_options: null,
                pending_description: null,
                message: payload?.message ?? null,
                todo_completed:
                  payload?.todo_completed ?? existing.todo_completed,
                todo_total: payload?.todo_total ?? existing.todo_total,
              });
              const doneEntries = Array.from(next.entries()).filter(
                ([, v]) => v.status === "done",
              );
              if (doneEntries.length > 50) {
                doneEntries
                  .sort((a, b) => a[1].entered_state_at - b[1].entered_state_at)
                  .slice(0, doneEntries.length - 50)
                  .forEach(([k]) => next.delete(k));
              }
            }
            break;
          }
          case "disconnected": {
            next.delete(chatId);
            break;
          }
          case "connecting":
            break;
        }
        return next;
      });
    },
  });

  const permList = useMemo(
    () =>
      Array.from(chats.values())
        .filter((c) => c.status === "permission")
        .sort((a, b) => b.entered_state_at - a.entered_state_at),
    [chats],
  );
  const runList = useMemo(
    () =>
      Array.from(chats.values())
        .filter((c) => c.status === "running")
        .sort((a, b) => (a.running_started_at ?? 0) - (b.running_started_at ?? 0)),
    [chats],
  );
  const doneList = useMemo(
    () =>
      Array.from(chats.values())
        .filter((c) => c.status === "done")
        .sort((a, b) => b.entered_state_at - a.entered_state_at),
    [chats],
  );

  const showPerms = show.permission;
  const showRunning = show.running;
  const showDone = show.done;
  const totalRunning = showRunning
    ? Array.from(chats.values()).filter((c) => c.status === "running").length
    : 0;
  const totalPending = showPerms ? permList.length : 0;
  const totalDone = showDone ? doneList.length : 0;
  const totalAll = totalRunning + totalPending + totalDone;

  const dismiss = (chatId: string) =>
    setChatsPruned((prev) => {
      if (!prev.has(chatId)) return prev;
      const next = new Map(prev);
      next.delete(chatId);
      return next;
    });

  const clearDone = () =>
    setChatsPruned((prev) => {
      const next = new Map(prev);
      for (const [k, v] of prev) {
        if (v.status === "done") next.delete(k);
      }
      return next;
    });

  const handleResolve = (item: ChatItem, opt: PermissionOption) => {
    platform.resolvePermission(item, opt);
  };

  const handleOpenMain = platform.openMain;
  const pinning = platform.pinning;
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    if (!pinning) return;
    // Pin state isn't persisted across launches, but the popover webview
    // can outlive a single show/hide cycle — so we still ask the backend
    // for the current state on mount in case React re-mounts mid-session.
    pinning
      .isPinned()
      .then((v) => setPinned(!!v))
      .catch(() => {});
  }, [pinning]);
  const handleTogglePin = () => {
    if (!pinning) return;
    const next = !pinned;
    setPinned(next);
    pinning.setPinned(next);
  };
  // Imperative drag — `data-tauri-drag-region` doesn't fire reliably in this
  // webview, so we explicitly start a window drag on mousedown when pinned.
  // Buttons inside the header stop propagation via their own onClick, so the
  // drag handler only triggers on the empty / handle areas.
  const handleHeaderMouseDown = (e: React.MouseEvent<HTMLElement>) => {
    if (!pinning || !pinned) return;
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, a, input")) return;
    e.preventDefault();
    pinning.startDragging();
  };
  // Bottom-right resize grip — `decorations(false)` strips the system edge
  // handles, so we synthesize a corner grip and call into Tauri's
  // startResizeDragging("South-East") on mousedown.
  const handleResizeMouseDown = (e: React.MouseEvent<HTMLElement>) => {
    if (!pinning || !pinned) return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    pinning.startResize();
  };
  const handleOpenSettings = platform.openSettings;
  // Always callable so the cards don't need per-call guards; a no-op on hosts
  // (the phone page) that can't open a task in a full window.
  const handleOpenTask = (item: ChatItem) => platform.openTask?.(item);

  return (
    <div
      className={`relative flex h-full flex-col overflow-hidden bg-[var(--color-bg-secondary)] text-[var(--color-text)] border ${pinned ? "border-[var(--color-highlight)]" : "border-[color-mix(in_srgb,var(--color-border)_70%,transparent)]"}`}
    >
      {/* Header — when pinned, the title strip becomes the drag handle so
          the user can move the floating widget around the screen. */}
      <header
        className={`flex shrink-0 items-center gap-3 border-b border-[color-mix(in_srgb,var(--color-border)_35%,transparent)] px-4 pt-3.5 pb-3 ${pinned ? "cursor-grab active:cursor-grabbing select-none" : ""}`}
        onMouseDown={handleHeaderMouseDown}
        data-tauri-drag-region={pinned ? "" : undefined}
      >
        {pinned ? (
          <GripVertical
            size={14}
            className="-ml-1 shrink-0 text-[var(--color-text-muted)]"
            aria-label="Drag handle"
          />
        ) : null}
        <img
          src="/favicon.svg"
          alt="Grove"
          className="h-[20px] w-[20px] shrink-0"
          draggable={false}
          data-tauri-drag-region={pinned ? "" : undefined}
        />
        <div
          className="flex-1 leading-tight"
          data-tauri-drag-region={pinned ? "" : undefined}
        >
          <div className="text-[13px] font-semibold">Grove</div>
          <div className="font-mono text-[11px] text-[var(--color-text-muted)]">
            {totalPending > 0 ? (
              <>
                <span className="text-[var(--color-warning)] font-medium">
                  {totalPending} needs you
                </span>
                {totalRunning > 0 ? (
                  <>
                    {" · "}
                    <span className="text-[var(--color-highlight)]">{totalRunning} running</span>
                  </>
                ) : null}
              </>
            ) : totalRunning > 0 ? (
              <span className="text-[var(--color-highlight)]">{totalRunning} running</span>
            ) : (
              <span>idle</span>
            )}
          </div>
        </div>
        {platform.syncToPhone ? (
          <button
            onClick={platform.syncToPhone}
            className="flex h-7 w-7 items-center justify-center text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]"
            title="Sync to phone"
          >
            <Smartphone size={14} />
          </button>
        ) : null}
        {pinning ? (
          <button
            onClick={handleTogglePin}
            className={`flex h-7 w-7 items-center justify-center transition-colors hover:bg-[var(--color-bg-tertiary)] ${pinned ? "text-[var(--color-highlight)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}
            title={pinned ? "Unpin widget" : "Pin as widget (always on top)"}
          >
            {pinned ? <PinOff size={14} /> : <Pin size={14} />}
          </button>
        ) : null}
        {handleOpenMain ? (
          <button
            onClick={handleOpenMain}
            className="flex h-7 w-7 items-center justify-center text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]"
            title="Open Grove"
          >
            <ExternalLink size={14} />
          </button>
        ) : null}
        {handleOpenSettings ? (
          <button
            onClick={handleOpenSettings}
            className="flex h-7 w-7 items-center justify-center text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]"
            title="Settings"
          >
            <Settings size={14} />
          </button>
        ) : null}
      </header>

      {/* Stream — single vertical scroll, no horizontal, no nested scrolls.
          Each section is its own translucent panel with a chip header,
          inspired by the glass mockup but theme-friendly (works under any
          of Grove's 8 themes via color-mix on the existing tokens). */}
      <LayoutGroup>
        {/* `min-h-0` is load-bearing: without it a flex child's default
            `min-height: auto` lets the content size dominate, so a long
            Done list (24 rows) overflows the popover instead of scrolling,
            and multiple sections appear to "squeeze" each other off-screen
            instead of producing a single scroll region. */}
        <div className="flex flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden p-2 min-h-0">
          {totalAll === 0 ? (
            <EmptyState />
          ) : (
            <>
              {showPerms && permList.length > 0 ? (
                <Panel tone="warning" className="shrink-0">
                  <ChipHeader
                    tone="warning"
                    icon={<Zap size={11} />}
                    label="Needs you"
                    count={permList.length}
                  />
                  <div className="flex flex-col overflow-y-auto overflow-x-hidden max-h-[240px]">
                    {permList.map((c) => (
                      <PermissionCard
                        key={c.chat_id}
                        item={c}
                        now={now}
                        onResolve={(opt) => handleResolve(c, opt)}
                        onOpen={() => handleOpenTask(c)}
                      />
                    ))}
                  </div>
                </Panel>
              ) : null}

              {showRunning && runList.length > 0 ? (
                <Panel tone="highlight" className="shrink-0">
                  <ChipHeader
                    tone="highlight"
                    pulseDot
                    label="Running"
                    count={runList.length}
                  />
                  <div className="flex flex-col overflow-y-auto overflow-x-hidden max-h-[240px]">
                    {runList.map((c) => (
                      <RunningCard
                        key={c.chat_id}
                        item={c}
                        now={now}
                        onOpen={() => handleOpenTask(c)}
                      />
                    ))}
                  </div>
                </Panel>
              ) : null}

              {showDone && doneList.length > 0 ? (
                <Panel tone="muted" className="flex flex-col min-h-0 shrink">
                  <button
                    onClick={() => setRecentOpen((v) => !v)}
                    className="flex w-full items-center gap-1.5 px-2 pt-2 pb-1.5 text-left shrink-0"
                  >
                    <ChevronDown
                      size={11}
                      className="text-[var(--color-text-muted)] transition-transform"
                      style={{ transform: recentOpen ? "rotate(0deg)" : "rotate(-90deg)" }}
                    />
                    <ChipBadge tone="muted">
                      Done · {doneList.length}
                    </ChipBadge>
                    <span className="flex-1" />
                    {recentOpen ? (
                      <span
                        onClick={(e) => {
                          e.stopPropagation();
                          clearDone();
                        }}
                        className="text-[10px] font-medium uppercase tracking-[0.6px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                      >
                        Clear all
                      </span>
                    ) : null}
                  </button>
                  <AnimatePresence initial={false}>
                    {recentOpen ? (
                      <motion.div
                        key="recent-body"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
                        className="overflow-hidden flex-1 min-h-0 flex flex-col"
                      >
                        <div className="flex flex-col overflow-y-auto overflow-x-hidden max-h-[240px] flex-1 min-h-0">
                          {doneList.map((c) => (
                            <DoneRow
                              key={c.chat_id}
                              item={c}
                              onOpen={platform.openTask ? () => handleOpenTask(c) : undefined}
                              onDismiss={() => dismiss(c.chat_id)}
                              onReply={platform.sendPrompt ? () => setReplyTarget(c) : undefined}
                            />
                          ))}
                        </div>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </Panel>
              ) : null}
            </>
          )}
        </div>
      </LayoutGroup>
      {pinned ? (
        <div
          onMouseDown={handleResizeMouseDown}
          title="Drag to resize"
          aria-label="Resize widget"
          className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
          style={{
            backgroundImage:
              "linear-gradient(135deg, transparent 0 55%, var(--color-text-muted) 55% 62%, transparent 62% 75%, var(--color-text-muted) 75% 82%, transparent 82%)",
          }}
        />
      ) : null}

      {(() => {
        // Render-derived so a dropped chat (disconnected / dismissed) closes the
        // view without a set-state-in-effect. Show the live entry so a new
        // response updates it, keeping the last non-null response while the chat
        // is busy (running → message null).
        if (!replyTarget || !platform.sendPrompt) return null;
        const live = chats.get(replyTarget.chat_id);
        if (!live) return null;
        const item = { ...live, message: live.message ?? replyTarget.message };
        return (
          <ReplyView
            item={item}
            enableVoice={platform.enableVoice}
            onSend={(text) => platform.sendPrompt!(item, text)}
            onClose={() => setReplyTarget(null)}
            onOpen={platform.openTask ? () => platform.openTask!(item) : undefined}
            onHeaderMouseDown={handleHeaderMouseDown}
            headerDragCursor={pinned ? "cursor-grab active:cursor-grabbing select-none" : ""}
            headerDragRegion={pinned}
          />
        );
      })()}
    </div>
  );
}

// ─── Reply view (focused follow-up for a Done chat) ───────────────────────────
// Overlays the list with one scroll region (the full agent response) and a
// pinned composer, so the input is always reachable — unlike the old inline
// expansion that nested a scroll area inside the capped Done list.

function ReplyView({
  item,
  enableVoice,
  onSend,
  onClose,
  onOpen,
  onHeaderMouseDown,
  headerDragCursor,
  headerDragRegion,
}: {
  item: ChatItem;
  enableVoice?: boolean;
  onSend: (text: string) => Promise<void>;
  onClose: () => void;
  onOpen?: () => void;
  onHeaderMouseDown?: (e: React.MouseEvent<HTMLElement>) => void;
  headerDragCursor?: string;
  headerDragRegion?: boolean;
}) {
  const title = item.chat_title || item.task_name;
  const provenance = provenanceOf(item);
  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-[var(--color-bg-secondary)]">
      <header
        className={`flex shrink-0 items-center gap-2 border-b border-[color-mix(in_srgb,var(--color-border)_35%,transparent)] px-2 py-2 ${headerDragCursor ?? ""}`}
        onMouseDown={onHeaderMouseDown}
        data-tauri-drag-region={headerDragRegion ? "" : undefined}
      >
        <button
          onClick={onClose}
          title="Back"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]"
        >
          <ChevronLeft size={16} />
        </button>
        <AgentBadge agent={item.agent} tone="muted" size={20} />
        <div className="min-w-0 flex-1">
          <div
            className="overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] font-semibold text-[var(--color-text)]"
            title={title}
          >
            {title}
          </div>
          <div
            className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[10px] text-[var(--color-text-muted)]"
            title={provenance}
          >
            {provenance}
          </div>
        </div>
        {onOpen ? (
          <button
            onClick={onOpen}
            title="Open in app"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]"
          >
            <ExternalLink size={14} />
          </button>
        ) : null}
      </header>
      <div className="flex-1 overflow-y-auto px-3 py-2.5 text-[12.5px] leading-relaxed text-[var(--color-text)]">
        {item.message ? (
          <MarkdownRenderer content={item.message} />
        ) : (
          <span className="italic text-[var(--color-text-muted)]">
            No text response captured for this turn.
          </span>
        )}
      </div>
      <div className="shrink-0 border-t border-[color-mix(in_srgb,var(--color-border)_35%,transparent)]">
        <TrayComposer
          projectId={item.project_id}
          enableVoice={enableVoice}
          onSend={onSend}
          autoFocus
        />
      </div>
    </div>
  );
}

// ─── Panel + chip header (glass-feel section container) ───────────────────

type Tone = "warning" | "highlight" | "muted";

const TONE_VAR: Record<Tone, string> = {
  warning: "var(--color-warning)",
  highlight: "var(--color-highlight)",
  muted: "var(--color-text-muted)",
};

function Panel({
  tone,
  className,
  children,
}: {
  tone: Tone;
  className?: string;
  children: React.ReactNode;
}) {
  // Translucent panel: sits on the popover's bg-secondary base. Subtle
  // tone-tinted hairline border + soft inner background gives the
  // "glass card" silhouette without depending on backdrop-filter (which
  // doesn't show through Tauri's default opaque window).
  const accent = TONE_VAR[tone];
  return (
    <div
      className={`overflow-hidden border ${className || ""}`}
      style={{
        background: `color-mix(in srgb, ${accent} 4%, var(--color-bg-tertiary))`,
        borderColor: `color-mix(in srgb, ${accent} 22%, var(--color-border))`,
        borderRadius: 8,
      }}
    >
      {children}
    </div>
  );
}

function ChipBadge({
  tone,
  children,
}: {
  tone: Tone;
  children: React.ReactNode;
}) {
  const accent = TONE_VAR[tone];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.7px]"
      style={{
        color: accent,
        background: `color-mix(in srgb, ${accent} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${accent} 28%, transparent)`,
      }}
    >
      {children}
    </span>
  );
}

interface ChipHeaderProps {
  tone: Tone;
  label: string;
  count: number;
  icon?: React.ReactNode;
  pulseDot?: boolean;
}

function ChipHeader({ tone, label, count, icon, pulseDot }: ChipHeaderProps) {
  const accent = TONE_VAR[tone];
  return (
    <div className="px-2 pt-2 pb-1.5">
      <ChipBadge tone={tone}>
        {icon ? (
          icon
        ) : pulseDot ? (
          <span
            className="h-[6px] w-[6px] animate-pulse"
            style={{
              background: accent,
              borderRadius: 999,
              boxShadow: `0 0 6px color-mix(in srgb, ${accent} 60%, transparent)`,
            }}
          />
        ) : null}
        <span>
          {label} · {count}
        </span>
      </ChipBadge>
    </div>
  );
}

// ─── Agent badge ───────────────────────────────────────────────────────────

function AgentBadge({
  agent,
  tone,
  size = 22,
}: {
  agent: string | null;
  tone: "warning" | "highlight" | "muted";
  size?: number;
}) {
  const meta = resolveAgent(agent);
  const Icon = meta?.icon ?? null;
  const bg =
    tone === "warning"
      ? "color-mix(in srgb, var(--color-warning) 16%, transparent)"
      : tone === "highlight"
        ? "color-mix(in srgb, var(--color-highlight) 16%, transparent)"
        : "color-mix(in srgb, var(--color-text) 7%, transparent)";
  return (
    <span
      className="flex shrink-0 items-center justify-center"
      style={{ width: size, height: size, background: bg, borderRadius: 4 }}
    >
      {Icon ? (
        <Icon size={Math.round(size * 0.62)} />
      ) : agent ? (
        // Fall back to the unified util when the static catalog row is
        // absent (e.g. traex, openclaw, synthetic marketplace agents).
        // createElement avoids `react-hooks/static-components` flagging
        // the dynamically-resolved component; agentIconComponent returns
        // stable refs (bundled icons + per-url-cached image wrappers).
        createElement(agentIconComponent(agent), { size: Math.round(size * 0.62) })
      ) : (
        <span className="text-[10px] text-[var(--color-text-muted)]">
          {(Array.from(agent || "?")[0] ?? "?").toUpperCase()}
        </span>
      )}
    </span>
  );
}

// ─── Permission card (NEEDS YOU) ───────────────────────────────────────────

const CARD_MORPH = { type: "spring" as const, stiffness: 380, damping: 32 };

function PermissionCard({
  item,
  now,
  onResolve,
  onOpen,
}: {
  item: ChatItem;
  now: number;
  onResolve: (opt: PermissionOption) => void;
  onOpen: () => void;
}) {
  const title = item.chat_title || item.task_name;
  const provenance = provenanceOf(item);
  const elapsed =
    item.running_started_at != null ? formatDuration(now - item.running_started_at) : null;
  const desc = oneLine(item.pending_description, 140);
  const opts = item.pending_options ? orderOptions(item.pending_options) : [];
  const primary = opts[0];
  const secondary = opts.slice(1);

  return (
    <motion.div
      layout
      transition={CARD_MORPH}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="cursor-pointer border-t border-[color-mix(in_srgb,var(--color-warning)_18%,transparent)] px-3 py-2 first:border-t-0 hover:bg-[color-mix(in_srgb,var(--color-warning)_6%,transparent)]"
    >
      {/* Row 1: agent · title · elapsed */}
      <div className="flex items-center gap-2.5">
        <AgentBadge agent={item.agent} tone="warning" />
        <div className="min-w-0 flex-1">
          <div
            className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-semibold"
            title={title}
          >
            {title}
          </div>
          <div
            className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[10.5px] text-[var(--color-text-muted)]"
            title={provenance}
          >
            {provenance}
          </div>
        </div>
        {elapsed ? (
          <span className="shrink-0 font-mono text-[10.5px] text-[var(--color-text-muted)]">
            {elapsed}
          </span>
        ) : null}
      </div>

      {/* Row 2: single-line description */}
      {desc ? (
        <div
          className="mt-1.5 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-[var(--color-text)]"
          title={item.pending_description ?? undefined}
        >
          {desc}
        </div>
      ) : null}

      {/* Row 3: action buttons — adaptive layout.
          Primary always own row (CTA gets full width). Secondaries use
          flex-wrap with `flex: 1 1 110px` + max-w-full so:
            • short labels pack horizontally (2-3 per row)
            • long labels (e.g. "Always Allow Read(/very/long/path)")
              naturally fill the row alone and ellipsise.
          No horizontal scroll, no fixed-count cap, no nested scroll. */}
      {opts.length > 0 ? (
        <div className="mt-2 flex flex-col gap-1">
          {primary ? (
            <button
              onClick={(e) => { e.stopPropagation(); onResolve(primary); }}
              title={primary.name}
              className="h-7 w-full px-3 text-[11.5px] font-medium bg-[var(--color-highlight)] text-white hover:opacity-90 transition-opacity"
            >
              {labelFor(primary)}
            </button>
          ) : null}
          {secondary.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {secondary.map((opt) => {
                const isAllow = opt.kind.startsWith("allow");
                return (
                  <button
                    key={opt.option_id}
                    onClick={(e) => { e.stopPropagation(); onResolve(opt); }}
                    title={opt.name}
                    className={
                      "h-7 min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap px-3 text-[11.5px] border text-center transition-colors " +
                      (isAllow
                        ? "text-[var(--color-text)] border-[var(--color-border)] hover:bg-[var(--color-bg-tertiary)]"
                        : "text-[var(--color-error)] border-[color-mix(in_srgb,var(--color-error)_35%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-error)_10%,transparent)]")
                    }
                    style={{ flex: "1 1 110px" }}
                  >
                    {labelFor(opt)}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-2 flex justify-end">
          <button
            onClick={(e) => { e.stopPropagation(); onOpen(); }}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-[11px] font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
          >
            Open <ExternalLink size={11} />
          </button>
        </div>
      )}
    </motion.div>
  );
}

// ─── Running card ──────────────────────────────────────────────────────────

function RunningCard({
  item,
  now,
  onOpen,
}: {
  item: ChatItem;
  now: number;
  onOpen: () => void;
}) {
  const title = item.chat_title || item.task_name;
  const provenance = provenanceOf(item);
  const elapsed =
    item.running_started_at != null ? formatDuration(now - item.running_started_at) : null;
  const prompt = oneLine(item.prompt, 140);

  return (
    <motion.div
      layout
      transition={CARD_MORPH}
      onClick={onOpen}
      className="group relative cursor-pointer px-2.5 py-2 transition-colors hover:bg-[color-mix(in_srgb,var(--color-text)_4%,transparent)]"
    >
      <div className="flex items-center gap-2.5">
        <AgentBadge agent={item.agent} tone="highlight" />
        <div className="min-w-0 flex-1">
          <div
            className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-semibold"
            title={title}
          >
            {title}
          </div>
          <div className="flex items-center gap-1.5 font-mono text-[10.5px] text-[var(--color-text-muted)]">
            <span
              className="overflow-hidden text-ellipsis whitespace-nowrap"
              title={provenance}
            >
              {provenance}
            </span>
          </div>
        </div>
        {elapsed ? (
          <span className="shrink-0 font-mono text-[10.5px] text-[var(--color-highlight)]">
            {elapsed}
          </span>
        ) : null}
      </div>
      {prompt ? (
        <div
          className="mt-1 ml-[32px] overflow-hidden text-ellipsis whitespace-nowrap text-[11.5px] text-[var(--color-text-muted)]"
          title={item.prompt ?? undefined}
        >
          {prompt}
        </div>
      ) : null}
      {/* Progress strip — real plan progress when the agent emits a TodoWrite
          plan; otherwise fall back to the pulse strip ("still working" without
          a false ETA). */}
      {item.todo_total != null && item.todo_total > 0 ? (
        (() => {
          const pct = Math.min(
            100,
            Math.round(((item.todo_completed ?? 0) / item.todo_total) * 100),
          );
          return (
            <div
              className="mt-1.5 flex items-center gap-2"
              title={`Todo ${item.todo_completed ?? 0}/${item.todo_total}`}
            >
              <div className="relative h-[2px] flex-1 overflow-hidden bg-[color-mix(in_srgb,var(--color-highlight)_15%,transparent)]">
                {/* Filled segment — solid, left-aligned. */}
                <div
                  className="absolute left-0 top-0 h-full bg-[var(--color-highlight)] transition-[width] duration-300"
                  style={{ width: `${pct}%` }}
                />
                {/* Pulse on the remaining section so the user can tell the
                    agent is still working between todo completions. */}
                {pct < 100 ? (
                  <div
                    className="absolute top-0 h-full overflow-hidden"
                    style={{ left: `${pct}%`, right: 0 }}
                  >
                    <div className="h-full w-1/3 animate-[trayRunPulse_1.6s_ease-in-out_infinite] bg-[var(--color-highlight)]" />
                  </div>
                ) : null}
              </div>
              <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">
                {item.todo_completed ?? 0}/{item.todo_total}
              </span>
            </div>
          );
        })()
      ) : (
        <div className="mt-1.5 h-[2px] w-full overflow-hidden bg-[color-mix(in_srgb,var(--color-highlight)_15%,transparent)]">
          <div className="h-full w-1/3 animate-[trayRunPulse_1.6s_ease-in-out_infinite] bg-[var(--color-highlight)]" />
        </div>
      )}
    </motion.div>
  );
}

// ─── Done row (RECENT) ─────────────────────────────────────────────────────

function DoneRow({
  item,
  onOpen,
  onDismiss,
  onReply,
}: {
  item: ChatItem;
  onOpen?: () => void;
  onDismiss: () => void;
  /** Open the focused reply view. When set, tapping the row replies; else opens. */
  onReply?: () => void;
}) {
  const title = item.chat_title || item.task_name;
  const provenance = provenanceOf(item);
  const dur = item.done_duration_ms != null ? formatDuration(item.done_duration_ms) : null;
  // The agent's final reply for this turn (carried on the idle ChatStatus
  // event). Shown as the secondary line so the user can see what the model
  // said without opening the task; falls back to provenance when absent.
  const respPreview = oneLine(item.message, 90);

  // Tapping replies (focused view) when this host can send prompts; otherwise
  // it falls back to opening the task in the full app (desktop without reply).
  const handleRowClick = () => {
    if (onReply) onReply();
    else onOpen?.();
  };

  return (
    <motion.div
      layout
      transition={CARD_MORPH}
      className="group relative flex flex-col"
    >
      <div
        onClick={handleRowClick}
        className="flex h-[40px] cursor-pointer items-center gap-2.5 px-3 transition-colors hover:bg-[color-mix(in_srgb,var(--color-text)_4%,transparent)]"
      >
        <AgentBadge agent={item.agent} tone="muted" size={18} />
        <div className="min-w-0 flex-1">
          <div
            className="overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] text-[var(--color-text)]"
            title={title}
          >
            {title}
          </div>
          {respPreview ? (
            <div
              className="overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-[var(--color-text-muted)]"
              title={item.message ?? undefined}
            >
              {respPreview}
            </div>
          ) : (
            <div
              className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[10px] text-[var(--color-text-muted)]"
              title={provenance}
            >
              {provenance}
            </div>
          )}
        </div>
        {dur ? (
          <span className="shrink-0 font-mono text-[10.5px] text-[var(--color-text-muted)] group-hover:hidden">
            {dur}
          </span>
        ) : null}
        {onOpen ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
            className="hidden h-5 w-5 shrink-0 items-center justify-center text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)] group-hover:flex"
            title="Open in app"
          >
            <ExternalLink size={12} />
          </button>
        ) : null}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          className="hidden h-5 w-5 shrink-0 items-center justify-center text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)] group-hover:flex"
          title="Dismiss"
        >
          <X size={12} />
        </button>
      </div>
    </motion.div>
  );
}

// ─── Empty ────────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 py-16 text-center text-[var(--color-text-muted)]">
      <div
        className="mb-3 flex h-9 w-9 items-center justify-center"
        style={{
          background: "color-mix(in srgb, var(--color-highlight) 12%, transparent)",
          color: "var(--color-highlight)",
        }}
      >
        <span className="text-lg leading-none">✓</span>
      </div>
      <div className="mb-1 text-[13px] font-medium text-[var(--color-text)]">All clear</div>
      <div className="text-[11.5px]">No active sessions, permissions, or recent events.</div>
    </div>
  );
}
