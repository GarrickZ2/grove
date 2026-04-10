import { useState, useEffect, useRef, useCallback } from "react";
import { X, GitBranch, Plus, FileText, ChevronDown, Loader2 } from "lucide-react";
import { Button, Input } from "../ui";
import { DialogShell } from "../ui/DialogShell";
import { useProject } from "../../context";
import { previewBranchName } from "../../utils/branch";
import { getBranches } from "../../api";

interface NewTaskDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (name: string, targetBranch: string, notes: string) => void | Promise<void>;
  isLoading?: boolean;
  externalError?: string | null;
}

export function NewTaskDialog({ isOpen, onClose, onCreate, isLoading, externalError }: NewTaskDialogProps) {
  const { selectedProject } = useProject();
  const isStudio = selectedProject?.projectType === "studio";
  const [taskName, setTaskName] = useState("");
  const [targetBranch, setTargetBranch] = useState(selectedProject?.currentBranch || "main");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [showBranchDropdown, setShowBranchDropdown] = useState(false);
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Load branches and reset target when dialog opens (skip for Studio)
  useEffect(() => {
    if (isOpen && selectedProject && !isStudio) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTargetBranch(selectedProject.currentBranch || "main");

      setIsLoadingBranches(true);
      getBranches(selectedProject.id, "local")
        .then((res) => {
          setBranches(res.branches.map((b) => b.name));
        })
        .catch(() => {
          setBranches([]);
        })
        .finally(() => {
          setIsLoadingBranches(false);
        });
    }
  }, [isOpen, selectedProject, isStudio]);

  // Click outside to close dropdown
  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
      setShowBranchDropdown(false);
    }
  }, []);

  useEffect(() => {
    if (showBranchDropdown) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [showBranchDropdown, handleClickOutside]);

  const handleSubmit = async () => {
    if (!isStudio && !hasValidBranch) return;

    // Validate task name
    if (!taskName.trim()) {
      setError("Task name is required");
      return;
    }

    setError("");
    await onCreate(taskName.trim(), isStudio ? "" : targetBranch, notes.trim());
  };

  const handleClose = () => {
    setTaskName("");
    setTargetBranch(selectedProject?.currentBranch || "main");
    setNotes("");
    setError("");
    setShowBranchDropdown(false);
    onClose();
  };

  // Keyboard shortcuts: Escape to close, Alt+Enter to submit
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (showBranchDropdown) {
          setShowBranchDropdown(false);
        } else {
          handleClose();
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSubmit();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  // Detect empty repo (no commits → currentBranch is "unknown") — Studio always valid
  const hasValidBranch = isStudio || (!!selectedProject?.currentBranch && selectedProject.currentBranch !== "unknown");

  // Generate branch preview
  const branchPreview = previewBranchName(taskName);

  return (
    <DialogShell isOpen={isOpen} onClose={handleClose}>
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
                  placeholder="fix/auth-bug or feature/new-feature"
                  autoFocus
                  value={taskName}
                  onChange={(e) => {
                    setTaskName(e.target.value);
                    setError("");
                  }}
                  error={error || externalError || undefined}
                  className="!bg-[var(--color-bg)]"
                />

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
                    className="w-full px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg
                      text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] resize-none
                      focus:outline-none focus:border-[var(--color-highlight)] focus:ring-1 focus:ring-[var(--color-highlight)]
                      transition-all duration-200"
                  />
                </div>

                {/* Target Branch (selectable) — hidden for Studio */}
                {!isStudio && (
                  <div className="relative" ref={dropdownRef}>
                    <label className="block text-sm font-medium text-[var(--color-text-muted)] mb-2">
                      Target Branch
                    </label>
                    {hasValidBranch ? (
                      <>
                        <button
                          type="button"
                          onClick={() => setShowBranchDropdown(!showBranchDropdown)}
                          className="w-full flex items-center justify-between gap-2 px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg
                            hover:border-[var(--color-highlight)] transition-colors text-left"
                        >
                          <div className="flex items-center gap-2">
                            <GitBranch className="w-4 h-4 text-[var(--color-text-muted)]" />
                            <span className="text-sm text-[var(--color-text)]">{targetBranch}</span>
                          </div>
                          {isLoadingBranches ? (
                            <Loader2 className="w-4 h-4 text-[var(--color-text-muted)] animate-spin" />
                          ) : (
                            <ChevronDown className={`w-4 h-4 text-[var(--color-text-muted)] transition-transform ${showBranchDropdown ? "rotate-180" : ""}`} />
                          )}
                        </button>
                        {showBranchDropdown && (
                          <div className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg shadow-lg">
                            {isLoadingBranches ? (
                              <div className="flex items-center justify-center gap-2 px-3 py-3 text-sm text-[var(--color-text-muted)]">
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                <span>Loading branches...</span>
                              </div>
                            ) : branches.length > 0 ? (
                              branches.map((branch) => (
                                <button
                                  key={branch}
                                  type="button"
                                  onClick={() => {
                                    setTargetBranch(branch);
                                    setShowBranchDropdown(false);
                                  }}
                                  className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-[var(--color-bg-tertiary)] transition-colors
                                    ${branch === targetBranch ? "text-[var(--color-highlight)] bg-[var(--color-highlight)]/5" : "text-[var(--color-text)]"}`}
                                >
                                  <GitBranch className="w-3.5 h-3.5 flex-shrink-0" />
                                  <span className="truncate">{branch}</span>
                                  {branch === selectedProject?.currentBranch && (
                                    <span className="ml-auto text-xs text-[var(--color-text-muted)] flex-shrink-0">current</span>
                                  )}
                                </button>
                              ))
                            ) : (
                              <div className="px-3 py-2 text-sm text-[var(--color-text-muted)]">
                                No branches found
                              </div>
                            )}
                          </div>
                        )}
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5">
                          New branch will be created from this branch
                        </p>
                      </>
                    ) : (
                      <div className="flex items-center gap-2 px-3 py-2 bg-red-500/5 border border-red-500/30 rounded-lg">
                        <GitBranch className="w-4 h-4 text-red-400" />
                        <span className="text-sm text-red-400">No valid branch found</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Info */}
                {isStudio ? (
                  <div className="p-3 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                    <p className="text-xs text-[var(--color-text-muted)]">
                      A new task workspace will be created with input, output, and scripts folders.
                    </p>
                  </div>
                ) : hasValidBranch ? (
                  <div className="p-3 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                    <p className="text-xs text-[var(--color-text-muted)]">
                      A new worktree will be created with branch{" "}
                      <code className="text-[var(--color-highlight)]">
                        {branchPreview}
                      </code>{" "}
                      based on <code className="text-[var(--color-highlight)]">{targetBranch}</code>.
                    </p>
                  </div>
                ) : (
                  <div className="p-3 rounded-lg bg-red-500/5 border border-red-500/30">
                    <p className="text-xs text-red-400">
                      This repository has no commits yet. Please create an initial commit before creating tasks.
                    </p>
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center justify-between px-5 py-4 bg-[var(--color-bg)] border-t border-[var(--color-border)]">
                <p className="text-xs text-[var(--color-text-muted)]">
                  <kbd className="px-1 py-0.5 text-[10px] font-mono rounded border bg-[var(--color-bg-secondary)] border-[var(--color-border)]">⌘</kbd>
                  {" + "}
                  <kbd className="px-1 py-0.5 text-[10px] font-mono rounded border bg-[var(--color-bg-secondary)] border-[var(--color-border)]">Enter</kbd>
                  {" to create"}
                </p>
                <div className="flex gap-3">
                  <Button variant="secondary" onClick={handleClose} disabled={isLoading}>
                    Cancel
                  </Button>
                  <Button onClick={handleSubmit} disabled={isLoading || (!isStudio && !hasValidBranch)}>
                    <Plus className="w-4 h-4 mr-1.5" />
                    {isLoading ? "Creating..." : "Create Task"}
                  </Button>
                </div>
              </div>
      </div>
    </DialogShell>
  );
}
