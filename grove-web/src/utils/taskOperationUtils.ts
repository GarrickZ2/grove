import { Terminal, GitCommit, GitBranchPlus, RefreshCw, GitMerge, Archive, RotateCcw, Trash2 } from "lucide-react";
import type { Task } from "../data/types";
import type { ContextMenuItem } from "../components/ui/ContextMenu";

/**
 * Task operation handlers interface
 * All handlers are optional — if undefined, the corresponding menu item is hidden.
 */
export interface TaskOperationHandlers {
  onEnterTerminal?: () => void;
  onCommit?: () => void;
  onRebase?: () => void;
  onSync?: () => void;
  onMerge?: () => void;
  onArchive?: () => void;
  onReset?: () => void;
  onClean?: () => void;
  onRecover?: () => void;
}

/**
 * Build context menu items for a task.
 * Only includes items whose handlers are provided (non-undefined).
 */
export function buildContextMenuItems(
  task: Task,
  handlers: TaskOperationHandlers
): ContextMenuItem[] {
  // Archived task menu
  if (task.status === "archived") {
    const items: ContextMenuItem[] = [];

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

    if (handlers.onClean) {
      items.push({
        id: "clean",
        label: "Clean",
        icon: Trash2,
        variant: "danger",
        onClick: handlers.onClean,
      });
    }

    return items;
  }

  // Local task menu: only Terminal + Commit
  if (task.isLocal) {
    const items: ContextMenuItem[] = [];
    if (handlers.onEnterTerminal) {
      items.push({
        id: "terminal",
        label: "Enter Terminal",
        icon: Terminal,
        variant: "default",
        onClick: handlers.onEnterTerminal,
      });
    }
    if (handlers.onCommit) {
      if (items.length > 0) items.push({ id: "div-1", label: "", divider: true, onClick: () => {} });
      items.push({
        id: "commit",
        label: "Commit",
        icon: GitCommit,
        variant: "default",
        onClick: handlers.onCommit,
      });
    }
    return items;
  }

  // Active task menu — build dynamically based on available handlers
  const items: ContextMenuItem[] = [];

  // Enter workspace
  if (handlers.onEnterTerminal) {
    items.push({
      id: "terminal",
      label: "Enter Workspace",
      icon: Terminal,
      variant: "default",
      onClick: handlers.onEnterTerminal,
    });
  }

  // Git operations group
  const gitItems: ContextMenuItem[] = [];
  if (handlers.onCommit) {
    gitItems.push({
      id: "commit",
      label: "Commit",
      icon: GitCommit,
      variant: "default",
      onClick: handlers.onCommit,
    });
  }
  if (handlers.onRebase) {
    gitItems.push({
      id: "rebase",
      label: "Rebase",
      icon: GitBranchPlus,
      variant: "default",
      onClick: handlers.onRebase,
    });
  }
  if (handlers.onSync) {
    gitItems.push({
      id: "sync",
      label: "Sync",
      icon: RefreshCw,
      variant: "default",
      onClick: handlers.onSync,
    });
  }
  if (handlers.onMerge) {
    gitItems.push({
      id: "merge",
      label: "Merge",
      icon: GitMerge,
      variant: "default",
      onClick: handlers.onMerge,
    });
  }

  if (gitItems.length > 0) {
    if (items.length > 0) items.push({ id: "div-1", label: "", divider: true, onClick: () => {} });
    items.push(...gitItems);
  }

  // Danger operations group
  const dangerItems: ContextMenuItem[] = [];
  if (handlers.onArchive) {
    dangerItems.push({
      id: "archive",
      label: "Archive",
      icon: Archive,
      variant: "warning",
      onClick: handlers.onArchive,
    });
  }
  if (handlers.onReset) {
    dangerItems.push({
      id: "reset",
      label: "Reset",
      icon: RotateCcw,
      variant: "warning",
      onClick: handlers.onReset,
    });
  }
  if (handlers.onClean) {
    dangerItems.push({
      id: "clean",
      label: "Clean",
      icon: Trash2,
      variant: "danger",
      onClick: handlers.onClean,
    });
  }

  if (dangerItems.length > 0) {
    if (items.length > 0) items.push({ id: "div-2", label: "", divider: true, onClick: () => {} });
    items.push(...dangerItems);
  }

  return items;
}
