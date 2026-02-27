import type { DirtyBranchError } from "../../hooks";
import { ConfirmDialog } from "./ConfirmDialog";

interface DirtyBranchDialogProps {
  error: DirtyBranchError | null;
  onClose: () => void;
}

export function DirtyBranchDialog({ error, onClose }: DirtyBranchDialogProps) {
  if (!error) return null;

  const title = `${error.operation} Blocked`;
  const branchLabel = error.isWorktree ? "Task branch" : "Target branch";
  const suggestion = error.isWorktree
    ? "Please commit or stash your changes before retrying."
    : "This usually means another task has uncommitted changes on the target branch. Please commit or stash those changes first.";

  return (
    <ConfirmDialog
      isOpen
      title={title}
      variant="warning"
      confirmLabel="OK"
      cancelLabel="Dismiss"
      onConfirm={onClose}
      onCancel={onClose}
      message={
        <div className="flex flex-col gap-3">
          <p>
            {branchLabel}{" "}
            <code className="px-1.5 py-0.5 rounded bg-[var(--color-bg-tertiary)] text-[var(--color-text)] font-mono text-xs">
              {error.branch}
            </code>{" "}
            has uncommitted changes.
          </p>
          <p>{suggestion}</p>
        </div>
      }
    />
  );
}
