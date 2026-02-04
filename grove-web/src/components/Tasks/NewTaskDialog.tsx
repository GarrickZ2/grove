import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, GitBranch, Plus, FileText } from "lucide-react";
import { Button, Input } from "../ui";
import { useProject } from "../../context";
import { getBranches, type BranchInfo } from "../../api";

interface NewTaskDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (name: string, targetBranch: string, notes: string) => void | Promise<void>;
  isLoading?: boolean;
  externalError?: string | null;
}

export function NewTaskDialog({ isOpen, onClose, onCreate, isLoading, externalError }: NewTaskDialogProps) {
  const { selectedProject } = useProject();
  const [taskName, setTaskName] = useState("");
  const [targetBranch, setTargetBranch] = useState(selectedProject?.currentBranch || "main");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);

  // Load branches when dialog opens
  useEffect(() => {
    if (isOpen && selectedProject) {
      setLoadingBranches(true);
      getBranches(selectedProject.id)
        .then((response) => {
          setBranches(response.branches);
          setTargetBranch(response.current);
        })
        .catch((err) => {
          console.error("Failed to load branches:", err);
          // Fallback to current branch from project
          setBranches([{ name: selectedProject.currentBranch || "main", is_current: true }]);
        })
        .finally(() => {
          setLoadingBranches(false);
        });
    }
  }, [isOpen, selectedProject]);

  const handleSubmit = async () => {
    // Validate task name
    if (!taskName.trim()) {
      setError("Task name is required");
      return;
    }

    setError("");
    await onCreate(taskName.trim(), targetBranch, notes.trim());
  };

  const handleClose = () => {
    setTaskName("");
    setTargetBranch(selectedProject?.currentBranch || "main");
    setNotes("");
    setError("");
    onClose();
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
            onClick={handleClose}
            className="fixed inset-0 bg-black/50 z-50"
          />

          {/* Dialog */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.2 }}
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md"
          >
            <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl shadow-xl overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-[var(--color-highlight)]/10">
                    <Plus className="w-5 h-5 text-[var(--color-highlight)]" />
                  </div>
                  <h2 className="text-lg font-semibold text-[var(--color-text)]">New Task</h2>
                </div>
                <button
                  onClick={handleClose}
                  className="p-1.5 rounded-lg hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Content */}
              <div className="px-5 py-4 space-y-4">
                {/* Task Name */}
                <Input
                  label="Task Name"
                  placeholder="fix-auth-bug"
                  value={taskName}
                  onChange={(e) => {
                    setTaskName(e.target.value);
                    setError("");
                  }}
                  error={error || externalError || undefined}
                />

                {/* Target Branch */}
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-muted)] mb-2">
                    Target Branch
                  </label>
                  <div className="relative">
                    <GitBranch className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
                    <select
                      value={targetBranch}
                      onChange={(e) => setTargetBranch(e.target.value)}
                      disabled={loadingBranches}
                      className="w-full pl-9 pr-3 py-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg
                        text-sm text-[var(--color-text)] appearance-none cursor-pointer
                        focus:outline-none focus:border-[var(--color-highlight)] focus:ring-1 focus:ring-[var(--color-highlight)]
                        transition-all duration-200 disabled:opacity-50"
                    >
                      {loadingBranches ? (
                        <option>Loading...</option>
                      ) : (
                        branches.map((branch) => (
                          <option key={branch.name} value={branch.name}>
                            {branch.name}{branch.is_current ? " (current)" : ""}
                          </option>
                        ))
                      )}
                    </select>
                  </div>
                  <p className="text-xs text-[var(--color-text-muted)] mt-1.5">
                    The branch to merge into when the task is complete
                  </p>
                </div>

                {/* Notes */}
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-muted)] mb-2">
                    <div className="flex items-center gap-1.5">
                      <FileText className="w-4 h-4" />
                      <span>Notes</span>
                      <span className="text-xs font-normal">(optional)</span>
                    </div>
                  </label>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Describe the task, requirements, or any relevant context..."
                    rows={4}
                    className="w-full px-3 py-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg
                      text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] resize-none
                      focus:outline-none focus:border-[var(--color-highlight)] focus:ring-1 focus:ring-[var(--color-highlight)]
                      transition-all duration-200"
                  />
                </div>

                {/* Info */}
                <div className="p-3 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)]">
                  <p className="text-xs text-[var(--color-text-muted)]">
                    A new worktree will be created with branch{" "}
                    <code className="text-[var(--color-highlight)]">
                      feature/{taskName || "task-name"}
                    </code>{" "}
                    based on <code className="text-[var(--color-highlight)]">{targetBranch}</code>.
                  </p>
                </div>
              </div>

              {/* Actions */}
              <div className="flex justify-end gap-3 px-5 py-4 bg-[var(--color-bg)] border-t border-[var(--color-border)]">
                <Button variant="secondary" onClick={handleClose} disabled={isLoading}>
                  Cancel
                </Button>
                <Button onClick={handleSubmit} disabled={isLoading}>
                  <Plus className="w-4 h-4 mr-1.5" />
                  {isLoading ? "Creating..." : "Create Task"}
                </Button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
