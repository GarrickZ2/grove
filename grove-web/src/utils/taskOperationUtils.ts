import { Terminal, GitCommit, GitBranchPlus, RefreshCw, GitMerge, Archive, RotateCcw, Trash2 } from "lucide-react";
import type { Task } from "../data/types";
import type { ContextMenuItem } from "../components/ui/ContextMenu";

/**
 * Task operation handlers interface
 */
export interface TaskOperationHandlers {
  onEnterTerminal: () => void;
  onCommit: () => void;
  onRebase: () => void;
  onSync: () => void;
  onMerge: () => void;
  onArchive: () => void;
  onReset: () => void;
  onClean: () => void;
  onRecover?: () => void; // Zen-only (for archived tasks)
}

/**
 * Build context menu items for a task
 *
 * @param task - The task to build menu for
 * @param handlers - Operation handlers
 * @returns Array of context menu items
 */
export function buildContextMenuItems(
  task: Task,
  handlers: TaskOperationHandlers
): ContextMenuItem[] {
  // Archived task menu
  if (task.status === "archived") {
    const items: ContextMenuItem[] = [];

    // Add recover option if handler provided (Zen-only)
    if (handlers.onRecover) {
      items.push({
        id: "recover",
        label: "Recover",
        icon: RotateCcw,
        variant: "default",
        onClick: handlers.onRecover,
      });
      items.push({
        id: "div-1",
        label: "",
        divider: true,
        onClick: () => {},
      });
    }

    items.push({
      id: "clean",
      label: "Clean",
      icon: Trash2,
      variant: "danger",
      onClick: handlers.onClean,
    });

    return items;
  }

  // Active task menu
  const canOperate = task.status !== "broken";

  return [
    {
      id: "terminal",
      label: "Enter Terminal",
      icon: Terminal,
      variant: "default",
      onClick: handlers.onEnterTerminal,
    },
    {
      id: "div-1",
      label: "",
      divider: true,
      onClick: () => {},
    },
    {
      id: "commit",
      label: "Commit",
      icon: GitCommit,
      variant: "default",
      onClick: handlers.onCommit,
    },
    {
      id: "rebase",
      label: "Rebase",
      icon: GitBranchPlus,
      variant: "default",
      onClick: handlers.onRebase,
      disabled: !canOperate,
    },
    {
      id: "sync",
      label: "Sync",
      icon: RefreshCw,
      variant: "default",
      onClick: handlers.onSync,
      disabled: !canOperate,
    },
    {
      id: "merge",
      label: "Merge",
      icon: GitMerge,
      variant: "default",
      onClick: handlers.onMerge,
      disabled: !canOperate,
    },
    {
      id: "div-2",
      label: "",
      divider: true,
      onClick: () => {},
    },
    {
      id: "archive",
      label: "Archive",
      icon: Archive,
      variant: "warning",
      onClick: handlers.onArchive,
      disabled: task.status === "broken",
    },
    {
      id: "reset",
      label: "Reset",
      icon: RotateCcw,
      variant: "warning",
      onClick: handlers.onReset,
    },
    {
      id: "clean",
      label: "Clean",
      icon: Trash2,
      variant: "danger",
      onClick: handlers.onClean,
    },
  ];
}
