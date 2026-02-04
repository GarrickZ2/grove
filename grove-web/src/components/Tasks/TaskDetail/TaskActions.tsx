import { RefreshCw, GitMerge, Archive, Trash2, RotateCcw } from "lucide-react";
import { Button } from "../../ui";
import type { Task } from "../../../data/types";

interface TaskActionsProps {
  task: Task;
  onSync: () => void;
  onMerge: () => void;
  onArchive: () => void;
  onClean: () => void;
  onRecover: () => void;
}

export function TaskActions({
  task,
  onSync,
  onMerge,
  onArchive,
  onClean,
  onRecover,
}: TaskActionsProps) {
  const isArchived = task.status === "archived";
  const isBroken = task.status === "broken";
  const canSync = !isArchived && !isBroken;
  const canMerge = !isArchived && !isBroken && task.status !== "merged";
  const canArchive = !isBroken && !isArchived;

  return (
    <div className="flex items-center justify-between px-4 py-3 border-t border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="flex gap-2">
        {canSync && (
          <Button variant="secondary" size="sm" onClick={onSync}>
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
            Sync
          </Button>
        )}
        {canMerge && (
          <Button variant="secondary" size="sm" onClick={onMerge}>
            <GitMerge className="w-3.5 h-3.5 mr-1.5" />
            Merge
          </Button>
        )}
        {canArchive && (
          <Button variant="secondary" size="sm" onClick={onArchive}>
            <Archive className="w-3.5 h-3.5 mr-1.5" />
            Archive
          </Button>
        )}
        {isArchived && (
          <Button variant="secondary" size="sm" onClick={onRecover}>
            <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
            Recover
          </Button>
        )}
      </div>

      <Button
        variant="ghost"
        size="sm"
        onClick={onClean}
        className="text-[var(--color-error)] hover:text-[var(--color-error)] hover:bg-[var(--color-error)]/10"
      >
        <Trash2 className="w-3.5 h-3.5 mr-1.5" />
        Clean
      </Button>
    </div>
  );
}
