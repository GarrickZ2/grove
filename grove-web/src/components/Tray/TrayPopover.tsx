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
 */

import { useEffect, useMemo, useState } from "react";
import { motion, LayoutGroup, AnimatePresence } from "framer-motion";
import { Settings, ExternalLink } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
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
  /** When this chat last entered Running. RESET on every busy=true.
   *  Permission inherits this (no reset). Done freezes against this. */
  running_started_at: number | null;
  /** When this chat last transitioned to its current state (for the
   *  card's right-side absolute timestamp). */
  entered_state_at: number;
  /** Frozen duration in ms — only set when status==="done". */
  done_duration_ms: number | null;
  /** Permission details — only set when status==="permission". */
  pending_options: PermissionOption[] | null;
  pending_description: string | null;
  /** User prompt for the current/most-recent turn (Running display). */
  prompt: string | null;
  /** Final assistant message for the just-completed turn (Done display). */
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
  return `${h}h ${m % 60}m ${String(r).padStart(2, "0")}s`;
}

function resolveAgent(agent: string | null) {
  if (!agent) return null;
  const lower = agent.toLowerCase();
  return (
    agentOptions.find((a) => {
      // Lowercase both sides — the catalog currently uses lowercase IDs
      // but a future entry like "ClaudeCode" shouldn't silently break the
      // tray's icon resolution.
      const id = a.id.toLowerCase();
      const value = a.value.toLowerCase();
      const tc = a.terminalCheck?.toLowerCase();
      const ac = a.acpCheck?.toLowerCase();
      return id === lower || value === lower || tc === lower || ac === lower;
    }) ?? null
  );
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

  // Live ticker — only ticks while there's actually a Running or Permission
  // chat (their elapsed time is live). When the popover only contains Done
  // rows (frozen durations) the interval would re-render the whole list every
  // second for nothing.
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

  // Read tray show toggles from main config.
  useEffect(() => {
    let cancelled = false;
    const reload = async () => {
      try {
        const res = await fetch("/api/v1/config");
        if (!res.ok) {
          console.error("[TrayPopover] Failed to fetch config:", res.status);
          return;
        }
        const cfg = await res.json();
        if (cancelled || !cfg.notifications) return;
        setShow({
          permission: !!cfg.notifications.tray_show_permission,
          running: !!cfg.notifications.tray_show_running,
          done: !!cfg.notifications.tray_show_done,
        });
      } catch {
        /* noop */
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
  }, []);

  // Subscribe to chat_status events on the existing radio WS. State
  // machine described at the top of the file.
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
            // RESET running_started_at on every transition into Running.
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
            // Inherit running_started_at from the in-flight Running /
            // Permission turn so the timer doesn't reset mid-turn. If the
            // prior state was Done (a stale completion from an earlier
            // turn), OR there's no prior state at all, this is a fresh
            // turn — start the timer from `ts`, not from hours ago.
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
            // Promote to Done only if we observed prior work — prevents
            // an early "idle" right after connect from creating noise.
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
              // Cap Done rows at 50 (FIFO by entered_state_at) so long
              // sessions don't grow the Map indefinitely.
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
  // totalRunning always reflects actual agent state regardless of show/hide filters
  const totalRunning = Array.from(chats.values()).filter((c) => c.status === "running").length;
  const totalPending = showPerms ? permList.length : 0;
  const totalAll = totalRunning + totalPending + (showDone ? doneList.length : 0);

  const dismiss = (chatId: string) =>
    setChats((prev) => {
      if (!prev.has(chatId)) return prev;
      const next = new Map(prev);
      next.delete(chatId);
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
    <div className="flex h-screen flex-col overflow-hidden bg-[var(--color-bg-secondary)] text-[var(--color-text)] border border-[color-mix(in_srgb,var(--color-border)_70%,transparent)]">
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-[color-mix(in_srgb,var(--color-border)_35%,transparent)] px-4 pt-3.5 pb-3">
        <img
          src="/favicon.svg"
          alt="Grove"
          className="h-[20px] w-[20px] shrink-0"
          draggable={false}
        />
        <div className="flex-1 leading-tight">
          <div className="text-[13px] font-semibold">Grove</div>
          <div className="font-mono text-[11px] text-[var(--color-text-muted)]">
            <b className="font-medium text-[var(--color-highlight)]">{totalRunning}</b> running
            {totalPending > 0 ? (
              <>
                {" · "}
                <span className="text-[var(--color-warning)]">{totalPending} pending</span>
              </>
            ) : null}
          </div>
        </div>
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

      {/* Stream */}
      <LayoutGroup>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {totalAll === 0 ? (
            <EmptyState />
          ) : (
            <>
              {showPerms &&
                permList.map((c) => (
                  <ChatRow
                    key={c.chat_id}
                    item={c}
                    now={now}
                    onResolve={(opt) => handleResolve(c, opt)}
                    onOpen={() => handleOpenTask(c)}
                    onDismiss={() => dismiss(c.chat_id)}
                  />
                ))}
              {showRunning &&
                runList.map((c) => (
                  <ChatRow
                    key={c.chat_id}
                    item={c}
                    now={now}
                    onOpen={() => handleOpenTask(c)}
                    onDismiss={() => dismiss(c.chat_id)}
                  />
                ))}
              {showDone &&
                doneList.map((c) => (
                  <ChatRow
                    key={c.chat_id}
                    item={c}
                    now={now}
                    onOpen={() => handleOpenTask(c)}
                    onDismiss={() => dismiss(c.chat_id)}
                  />
                ))}
            </>
          )}
        </div>
      </LayoutGroup>
    </div>
  );
}

// ─── ChatRow ─────────────────────────────────────────────────────────────────

const CARD_MORPH = { type: "spring" as const, stiffness: 380, damping: 32 };

interface RowProps {
  item: ChatItem;
  now: number;
  onResolve?: (opt: PermissionOption) => void;
  onOpen: () => void;
  onDismiss: () => void;
}

function ChatRow({ item, now, onResolve, onOpen, onDismiss }: RowProps) {
  const isPerm = item.status === "permission";
  const isRunning = item.status === "running";

  // Click anywhere on the row toggles expand. Permission, Running, Done
  // all share the same UX — click to see details/actions.
  const [expanded, setExpanded] = useState(false);

  const accent = isPerm
    ? "var(--color-warning)"
    : isRunning
      ? "var(--color-highlight)"
      : "var(--color-text-muted)";
  const dotPulse = isPerm || isRunning;

  // Duration semantics:
  //   Running     → live tick from running_started_at (RESET on each busy)
  //   Permission  → live tick from running_started_at (INHERITED, no reset)
  //   Done        → FROZEN done_duration_ms, never updates
  const durationText =
    item.status === "done"
      ? item.done_duration_ms != null
        ? formatDuration(item.done_duration_ms)
        : null
      : item.running_started_at != null
        ? formatDuration(now - item.running_started_at)
        : null;

  const title = item.chat_title || item.task_name;
  const preview = isPerm
    ? item.pending_description
    : isRunning
      ? item.prompt
      : item.message;

  const agentMeta = resolveAgent(item.agent ?? null);
  const AgentIcon = agentMeta?.icon ?? null;

  return (
    <motion.div
      layout
      transition={CARD_MORPH}
      className="group relative mx-1 px-2.5 py-2 cursor-pointer transition-colors hover:bg-[color-mix(in_srgb,var(--color-text)_4%,transparent)]"
      onClick={() => setExpanded((v) => !v)}
    >
      {/* Row 1: agent · title · status text + time */}
      <div className="flex items-center gap-2.5">
        <span
          className="relative flex h-[20px] w-[20px] shrink-0 items-center justify-center"
          style={{
            background: isRunning
              ? "color-mix(in srgb, var(--color-highlight) 14%, transparent)"
              : isPerm
                ? "color-mix(in srgb, var(--color-warning) 14%, transparent)"
                : "color-mix(in srgb, var(--color-text) 6%, transparent)",
          }}
        >
          {AgentIcon ? (
            <AgentIcon size={13} />
          ) : (
            <span className="text-[10px] text-[var(--color-text-muted)]">
              {(item.agent || "?")[0].toUpperCase()}
            </span>
          )}
          {isRunning ? (
            <span className="pointer-events-none absolute inset-0 animate-[trayPulseRing_1.6s_ease-in-out_infinite]" />
          ) : null}
        </span>
        <span
          className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-semibold text-[var(--color-text)]"
          title={`${item.project_name} / ${item.task_name}${item.chat_title ? ` · ${item.chat_title}` : ""}`}
        >
          {title}
        </span>
        {/* Explicit status text — color is hard to read on its own. */}
        <span
          className={`shrink-0 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-[0.8px] ${dotPulse ? "" : ""}`}
          style={{ color: accent }}
        >
          <span
            className={`h-[6px] w-[6px] ${dotPulse ? "animate-pulse" : ""}`}
            style={{
              background: accent,
              borderRadius: 999,
              boxShadow: dotPulse
                ? `0 0 6px color-mix(in srgb, ${accent} 60%, transparent)`
                : undefined,
            }}
          />
          {isPerm ? "Permission" : isRunning ? "Running" : "Done"}
        </span>
        {durationText ? (
          <span className="shrink-0 font-mono text-[10.5px] text-[var(--color-text-muted)]">
            {durationText}
          </span>
        ) : null}
      </div>

      {/* Row 2: provenance + preview (one-line, always visible) */}
      <div className="mt-0.5 ml-[30px] flex items-center gap-1.5 text-[11.5px] text-[var(--color-text-muted)]">
        {item.chat_title && item.task_name !== item.chat_title ? (
          <span className="shrink-0 text-[10.5px] opacity-70">
            {item.project_name} / {item.task_name}
          </span>
        ) : (
          <span className="shrink-0 text-[10.5px] opacity-70">{item.project_name}</span>
        )}
        {preview && !expanded ? (
          <>
            <span className="opacity-40">·</span>
            <span
              className="overflow-hidden text-ellipsis whitespace-nowrap"
              style={isPerm ? { color: "var(--color-warning)" } : undefined}
            >
              {preview}
            </span>
          </>
        ) : null}
      </div>

      {/* Expanded body: full preview + actions */}
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            key="body"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="mt-2 ml-[30px]">
              {preview ? (
                <div
                  className={`text-[12px] leading-snug whitespace-pre-wrap max-h-[160px] overflow-y-auto ${isPerm ? "text-[var(--color-text)]" : "text-[color-mix(in_srgb,var(--color-text)_88%,transparent)]"}`}
                >
                  {preview}
                </div>
              ) : null}
              {isPerm && item.pending_options ? (
                <div className="mt-2 flex flex-col gap-1">
                  {orderOptions(item.pending_options).map((opt, idx) => {
                    const isAllow = opt.kind.startsWith("allow");
                    const isPrimary = idx === 0 && isAllow;
                    return (
                      <button
                        key={opt.option_id}
                        onClick={(e) => {
                          e.stopPropagation();
                          onResolve?.(opt);
                        }}
                        className={
                          isPrimary
                            ? "px-3 py-1 text-[11.5px] font-medium bg-[var(--color-highlight)] text-white hover:opacity-90 transition-all text-left"
                            : isAllow
                              ? "px-3 py-1 text-[11.5px] text-left text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
                              : "px-3 py-1 text-[11.5px] text-left text-[var(--color-text-muted)] hover:text-[var(--color-error)] hover:bg-[color-mix(in_srgb,var(--color-error)_10%,transparent)] transition-colors"
                        }
                      >
                        {opt.name}
                      </button>
                    );
                  })}
                  <div className="flex justify-end mt-1">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpen();
                      }}
                      className="inline-flex items-center gap-1 px-3 py-1 text-[11px] font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
                    >
                      Open <ExternalLink size={11} className="opacity-80" />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-2 flex justify-end gap-1.5">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDismiss();
                    }}
                    className="px-2.5 py-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
                  >
                    Dismiss
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpen();
                    }}
                    className="inline-flex items-center gap-1 px-3 py-1 text-[11px] font-medium bg-[var(--color-highlight)] text-white hover:opacity-90 transition-all"
                  >
                    Open <ExternalLink size={11} className="opacity-80" />
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

    </motion.div>
  );
}

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
