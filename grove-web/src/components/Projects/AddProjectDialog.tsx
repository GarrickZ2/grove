import { useState } from "react";
import { X, FolderGit2, Plus, FolderOpen } from "lucide-react";
import { Button } from "../ui";
import { DialogShell } from "../ui/DialogShell";
import { useIsMobile } from "../../hooks";

interface AddProjectDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (path: string, name?: string) => void | Promise<void>;
  isLoading?: boolean;
  externalError?: string | null;
}

export function AddProjectDialog({ isOpen, onClose, onAdd, isLoading, externalError }: AddProjectDialogProps) {
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const { isMobile } = useIsMobile();

  const handleSubmit = async () => {
    if (!path.trim()) {
      setError("Project path is required");
      return;
    }

    // Basic path validation
    if (!path.startsWith("/") && !path.startsWith("~")) {
      setError("Please enter an absolute path (e.g., /Users/... or ~/...)");
      return;
    }

    setError("");
    await onAdd(path.trim());
  };

  const handleClose = () => {
    setPath("");
    setError("");
    onClose();
  };

  const handleBrowse = async () => {
    try {
      const response = await fetch("/api/v1/browse-folder");
      if (response.ok) {
        const data = await response.json();
        if (data.path) {
          setPath(data.path);
          setError("");
        }
      }
    } catch (error) {
      console.error("Failed to browse folder:", error);
      setError("Failed to open folder picker");
    }
  };

  return (
    <DialogShell isOpen={isOpen} onClose={handleClose}>
      <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl shadow-xl overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-[var(--color-highlight)]/10">
                    <FolderGit2 className="w-5 h-5 text-[var(--color-highlight)]" />
                  </div>
                  <h2 className="text-lg font-semibold text-[var(--color-text)]">Add Project</h2>
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
                {/* Path input with browse button */}
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-muted)] mb-2">
                    Project Path
                  </label>
                  <div className="flex gap-2">
                    <div className="flex-1 relative">
                      <input
                        type="text"
                        value={path}
                        onChange={(e) => {
                          setPath(e.target.value);
                          setError("");
                        }}
                        placeholder="/path/to/your/git/repository"
                        className={`w-full px-3 py-2 bg-[var(--color-bg-secondary)] border rounded-lg
                          text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]
                          focus:outline-none focus:ring-1 transition-all duration-200
                          ${error
                            ? "border-[var(--color-error)] focus:border-[var(--color-error)] focus:ring-[var(--color-error)]"
                            : "border-[var(--color-border)] focus:border-[var(--color-highlight)] focus:ring-[var(--color-highlight)]"
                          }`}
                      />
                    </div>
                    {!isMobile && (
                      <Button variant="secondary" onClick={handleBrowse} type="button">
                        <FolderOpen className="w-4 h-4 mr-1.5" />
                        Browse
                      </Button>
                    )}
                  </div>
                  {(error || externalError) && (
                    <p className="text-xs text-[var(--color-error)] mt-1.5">{error || externalError}</p>
                  )}
                </div>

                <div className="p-3 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)]">
                  <p className="text-xs text-[var(--color-text-muted)]">
                    {isMobile
                      ? "Enter the path to a local Git repository. Grove will manage worktrees and tasks for this project."
                      : "Enter the path to a local Git repository, or use Browse to select a folder. Grove will manage worktrees and tasks for this project."
                    }
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
                  {isLoading ? "Adding..." : "Add Project"}
                </Button>
              </div>
      </div>
    </DialogShell>
  );
}
