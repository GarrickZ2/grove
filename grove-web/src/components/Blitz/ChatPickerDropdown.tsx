import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { listChats } from "../../api/tasks";
import type { BlitzTask } from "../../data/types";
import type { SlotAssignment } from "./useBlitzGrid";

interface ChatPickerDropdownProps {
  blitzTasks: BlitzTask[];
  onSelect: (assignment: SlotAssignment) => void;
  onClose: () => void;
}

type ChatRow = { id: string; name: string };
type ChatLoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; chats: ChatRow[] }
  | { kind: "error"; message: string };

export function ChatPickerDropdown({ blitzTasks, onSelect, onClose }: ChatPickerDropdownProps) {
  const [query, setQuery] = useState("");
  const [expandedTaskKey, setExpandedTaskKey] = useState<string | null>(null);
  const [chatLoads, setChatLoads] = useState<Record<string, ChatLoadState>>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return blitzTasks;
    return blitzTasks.filter((bt) => bt.task.name.toLowerCase().includes(q));
  }, [blitzTasks, query]);

  const grouped = useMemo(() => {
    const m = new Map<string, { projectId: string; projectName: string; tasks: BlitzTask[] }>();
    for (const bt of filtered) {
      const g = m.get(bt.projectId);
      if (g) g.tasks.push(bt);
      else m.set(bt.projectId, { projectId: bt.projectId, projectName: bt.projectName, tasks: [bt] });
    }
    return Array.from(m.values());
  }, [filtered]);

  function taskKey(bt: BlitzTask): string {
    return `${bt.projectId}:${bt.task.id}`;
  }

  const fetchChats = useCallback(async (bt: BlitzTask) => {
    const key = taskKey(bt);
    setChatLoads((prev) => ({ ...prev, [key]: { kind: "loading" } }));
    try {
      const chats = await listChats(bt.projectId, bt.task.id);
      if (!mountedRef.current) return;
      setChatLoads((prev) => ({
        ...prev,
        [key]: { kind: "loaded", chats: chats.map((c) => ({ id: c.id, name: c.title })) },
      }));
    } catch (err) {
      if (!mountedRef.current) return;
      const message = err instanceof Error ? err.message : "Failed to load chats";
      setChatLoads((prev) => ({ ...prev, [key]: { kind: "error", message } }));
    }
  }, []);

  const toggleExpand = useCallback(async (bt: BlitzTask) => {
    const key = taskKey(bt);
    if (expandedTaskKey === key) {
      setExpandedTaskKey(null);
      return;
    }
    setExpandedTaskKey(key);
    const existing = chatLoads[key];
    if (existing && existing.kind !== "idle" && existing.kind !== "error") return;
    await fetchChats(bt);
  }, [expandedTaskKey, chatLoads, fetchChats]);

  function pickChat(bt: BlitzTask, chat: ChatRow) {
    onSelect({
      projectId: bt.projectId,
      projectName: bt.projectName,
      taskId: bt.task.id,
      taskName: bt.task.name,
      chatId: chat.id,
      chatName: chat.name,
    });
  }

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal={false}
      aria-label="Pick a chat"
      className="absolute z-50 mt-1 w-80 max-h-96 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-md shadow-xl overflow-hidden flex flex-col"
    >
      <div className="p-2 border-b border-[var(--color-border)]">
        <input
          ref={inputRef}
          type="text"
          aria-label="Search tasks"
          placeholder="Search tasks…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full px-2 py-1 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-accent)]"
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {grouped.length === 0 ? (
          <div className="p-4 text-sm text-[var(--color-text-muted)] text-center">No tasks</div>
        ) : (
          grouped.map((g) => (
            <div key={g.projectId}>
              <div className="px-3 py-1 text-xs uppercase tracking-wider text-[var(--color-text-muted)] bg-[var(--color-bg-tertiary)]">
                {g.projectName}
              </div>
              {g.tasks.map((bt) => {
                const key = taskKey(bt);
                const expanded = expandedTaskKey === key;
                const load = chatLoads[key];
                return (
                  <div key={key}>
                    {/* eslint-disable react-hooks/refs */}
                    <button
                      type="button"
                      onClick={() => void toggleExpand(bt)}
                      aria-expanded={expanded}
                      className="w-full text-left px-3 py-1.5 text-sm text-[var(--color-text)] hover:brightness-125 flex items-center justify-between"
                    >
                      <span className="truncate">{bt.task.name}</span>
                      <span className="text-[var(--color-text-muted)] text-xs ml-2">{expanded ? "▾" : "▸"}</span>
                    </button>
                    {/* eslint-enable react-hooks/refs */}
                    {expanded && (
                      <div className="pl-6 pr-3 pb-2 bg-[var(--color-bg)]">
                        {(!load || load.kind === "idle" || load.kind === "loading") ? (
                          <div className="py-1 text-xs text-[var(--color-text-muted)]">Loading chats…</div>
                        ) : load.kind === "error" ? (
                          <div className="py-1 text-xs text-[var(--color-error)] flex items-center justify-between">
                            <span>{load.message}</span>
                            <button
                              type="button"
                              onClick={() => void fetchChats(bt)}
                              className="ml-2 underline text-[var(--color-text-muted)]"
                            >
                              Retry
                            </button>
                          </div>
                        ) : load.chats.length === 0 ? (
                          <div className="py-1 text-xs text-[var(--color-text-muted)]">No chats in this task</div>
                        ) : (
                          load.chats.map((c) => (
                            <button
                              key={c.id}
                              type="button"
                              onClick={() => pickChat(bt, c)}
                              className="w-full text-left py-1 text-xs text-[var(--color-text)] hover:underline truncate"
                            >
                              {c.name}
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
