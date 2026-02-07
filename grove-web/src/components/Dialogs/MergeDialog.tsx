import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { GitMerge, X, Loader2, GitBranch } from "lucide-react";
import { Button } from "../ui";

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

  // Escape to close
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onCancel]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isLoading) {
      onMerge(selectedMethod);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onCancel}
            className="fixed inset-0 bg-black/50 z-50"
            data-hotkeys-dialog
          />

          {/* Dialog */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.2 }}
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md"
          >
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
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
