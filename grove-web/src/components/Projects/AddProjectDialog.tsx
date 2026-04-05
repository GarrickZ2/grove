import { useState } from "react";
import { X, FolderGit2, Plus, FolderOpen, GitBranch } from "lucide-react";
import { Button } from "../ui";
import { DialogShell } from "../ui/DialogShell";
import { useIsMobile } from "../../hooks";

type TabKey = "existing" | "new";

interface AddProjectDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (path: string, name?: string) => void | Promise<void>;
  onCreateNew: (parentDir: string, name: string, initGit: boolean) => void | Promise<void>;
  isLoading?: boolean;
  externalError?: string | null;
}

export function AddProjectDialog({
  isOpen,
  onClose,
  onAdd,
  onCreateNew,
  isLoading,
  externalError,
}: AddProjectDialogProps) {
  const [tab, setTab] = useState<TabKey>("existing");

  // Existing-tab state
  const [path, setPath] = useState("");

  // New-tab state
  const [parentDir, setParentDir] = useState("");
  const [name, setName] = useState("");
  const [initGit, setInitGit] = useState(true);

  const [error, setError] = useState("");
  const { isMobile } = useIsMobile();

  const resetAndClose = () => {
    setTab("existing");
    setPath("");
    setParentDir("");
    setName("");
    setInitGit(true);
    setError("");
    onClose();
  };

  const handleBrowseExisting = async () => {
    try {
      const response = await fetch("/api/v1/browse-folder");
      if (response.ok) {
        const data = await response.json();
        if (data.path) {
          setPath(data.path);
          setError("");
        }
      }
    } catch (err) {
      console.error("Failed to browse folder:", err);
      setError("Failed to open folder picker");
    }
  };

  const handleBrowseParent = async () => {
    try {
      const response = await fetch("/api/v1/browse-folder");
      if (response.ok) {
        const data = await response.json();
        if (data.path) {
          setParentDir(data.path);
          setError("");
        }
      }
    } catch (err) {
      console.error("Failed to browse folder:", err);
      setError("Failed to open folder picker");
    }
  };

  const handleSubmitExisting = async () => {
    if (!path.trim()) {
      setError("Project path is required");
      return;
    }
    if (!path.startsWith("/") && !path.startsWith("~")) {
      setError("Please enter an absolute path (e.g., /Users/... or ~/...)");
      return;
    }
    setError("");
    await onAdd(path.trim());
  };

  const trimmedParent = parentDir.trim().replace(/\/+$/, "");
  const trimmedName = name.trim();
  const fullPath = trimmedParent && trimmedName ? `${trimmedParent}/${trimmedName}` : "";

  const handleSubmitNew = async () => {
    if (!trimmedParent) {
      setError("Parent directory is required");
      return;
    }
    if (!trimmedParent.startsWith("/") && !trimmedParent.startsWith("~")) {
      setError("Parent directory must be an absolute path");
      return;
    }
    if (!trimmedName) {
      setError("Project name is required");
      return;
    }
    if (/[/\\]/.test(trimmedName) || trimmedName.startsWith(".")) {
      setError("Invalid project name (no slashes or leading dots)");
      return;
    }
    setError("");
    await onCreateNew(trimmedParent, trimmedName, initGit);
  };

  const handleSubmit = () => {
    if (tab === "existing") {
      return handleSubmitExisting();
    }
    return handleSubmitNew();
  };

  const handleTabChange = (next: TabKey) => {
    setTab(next);
    setError("");
  };

  return (
    <DialogShell isOpen={isOpen} onClose={resetAndClose}>
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
            onClick={resetAndClose}
            className="p-1.5 rounded-lg hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-[var(--color-border)] px-5">
          <TabButton
            active={tab === "existing"}
            onClick={() => handleTabChange("existing")}
            label="Add Existing"
          />
          <TabButton
            active={tab === "new"}
            onClick={() => handleTabChange("new")}
            label="Create New"
          />
        </div>

        {/* Content */}
        <div className="px-5 py-4 space-y-4">
          {tab === "existing" ? (
            <>
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-muted)] mb-2">
                  Project Path
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={path}
                    onChange={(e) => {
                      setPath(e.target.value);
                      setError("");
                    }}
                    placeholder="/path/to/your/project"
                    className={`flex-1 px-3 py-2 bg-[var(--color-bg-secondary)] border rounded-lg
                      text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]
                      focus:outline-none focus:ring-1 transition-all duration-200
                      ${error
                        ? "border-[var(--color-error)] focus:border-[var(--color-error)] focus:ring-[var(--color-error)]"
                        : "border-[var(--color-border)] focus:border-[var(--color-highlight)] focus:ring-[var(--color-highlight)]"
                      }`}
                  />
                  {!isMobile && (
                    <Button variant="secondary" onClick={handleBrowseExisting} type="button">
                      <FolderOpen className="w-4 h-4 mr-1.5" />
                      Browse
                    </Button>
                  )}
                </div>
              </div>

              <div className="p-3 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)]">
                <p className="text-xs text-[var(--color-text-muted)]">
                  Register an existing folder as a Grove project. Git repositories get full
                  task support; non-git folders can be initialized later from the dashboard.
                </p>
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-muted)] mb-2">
                  Parent Directory
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={parentDir}
                    onChange={(e) => {
                      setParentDir(e.target.value);
                      setError("");
                    }}
                    placeholder="/Users/you/code"
                    className="flex-1 px-3 py-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg
                      text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]
                      focus:outline-none focus:border-[var(--color-highlight)] focus:ring-1 focus:ring-[var(--color-highlight)]
                      transition-all duration-200"
                  />
                  {!isMobile && (
                    <Button variant="secondary" onClick={handleBrowseParent} type="button">
                      <FolderOpen className="w-4 h-4 mr-1.5" />
                      Browse
                    </Button>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--color-text-muted)] mb-2">
                  Project Name
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setError("");
                  }}
                  placeholder="my-new-project"
                  className="w-full px-3 py-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg
                    text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]
                    focus:outline-none focus:border-[var(--color-highlight)] focus:ring-1 focus:ring-[var(--color-highlight)]
                    transition-all duration-200"
                />
                <p className="text-xs text-[var(--color-text-muted)] mt-1.5">
                  Used as both the directory name and the Grove project name.
                </p>
              </div>

              {fullPath && (
                <div className="p-3 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)]">
                  <p className="text-xs text-[var(--color-text-muted)] mb-1">Full path</p>
                  <p className="text-sm text-[var(--color-text)] font-mono break-all">{fullPath}</p>
                </div>
              )}

              <label className="flex items-start gap-3 p-3 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] cursor-pointer hover:border-[var(--color-highlight)]/50 transition-colors">
                <input
                  type="checkbox"
                  checked={initGit}
                  onChange={(e) => setInitGit(e.target.checked)}
                  className="mt-0.5 w-4 h-4 accent-[var(--color-highlight)] cursor-pointer"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-1.5 text-sm font-medium text-[var(--color-text)]">
                    <GitBranch className="w-3.5 h-3.5" />
                    Initialize as Git repository
                  </div>
                  <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
                    Runs <code className="text-[var(--color-text)]">git init</code> with an empty initial commit,
                    so Grove's task features are immediately usable.
                  </p>
                </div>
              </label>
            </>
          )}

          {(error || externalError) && (
            <p className="text-xs text-[var(--color-error)]">{error || externalError}</p>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3 px-5 py-4 bg-[var(--color-bg)] border-t border-[var(--color-border)]">
          <Button variant="secondary" onClick={resetAndClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isLoading}>
            <Plus className="w-4 h-4 mr-1.5" />
            {isLoading
              ? tab === "existing"
                ? "Adding..."
                : "Creating..."
              : tab === "existing"
                ? "Add Project"
                : "Create Project"}
          </Button>
        </div>
      </div>
    </DialogShell>
  );
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
        active
          ? "text-[var(--color-text)]"
          : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
      }`}
    >
      {label}
      {active && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--color-highlight)]" />
      )}
    </button>
  );
}
