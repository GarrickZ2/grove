import { useCallback, useState } from "react";
import { GitMerge, X, Loader2, GitBranch } from "lucide-react";
import { Button } from "../ui";
import { DialogShell } from "../ui/DialogShell";
import { useCommand, useContextKey, useKeyboardScope } from "../../keyboard";

type MergeMethod = "squash" | "merge-commit";

interface MergeDialogProps {
  isOpen: boolean;
  taskName: string;
  branchName: string;
  targetBranch: string;
  isLoading?: boolean;
  error?: string | null;
  onMerge: (method: MergeMethod) => void;
  onCancel: () => void;
}

export function MergeDialog({
  isOpen,
  taskName,
  branchName,
  targetBranch,
  isLoading = false,
  error = null,
  onMerge,
  onCancel,
}: MergeDialogProps) {
  const [selectedMethod, setSelectedMethod] = useState<MergeMethod>("squash");

  // Catalog handlers register inside <MergeDialogBindings> only while
  // isOpen=true. Multiple MergeDialog wrappers can coexist (one per task
  // row, all but the active one with isOpen=false); a top-level useCommand
  // would otherwise overwrite each other on every re-render — only the
  // last-mounted dialog's binding would be live.
  useKeyboardScope("dialog.merge", isOpen);

  const handleSubmit = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!isLoading) {
        onMerge(selectedMethod);
      }
    },
    [isLoading, onMerge, selectedMethod],
  );

  return (
    <DialogShell isOpen={isOpen} onClose={onCancel}>
      {isOpen && (
        <MergeDialogBindings onCancel={onCancel} onSubmit={handleSubmit} methodSelected={!!selectedMethod} />
      )}
      <form
        onSubmit={handleSubmit}
        className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl shadow-xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-[var(--color-success)]/10">
              <GitMerge className="w-5 h-5 text-[var(--color-success)]" />
            </div>
            <h2 className="text-lg font-semibold text-[var(--color-text)]">Merge Task</h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="p-1.5 rounded-lg hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="px-5 py-4 space-y-4">
          {/* Task info */}
          <div className="p-3 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)]">
            <p className="text-sm font-medium text-[var(--color-text)]">{taskName}</p>
            <div className="flex items-center gap-2 mt-1 text-xs text-[var(--color-text-muted)]">
              <GitBranch className="w-3 h-3" />
              <span className="font-mono">{branchName}</span>
              <span>→</span>
              <span className="font-mono">{targetBranch}</span>
            </div>
          </div>

          {/* Merge method selection */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-[var(--color-text)]">
              Merge Method
            </label>

            <label
              className={`block p-3 rounded-lg border cursor-pointer transition-colors ${
                selectedMethod === "squash"
                  ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/5"
                  : "border-[var(--color-border)] hover:border-[var(--color-highlight)]/50"
              }`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="radio"
                  name="method"
                  value="squash"
                  checked={selectedMethod === "squash"}
                  onChange={() => setSelectedMethod("squash")}
                  className="mt-1"
                />
                <div>
                  <p className="text-sm font-medium text-[var(--color-text)]">Squash and Merge</p>
                  <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
                    Combine all commits into one commit on the target branch
                  </p>
                </div>
              </div>
            </label>

            <label
              className={`block p-3 rounded-lg border cursor-pointer transition-colors ${
                selectedMethod === "merge-commit"
                  ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/5"
                  : "border-[var(--color-border)] hover:border-[var(--color-highlight)]/50"
              }`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="radio"
                  name="method"
                  value="merge-commit"
                  checked={selectedMethod === "merge-commit"}
                  onChange={() => setSelectedMethod("merge-commit")}
                  className="mt-1"
                />
                <div>
                  <p className="text-sm font-medium text-[var(--color-text)]">Merge Commit</p>
                  <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
                    Create a merge commit preserving all individual commits
                  </p>
                </div>
              </div>
            </label>
          </div>

          {error && (
            <p className="text-sm text-[var(--color-error)]">{error}</p>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3 px-5 py-4 bg-[var(--color-bg)] border-t border-[var(--color-border)]">
          <Button type="button" variant="secondary" onClick={onCancel} disabled={isLoading}>
            Cancel
          </Button>
          <Button type="submit" disabled={isLoading}>
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                Merging...
              </>
            ) : (
              <>
                <GitMerge className="w-4 h-4 mr-1.5" />
                Merge
              </>
            )}
          </Button>
        </div>
      </form>
    </DialogShell>
  );
}

// Registers the git.merge.* catalog handlers only while the dialog is
// actually open. See top-of-component comment for the multi-mount rationale.
function MergeDialogBindings({
  onCancel,
  onSubmit,
  methodSelected,
}: {
  onCancel: () => void;
  onSubmit: () => void;
  methodSelected: boolean;
}) {
  // git.merge.submit gates on `methodSelected`. A merge method always has a
  // default, so this is effectively "the dialog is open" — kept for catalog
  // consistency with the other submit gates.
  useContextKey("methodSelected", methodSelected);
  useCommand("git.merge.cancel", onCancel, [onCancel]);
  useCommand("git.merge.submit", onSubmit, [onSubmit]);
  return null;
}
