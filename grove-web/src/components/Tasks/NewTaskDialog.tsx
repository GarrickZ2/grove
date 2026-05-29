import { useState, useEffect, useRef, useCallback } from "react";
import { X, GitBranch, Plus, FileText, ChevronDown, Loader2 } from "lucide-react";
import { Button, Input } from "../ui";
import { DialogShell } from "../ui/DialogShell";
import { useProject } from "../../context";
import { previewBranchName } from "../../utils/branch";
import { getBranches } from "../../api";
import { useCommand, useContextKey, useKeyboardScope } from "../../keyboard";

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

  const [isDragging, setIsDragging] = useState(false);

  // Mirror the ACP Chat drop-handler pattern (TaskChat.tsx:5388-5403):
  // `dragover` fires continuously while the cursor hovers the target, so we
  // toggle `isDragging` from there. `dragenter` + counter is fragile across
  // browsers (some browsers strip `dataTransfer.items` on enter for security
  // reasons, so length is 0 and `isDragging` never flips true). Leave uses
  // the `currentTarget.contains(relatedTarget)` trick to ignore enters into
  // child nodes — otherwise hovering over the inner overlay would toggle.
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragging(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      const file = files[0];
      const fileName = file.name.toLowerCase();
      if (
        fileName.endsWith(".md") ||
        fileName.endsWith(".markdown") ||
        fileName.endsWith(".txt") ||
        file.type === "text/markdown" ||
        file.type === "text/plain"
      ) {
        const reader = new FileReader();
        reader.onload = (event) => {
          const content = event.target?.result;
          if (typeof content !== "string") return;
          setNotes(content);
          // Auto-derive a task name from the document's first non-empty
          // line when the user hasn't typed one yet. Strips Markdown
          // heading markers from both ends (`# Title` and the rare
          // closing-`#` style `# Title #`) and surrounding whitespace.
          // We use a functional setState so we read the latest taskName
          // even though the FileReader callback closes over stale state.
          const firstMeaningful = content
            .split(/\r?\n/)
            .map((line) =>
              line
                .trim()
                .replace(/^#+\s*/, "")
                .replace(/\s*#+$/, "")
                .trim(),
            )
            .find((s) => s.length > 0);
          if (firstMeaningful) {
            setTaskName((prev) => (prev.trim() ? prev : firstMeaningful));
          }
        };
        reader.readAsText(file);
      }
    }
  }, []);


  // Load branches when dialog opens.
  // Form state (taskName / notes / error / dropdown / dragging) is reset by
  // the parent's `key={isOpen ? "open" : "closed"}` remount — useState
  // defaults take over, so no manual reset here. That also keeps the user's
  // in-progress input safe when `selectedProject` changes mid-dialog.
  useEffect(() => {
    if (!isOpen || !selectedProject || isStudio) return;
    /* eslint-disable react-hooks/set-state-in-effect --
     * setting branch and async-loading branch list on open. */
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
    /* eslint-enable react-hooks/set-state-in-effect */
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
    setIsDragging(false);
    onClose();
  };

  // Detect empty repo (no commits → currentBranch is "unknown") — Studio always valid
  const hasValidBranch = isStudio || (!!selectedProject?.currentBranch && selectedProject.currentBranch !== "unknown");

  // Keyboard shortcuts: Escape to close (or close branch dropdown first), Cmd/Ctrl+Enter to submit.
  // The catalog binding for dialog.newTask.submit gates on `taskNameValid`. Original behavior
  // surfaced the "Task name is required" inline error on empty-name submit, so we publish the
  // context key as just "dialog is open" — handleSubmit itself does the validation + error.
  //
  // Catalog handlers register inside <NewTaskDialogBindings>, which only
  // mounts while isOpen=true. Multiple NewTaskDialog wrappers can be
  // mounted simultaneously (all but one with isOpen=false); a top-level
  // useCommand would otherwise overwrite each other on every re-render —
  // only the last-mounted dialog's binding would be live.
  useKeyboardScope("dialog.newTask", isOpen);
  useContextKey("taskNameValid", isOpen);

  const handleCancelOrCloseDropdown = () => {
    if (showBranchDropdown) {
      setShowBranchDropdown(false);
    } else {
      handleClose();
    }
  };

  // Generate branch preview
  const branchPreview = previewBranchName(taskName);

  return (
    <DialogShell isOpen={isOpen} onClose={handleClose}>
      {isOpen && (
        <NewTaskDialogBindings
          onClose={handleCancelOrCloseDropdown}
          onSubmit={handleSubmit}
        />
      )}
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
                  {/* Drop zone container. Styling mirrors TaskChat's chatbox
                      drop-active treatment (TaskView/task-chat.css) — a
                      subtle ring on the container plus an absolutely-
                      positioned overlay with an animated dashed border and
                      a pop-in inner pill. The overlay uses
                      `pointer-events-none` so the textarea below it still
                      receives the eventual `drop`. */}
                  <div
                    className={`relative rounded-lg transition-shadow duration-150 ${
                      isDragging
                        ? "shadow-[0_0_0_1px_var(--color-highlight),0_0_0_6px_color-mix(in_srgb,var(--color-highlight)_14%,transparent)]"
                        : ""
                    }`}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                  >
                    <textarea
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="Describe the task, requirements, or any relevant context...  (or drop a .md / .txt file)"
                      rows={4}
                      className={`w-full px-3 py-2 bg-[var(--color-bg)] border rounded-lg
                        text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] resize-none
                        focus:outline-none focus:ring-1 transition-colors duration-200
                        ${
                          isDragging
                            ? "border-[var(--color-highlight)] ring-1 ring-[var(--color-highlight)]"
                            : "border-[var(--color-border)] focus:border-[var(--color-highlight)] focus:ring-[var(--color-highlight)]"
                        }`}
                    />
                    {isDragging && (
                      <div
                        aria-hidden
                        className="absolute inset-0 rounded-lg pointer-events-none flex items-center justify-center
                                   bg-[color-mix(in_srgb,var(--color-highlight)_8%,transparent)]
                                   backdrop-blur-[2px]"
                        style={{ animation: "dropFadeIn 120ms ease-out" }}
                      >
                        {/* Dashed ring inset slightly so it sits cleanly
                            inside the textarea's own border. */}
                        <div className="absolute inset-[3px] rounded-md border-[1.5px] border-dashed
                                        border-[color-mix(in_srgb,var(--color-highlight)_75%,transparent)]" />
                        <div
                          className="relative inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full
                                     bg-[color-mix(in_srgb,var(--color-bg)_92%,transparent)]
                                     text-[var(--color-highlight)] text-xs font-semibold
                                     shadow-[0_8px_24px_rgba(0,0,0,0.18),0_0_0_1px_color-mix(in_srgb,var(--color-highlight)_35%,transparent)]"
                          style={{ animation: "dropPop 180ms cubic-bezier(0.2, 0.9, 0.3, 1.2)" }}
                        >
                          <FileText className="w-3.5 h-3.5" />
                          <span>Drop a Markdown file to fill notes</span>
                        </div>
                      </div>
                    )}
                  </div>
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

// Registers the dialog.newTask.* catalog handlers only while the dialog is
// actually open. See top-of-component comment for the multi-mount rationale.
function NewTaskDialogBindings({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: () => Promise<void>;
}) {
  useCommand("dialog.newTask.close", onClose, [onClose]);
  useCommand(
    "dialog.newTask.submit",
    () => {
      void onSubmit();
    },
    [onSubmit],
  );
  return null;
}
