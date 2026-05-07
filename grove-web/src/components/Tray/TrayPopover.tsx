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

import { useEffect, useMemo, useState } from "react";
import { motion, LayoutGroup, AnimatePresence } from "framer-motion";
import { Settings, ExternalLink, ChevronDown, X, Zap, Pin, PinOff, GripVertical } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useRadioEvents } from "../../hooks/useRadioEvents";
import { agentOptions } from "../../data/agents";
import type { RadioEvent } from "../../api/walkieTalkie";

// ─── Types ──────────────────────────────────────────────────────────────────

interface PermissionOption {
  option_id: string;
  name: string;
  /** "allow_once" | "allow_always" | "reject_once" | "reject_always" */
  kind: string;
}

type ChatStatusKind = "running" | "permission" | "done";

interface ChatItem {
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
}

type ChatStatusEvent = Extract<RadioEvent, { type: "chat_status" }>;

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
      const tc = a.terminalCheck?.toLowerCase();
      const ac = a.acpCheck?.toLowerCase();
      return id === lower || value === lower || tc === lower || ac === lower;
    }) ?? null
  );
}

/** Clean, predictable label per ACP `kind`. ACP `name` fields are often
 *  function-call dumps (e.g. `Always Allow all mcp__grove__grove_reply_review`)
 *  which look terrible as button labels. Falls back to `name` for unknown
 *  kinds. */
function labelFor(opt: PermissionOption): string {
  switch (opt.kind) {
    case "allow_once":
      return "Allow";
    case "allow_always":
      return "Always allow";
    case "reject_once":
      return "Reject";
    case "reject_always":
      return "Always reject";
    default:
      return opt.name.replace(/\s+/g, " ").trim();
  }
}

function orderOptions(opts: PermissionOption[]): PermissionOption[] {
  const rank = (k: string): number => {
    if (k === "allow_once") return 0;
    if (k.startsWith("allow")) return 1;
    if (k === "reject_once") return 2;
    if (k.startsWith("reject")) return 3;
    return 4;
  };
  return [...opts].sort((a, b) => rank(a.kind) - rank(b.kind));
}

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

interface TrayShowConfig {
  permission: boolean;
  running: boolean;
  done: boolean;
}

const DEFAULT_SHOW: TrayShowConfig = { permission: true, running: true, done: true };

// ─── Component ──────────────────────────────────────────────────────────────

export function TrayPopover() {
  const [chats, setChats] = useState<Map<string, ChatItem>>(() => new Map());
  const [now, setNow] = useState(() => Date.now());
  const [show, setShow] = useState<TrayShowConfig>(DEFAULT_SHOW);
  const [recentOpen, setRecentOpen] = useState(true);

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
    let cancelled = false;
    const reload = async () => {
      let res: Response;
      try {
        res = await fetch("/api/v1/config");
      } catch {
        return;
      }
      if (!res.ok) {
        console.error("[TrayPopover] Failed to fetch config:", res.status);
        return;
      }
      let cfg: { notifications?: { tray_show_permission?: unknown; tray_show_running?: unknown; tray_show_done?: unknown } };
      try {
        cfg = await res.json();
      } catch {
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
  }, []);

  useRadioEvents({
    onChatStatus: (
      projectId,
      taskId,
      chatId,
      status,
      payload?: ChatStatusEvent,
    ) => {
      setChats((prev) => {
        const ts = Date.now();
        const existing = prev.get(chatId);
        const next = new Map(prev);

        const project_name =
          payload?.project_name ?? existing?.project_name ?? projectId;
        const task_name = payload?.task_name ?? existing?.task_name ?? taskId;
        const chat_title = payload?.chat_title ?? existing?.chat_title ?? null;
        const agent = payload?.agent ?? existing?.agent ?? null;

        switch (status) {
          case "busy": {
            next.set(chatId, {
              chat_id: chatId,
              project_id: projectId,
              task_id: taskId,
              project_name,
              task_name,
              chat_title,
              agent,
              status: "running",
              running_started_at: ts,
              entered_state_at: ts,
              done_duration_ms: null,
              pending_options: null,
              pending_description: null,
              prompt: payload?.prompt ?? existing?.prompt ?? null,
              message: null,
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
    setChats((prev) => {
      if (!prev.has(chatId)) return prev;
      const next = new Map(prev);
      next.delete(chatId);
      return next;
    });

  const clearDone = () =>
    setChats((prev) => {
      const next = new Map(prev);
      for (const [k, v] of prev) {
        if (v.status === "done") next.delete(k);
      }
      return next;
    });

  const handleResolve = async (item: ChatItem, opt: PermissionOption) => {
    try {
      await invoke("tray_resolve_permission", {
        projectId: item.project_id,
        taskId: item.task_id,
        chatId: item.chat_id,
        optionId: opt.option_id,
      });
    } catch (e) {
      console.error("[tray] resolve failed", e);
    }
  };

  const handleOpenMain = () => {
    invoke("tray_open_main").catch((e) => console.error("[tray] open_main failed", e));
  };
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    // Pin state isn't persisted across launches, but the popover webview
    // can outlive a single show/hide cycle — so we still ask the backend
    // for the current state on mount in case React re-mounts mid-session.
    invoke<boolean>("tray_is_pinned")
      .then((v) => setPinned(!!v))
      .catch(() => {});
  }, []);
  const handleTogglePin = () => {
    const next = !pinned;
    setPinned(next);
    invoke("tray_set_pinned", { pinned: next }).catch((e) => {
      console.error("[tray] set_pinned failed", e);
      setPinned(!next);
    });
  };
  // Imperative drag — `data-tauri-drag-region` doesn't fire reliably in this
  // webview, so we explicitly start a window drag on mousedown when pinned.
  // Buttons inside the header stop propagation via their own onClick, so the
  // drag handler only triggers on the empty / handle areas.
  const handleHeaderMouseDown = (e: React.MouseEvent<HTMLElement>) => {
    if (!pinned) return;
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, a, input")) return;
    e.preventDefault();
    getCurrentWindow()
      .startDragging()
      .catch((err) => console.error("[tray] startDragging failed", err));
  };
  // Bottom-right resize grip — `decorations(false)` strips the system edge
  // handles, so we synthesize a corner grip and call into Tauri's
  // startResizeDragging("South-East") on mousedown.
  const handleResizeMouseDown = (e: React.MouseEvent<HTMLElement>) => {
    if (!pinned) return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    getCurrentWindow()
      .startResizeDragging("SouthEast")
      .catch((err) => console.error("[tray] startResizeDragging failed", err));
  };
  const handleOpenSettings = () => {
    invoke("tray_open_settings").catch((e) =>
      console.error("[tray] open_settings failed", e),
    );
  };
  const handleOpenTask = (item: ChatItem) => {
    invoke("tray_open_task", {
      projectId: item.project_id,
      taskId: item.task_id,
      chatId: item.chat_id,
    }).catch((e) => console.error("[tray] open_task failed", e));
  };

  return (
    <div
      className={`relative flex h-screen flex-col overflow-hidden bg-[var(--color-bg-secondary)] text-[var(--color-text)] border ${pinned ? "border-[var(--color-highlight)]" : "border-[color-mix(in_srgb,var(--color-border)_70%,transparent)]"}`}
    >
      {/* Header — when pinned, the title strip becomes the drag handle so
          the user can move the floating widget around the screen. */}
      <header
        className={`flex items-center gap-3 border-b border-[color-mix(in_srgb,var(--color-border)_35%,transparent)] px-4 pt-3.5 pb-3 ${pinned ? "cursor-grab active:cursor-grabbing select-none" : ""}`}
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
        <button
          onClick={handleTogglePin}
          className={`flex h-7 w-7 items-center justify-center transition-colors hover:bg-[var(--color-bg-tertiary)] ${pinned ? "text-[var(--color-highlight)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}
          title={pinned ? "Unpin widget" : "Pin as widget (always on top)"}
        >
          {pinned ? <PinOff size={14} /> : <Pin size={14} />}
        </button>
        <button
          onClick={handleOpenMain}
          className="flex h-7 w-7 items-center justify-center text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]"
          title="Open Grove"
        >
          <ExternalLink size={14} />
        </button>
        <button
          onClick={handleOpenSettings}
          className="flex h-7 w-7 items-center justify-center text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]"
          title="Settings"
        >
          <Settings size={14} />
        </button>
      </header>

      {/* Stream — single vertical scroll, no horizontal, no nested scrolls.
          Each section is its own translucent panel with a chip header,
          inspired by the glass mockup but theme-friendly (works under any
          of Grove's 8 themes via color-mix on the existing tokens). */}
      <LayoutGroup>
        <div className="flex flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden p-2">
          {totalAll === 0 ? (
            <EmptyState />
          ) : (
            <>
              {showPerms && permList.length > 0 ? (
                <Panel tone="warning">
                  <ChipHeader
                    tone="warning"
                    icon={<Zap size={11} />}
                    label="Needs you"
                    count={permList.length}
                  />
                  <div className="flex flex-col">
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
                <Panel tone="highlight">
                  <ChipHeader
                    tone="highlight"
                    pulseDot
                    label="Running"
                    count={runList.length}
                  />
                  <div className="flex flex-col">
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
                <Panel tone="muted">
                  <button
                    onClick={() => setRecentOpen((v) => !v)}
                    className="flex w-full items-center gap-1.5 px-2 pt-2 pb-1.5 text-left"
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
                        className="overflow-hidden"
                      >
                        <div className="flex flex-col">
                          {doneList.map((c) => (
                            <DoneRow
                              key={c.chat_id}
                              item={c}
                              onOpen={() => handleOpenTask(c)}
                              onDismiss={() => dismiss(c.chat_id)}
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

function Panel({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  // Translucent panel: sits on the popover's bg-secondary base. Subtle
  // tone-tinted hairline border + soft inner background gives the
  // "glass card" silhouette without depending on backdrop-filter (which
  // doesn't show through Tauri's default opaque window).
  const accent = TONE_VAR[tone];
  return (
    <div
      className="overflow-hidden border"
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
      ) : (
        <span className="text-[10px] text-[var(--color-text-muted)]">
          {(agent || "?")[0].toUpperCase()}
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
      className="cursor-pointer overflow-hidden border-t border-[color-mix(in_srgb,var(--color-warning)_18%,transparent)] px-3 py-2 first:border-t-0 hover:bg-[color-mix(in_srgb,var(--color-warning)_6%,transparent)]"
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
      className="group relative cursor-pointer overflow-hidden px-2.5 py-2 transition-colors hover:bg-[color-mix(in_srgb,var(--color-text)_4%,transparent)]"
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
      {/* Pulse strip — indicates "still working" without false ETA */}
      <div className="mt-1.5 h-[2px] w-full overflow-hidden bg-[color-mix(in_srgb,var(--color-highlight)_15%,transparent)]">
        <div className="h-full w-1/3 animate-[trayRunPulse_1.6s_ease-in-out_infinite] bg-[var(--color-highlight)]" />
      </div>
    </motion.div>
  );
}

// ─── Done row (RECENT) ─────────────────────────────────────────────────────

function DoneRow({
  item,
  onOpen,
  onDismiss,
}: {
  item: ChatItem;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const title = item.chat_title || item.task_name;
  const provenance = provenanceOf(item);
  const dur = item.done_duration_ms != null ? formatDuration(item.done_duration_ms) : null;

  return (
    <motion.div
      layout
      transition={CARD_MORPH}
      onClick={onOpen}
      className="group relative flex h-[40px] cursor-pointer items-center gap-2.5 px-3 transition-colors hover:bg-[color-mix(in_srgb,var(--color-text)_4%,transparent)]"
    >
      <AgentBadge agent={item.agent} tone="muted" size={18} />
      <div className="min-w-0 flex-1">
        <div
          className="overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] text-[var(--color-text)]"
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
      {dur ? (
        <span className="shrink-0 font-mono text-[10.5px] text-[var(--color-text-muted)] group-hover:hidden">
          {dur}
        </span>
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
