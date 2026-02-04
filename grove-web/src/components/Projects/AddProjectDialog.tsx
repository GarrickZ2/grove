import { useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, FolderGit2, Plus, FolderOpen } from "lucide-react";
import { Button } from "../ui";

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
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const handleBrowse = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      // In web, we can only get the directory name, not full path
      // This is a limitation of browser security
      // For a real desktop app, you'd use Electron/Tauri file dialog
      const dirName = files[0].webkitRelativePath.split("/")[0];
      setPath(`~/${dirName}`);
      setError("");
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
                {/* Hidden file input for directory selection */}
                <input
                  ref={fileInputRef}
                  type="file"
                  /* @ts-expect-error webkitdirectory is not in types */
                  webkitdirectory=""
                  className="hidden"
                  onChange={handleFileSelect}
                />

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
                    <Button variant="secondary" onClick={handleBrowse} type="button">
                      <FolderOpen className="w-4 h-4 mr-1.5" />
                      Browse
                    </Button>
                  </div>
                  {(error || externalError) && (
                    <p className="text-xs text-[var(--color-error)] mt-1.5">{error || externalError}</p>
                  )}
                </div>

                <div className="p-3 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)]">
                  <p className="text-xs text-[var(--color-text-muted)]">
                    Enter the path to a local Git repository, or use Browse to select a folder.
                    Grove will manage worktrees and tasks for this project.
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
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
