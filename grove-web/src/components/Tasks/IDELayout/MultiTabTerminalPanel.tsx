import { useCallback, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import type { Task } from "../../../data/types";
import { XTerminal } from "../TaskDetail/XTerminal";
import { useTerminalTheme } from "../../../context";

export interface TerminalTab {
  id: string;
  label: string;
}

interface MultiTabTerminalPanelProps {
  projectId: string;
  task: Task;
  side: "left" | "right";
  /** Controlled tab list — owned by parent so it survives panel hide/show */
  tabs: TerminalTab[];
  activeId: string;
  onTabsChange: (tabs: TerminalTab[], activeId: string) => void;
  onClose?: () => void;
  /** Orbit: the bottom-dock frame (dark tab strip in the terminal's colours). */
  orbit?: boolean;
}

export function MultiTabTerminalPanel({
  projectId,
  task,
  side,
  tabs,
  activeId,
  onTabsChange,
  onClose,
  orbit = false,
}: MultiTabTerminalPanelProps) {
  const { terminalTheme } = useTerminalTheme();

  // Per-mount counter so new tabs get sequential labels from the current max.
  // Initialize from the highest `(N)` suffix already present in the rehydrated
  // tab list (fallback to `tabs.length`) — otherwise closing middle tabs then
  // reopening the panel would hand out already-taken labels.
  const counterRef = useRef(
    Math.max(
      tabs.length,
      ...tabs.map((t) => {
        const m = /\((\d+)\)\s*$/.exec(t.label);
        return m ? Number(m[1]) : 0;
      }),
    ),
  );

  // Rename state — mirrors the Sketch tab bar's pattern: double-click opens
  // an inline input; Enter commits, Escape cancels, blur commits-or-cancels.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  const beginRename = useCallback((tab: TerminalTab) => {
    setRenamingId(tab.id);
    setDraftName(tab.label);
  }, []);

  const commitRename = useCallback(
    (id: string) => {
      const name = draftName.trim();
      setRenamingId(null);
      if (!name) return;
      const current = tabs.find((t) => t.id === id);
      if (!current || current.label === name) return;
      onTabsChange(
        tabs.map((t) => (t.id === id ? { ...t, label: name } : t)),
        activeId,
      );
    },
    [draftName, tabs, activeId, onTabsChange],
  );

  const addTab = useCallback(() => {
    counterRef.current += 1;
    const n = counterRef.current;
    const newTab: TerminalTab = {
      id: `term-${Date.now()}-${n}`,
      label: `Terminal (${n})`,
    };
    onTabsChange([...tabs, newTab], newTab.id);
  }, [tabs, onTabsChange]);

  const closeTab = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = tabs.filter((t) => t.id !== id);
    if (next.length === 0) {
      onClose?.();
      return;
    }
    const newActiveId =
      id === activeId
        ? next[Math.max(0, tabs.findIndex((t) => t.id === id) - 1)]?.id ?? next[0].id
        : activeId;
    onTabsChange(next, newActiveId);
  }, [tabs, activeId, onTabsChange, onClose]);

  const switchTab = useCallback((id: string) => {
    if (id !== activeId) onTabsChange(tabs, id);
  }, [tabs, activeId, onTabsChange]);

  if (orbit) {
    const termStyle = {
      "--ows-term-bg": terminalTheme.colors.background,
      "--ows-term-fg": terminalTheme.colors.foreground,
    } as React.CSSProperties;
    return (
      <div className="ows-term" style={termStyle}>
        <div className="ows-term-head" role="tablist" aria-label="Terminals">
          {tabs.map((tab) => {
            const isActive = tab.id === activeId;
            const isRenaming = renamingId === tab.id;
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={isActive}
                tabIndex={0}
                className={`ows-ttab${isActive ? " is-on" : ""}`}
                onClick={() => !isRenaming && switchTab(tab.id)}
                onKeyDown={(e) => { if (!isRenaming && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); switchTab(tab.id); } }}
              >
                {isRenaming ? (
                  <input
                    autoFocus
                    value={draftName}
                    aria-label="Terminal name"
                    onChange={(e) => setDraftName(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={() => commitRename(tab.id)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                      else if (e.key === "Escape") setRenamingId(null);
                    }}
                  />
                ) : (
                  <span
                    className="ows-ttab-label"
                    title="Double-click to rename"
                    onDoubleClick={(e) => { e.stopPropagation(); beginRename(tab); }}
                  >
                    {tab.label}
                  </span>
                )}
                <button type="button" className="ows-ttab-x" aria-label={`Close ${tab.label}`} onClick={(e) => closeTab(tab.id, e)}>
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
          <button type="button" className="ows-term-ib" aria-label="New terminal" title="New terminal" onClick={addTab}>
            <Plus />
          </button>
          <span className="ows-term-spacer" />
          {onClose && (
            <button type="button" className="ows-term-ib" aria-label="Close terminal" title="Close terminal" onClick={onClose}>
              <X />
            </button>
          )}
        </div>
        <div className="ows-term-body">
          <XTerminal key={activeId} projectId={projectId} taskId={task.id} instanceId={activeId} />
        </div>
      </div>
    );
  }

  return (
    <div className={`ide-panel-slot ide-panel-slot--${side} ide-panel-slot--terminal`}>
      {/* Tab bar — styled to match `SketchTabBar` for design consistency:
          rounded chip tabs, inline rename via double-click, always-visible
          close × on each tab. */}
      <div
        className="flex items-center gap-1 px-2 py-1.5 border-b"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-bg-secondary)",
        }}
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeId;
          const isRenaming = renamingId === tab.id;
          return (
            <div
              key={tab.id}
              onClick={() => !isRenaming && switchTab(tab.id)}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs cursor-pointer transition-colors"
              style={{
                background: isActive
                  ? "color-mix(in srgb, var(--color-highlight) 12%, transparent)"
                  : "transparent",
                color: isActive ? "var(--color-text)" : "var(--color-text-muted)",
              }}
              onMouseEnter={(e) => {
                if (!isActive) {
                  e.currentTarget.style.background = "var(--color-bg-tertiary)";
                }
              }}
              onMouseLeave={(e) => {
                if (!isActive) {
                  e.currentTarget.style.background = "transparent";
                }
              }}
            >
              {isRenaming ? (
                <input
                  autoFocus
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={() => commitRename(tab.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      (e.currentTarget as HTMLInputElement).blur();
                    } else if (e.key === "Escape") {
                      setRenamingId(null);
                    }
                  }}
                  className="bg-transparent outline-none border rounded px-1 text-xs"
                  style={{
                    borderColor: "var(--color-border)",
                    color: "var(--color-text)",
                  }}
                />
              ) : (
                <>
                  <span
                    className="truncate max-w-[160px]"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      beginRename(tab);
                    }}
                    title="Double-click to rename"
                  >
                    {tab.label}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => closeTab(tab.id, e)}
                    className="p-0.5 rounded hover:bg-black/10 transition-colors"
                    title="Close terminal"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </>
              )}
            </div>
          );
        })}
        <button
          type="button"
          onClick={addTab}
          title="New terminal"
          className="p-1 rounded-md transition-colors"
          style={{ color: "var(--color-text-muted)" }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--color-bg-tertiary)";
            e.currentTarget.style.color = "var(--color-text)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--color-text-muted)";
          }}
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
        <div className="flex-1" />
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title="Close panel"
            className="p-1 rounded-md transition-colors"
            style={{ color: "var(--color-text-muted)" }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--color-bg-tertiary)";
              e.currentTarget.style.color = "var(--color-text)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = "var(--color-text-muted)";
            }}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Only the active tab's XTerminal is mounted.
          Switching tabs causes the old one to unmount (XTerminal cache detaches WS)
          and the new one to mount (XTerminal cache reattaches WS). */}
      <div className="ide-panel-slot__body" style={{ backgroundColor: terminalTheme.colors.background }}>
        <XTerminal
          key={activeId}
          projectId={projectId}
          taskId={task.id}
          instanceId={activeId}
        />
      </div>
    </div>
  );
}
