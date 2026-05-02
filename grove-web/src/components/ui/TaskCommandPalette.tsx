import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Search, Code, Laptop, Zap } from "lucide-react";
import type { Task } from "../../data/types";

interface TaskCommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  tasks: Task[];
  selectedTask: Task | null;
  onTaskSelect: (task: Task) => void;
}

/** Match TaskListItem icon logic: Local=Laptop, Agent=Zap, Regular=Code */
function getTaskIcon(task: Task) {
  if (task.isLocal) return { Icon: Laptop, color: "var(--color-accent)" };
  if (task.createdBy === "agent") return { Icon: Zap, color: "var(--color-info)" };
  return { Icon: Code, color: "var(--color-highlight)" };
}

export function TaskCommandPalette({ isOpen, onClose, tasks, selectedTask, onTaskSelect }: TaskCommandPaletteProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Exclude archived tasks, then apply search filter
  const activeTasks = useMemo(() => tasks.filter((t) => t.status !== "archived"), [tasks]);

  const filteredTasks = useMemo(() => {
    if (!searchQuery) return activeTasks;
    const q = searchQuery.toLowerCase();
    return activeTasks.filter((t) =>
      t.name.toLowerCase().includes(q) ||
      t.branch.toLowerCase().includes(q)
    );
  }, [activeTasks, searchQuery]);

  useEffect(() => {
    if (isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSearchQuery("");
      // Pre-select the current task
      const currentIdx = activeTasks.findIndex((t) => t.id === selectedTask?.id);
       
      setHighlightedIndex(currentIdx >= 0 ? currentIdx : 0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen, activeTasks, selectedTask]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHighlightedIndex(0);
  }, [searchQuery]);

  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll("[data-palette-item]");
    const item = items[highlightedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  const handleSelect = useCallback((task: Task) => {
    onTaskSelect(task);
    onClose();
  }, [onTaskSelect, onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlightedIndex((prev) =>
          prev < filteredTasks.length - 1 ? prev + 1 : 0
        );
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightedIndex((prev) =>
          prev > 0 ? prev - 1 : filteredTasks.length - 1
        );
        break;
      case "Enter":
        e.preventDefault();
        if (filteredTasks[highlightedIndex]) {
          handleSelect(filteredTasks[highlightedIndex]);
        }
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  }, [filteredTasks, highlightedIndex, handleSelect, onClose]);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/50 z-50"
            data-hotkeys-dialog
          />
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className="fixed left-1/2 top-[15%] -translate-x-1/2 z-50 w-full max-w-lg"
            onKeyDown={handleKeyDown}
          >
            <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl shadow-2xl overflow-hidden">
              {/* Header */}
              <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--color-border)]">
                <Search className="w-4 h-4 text-[var(--color-text-muted)] flex-shrink-0" />
                <input
                  ref={inputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search tasks..."
                  className="flex-1 bg-transparent text-sm text-[var(--color-text)] placeholder-[var(--color-text-muted)] outline-none"
                />
                <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-muted)] bg-[var(--color-bg)] border border-[var(--color-border)] rounded">
                  ESC
                </kbd>
              </div>

              {/* List */}
              <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
                {filteredTasks.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-[var(--color-text-muted)]">
                    {activeTasks.length === 0 ? "No active tasks in this project" : "No tasks found"}
                  </div>
                ) : (
                  filteredTasks.map((task, index) => {
                    const { Icon, color } = getTaskIcon(task);
                    const isCurrent = selectedTask?.id === task.id;
                    return (
                      <button
                        key={task.id}
                        data-palette-item
                        onClick={() => handleSelect(task)}
                        onMouseEnter={() => setHighlightedIndex(index)}
                        className={`w-full flex items-center gap-3 px-4 py-2.5 transition-colors ${
                          index === highlightedIndex
                            ? "bg-[var(--color-highlight)]/10"
                            : "hover:bg-[var(--color-bg-tertiary)]"
                        }`}
                      >
                        <Icon
                          className="w-4 h-4 flex-shrink-0"
                          style={{ color }}
                        />
                        <div className="flex-1 min-w-0 text-left">
                          <div className="text-sm font-medium text-[var(--color-text)] truncate">
                            {task.name}
                          </div>
                          <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                            <span>{task.branch}</span>
                            <span>&rarr;</span>
                            <span>{task.target}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {isCurrent && (
                            <span className="text-xs text-[var(--color-highlight)]">current</span>
                          )}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>

              {/* Footer */}
              <div className="flex items-center gap-3 px-4 py-2 border-t border-[var(--color-border)] text-[10px] text-[var(--color-text-muted)]">
                <span className="flex items-center gap-1">
                  <kbd className="inline-flex items-center px-1 py-0.5 font-medium bg-[var(--color-bg)] border border-[var(--color-border)] rounded">&uarr;&darr;</kbd>
                  navigate
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="inline-flex items-center px-1 py-0.5 font-medium bg-[var(--color-bg)] border border-[var(--color-border)] rounded">&crarr;</kbd>
                  select
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="inline-flex items-center px-1 py-0.5 font-medium bg-[var(--color-bg)] border border-[var(--color-border)] rounded">esc</kbd>
                  close
                </span>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
