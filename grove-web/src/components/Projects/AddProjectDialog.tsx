import { useState, useRef, useEffect } from "react";
import { motion } from "framer-motion";
import { X, Plus, FolderOpen, GitBranch, Sparkles, Code2 } from "lucide-react";
import { Button } from "../ui";
import { DialogShell } from "../ui/DialogShell";
import { useIsMobile } from "../../hooks";

type ProjectMode = "coding" | "studio";
type CodingTab = "existing" | "new";

interface AddProjectDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (path: string, name?: string) => void | Promise<void>;
  onCreateNew: (parentDir: string, name: string, initGit: boolean, projectType?: string) => void | Promise<void>;
  isLoading?: boolean;
  externalError?: string | null;
  initialMode?: ProjectMode;
}

export function AddProjectDialog({
  isOpen,
  onClose,
  onAdd,
  onCreateNew,
  isLoading,
  externalError,
  initialMode = "coding",
}: AddProjectDialogProps) {
  const [mode, setMode] = useState<ProjectMode>(initialMode);
  const [codingTab, setCodingTab] = useState<CodingTab>("existing");

  // Existing-tab state
  const [path, setPath] = useState("");

  // New-tab state
  const [parentDir, setParentDir] = useState("");
  const [name, setName] = useState("");
  const [initGit, setInitGit] = useState(true);

  // Studio-tab state
  const [studioName, setStudioName] = useState("");

  const [error, setError] = useState("");
  const { isMobile } = useIsMobile();

  const prevIsOpenRef = useRef(isOpen);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (isOpen && !prevIsOpenRef.current) {
      setMode(initialMode);
      setCodingTab("existing");
      setError("");
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, initialMode]);

  useEffect(() => {
    if (isOpen) {
      setMode(initialMode);
      setError("");
    }
  }, [initialMode, isOpen]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const resetAndClose = () => {
    setMode(initialMode);
    setCodingTab("existing");
    setPath("");
    setParentDir("");
    setName("");
    setInitGit(true);
    setStudioName("");
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

  const handleSubmitStudio = async () => {
    const trimmed = studioName.trim();
    if (!trimmed) {
      setError("Studio name is required");
      return;
    }
    setError("");
    await onCreateNew("", trimmed, false, "studio");
  };

  const handleSubmit = () => {
    if (mode === "studio") return handleSubmitStudio();
    if (codingTab === "existing") return handleSubmitExisting();
    return handleSubmitNew();
  };

  const submitLabel = () => {
    if (isLoading) return mode === "studio" ? "Creating..." : codingTab === "existing" ? "Adding..." : "Creating...";
    if (mode === "studio") return "Create Studio";
    if (codingTab === "existing") return "Add Project";
    return "Create Project";
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <DialogShell isOpen={isOpen} onClose={resetAndClose}>
      <div
        onKeyDown={handleKeyDown}
        className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl shadow-xl overflow-hidden w-[480px] max-w-[95vw]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
          <h2 className="text-lg font-semibold text-[var(--color-text)]">New Project</h2>
          <button
            onClick={resetAndClose}
            className="p-1.5 rounded-lg hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Mode cards */}
        <div className="px-5 pt-4 pb-2">
          <div className="grid grid-cols-2 gap-3">
            <ModeCard
              active={mode === "coding"}
              onClick={() => { setMode("coding"); setError(""); }}
              icon={<Code2 className="w-5 h-5" />}
              iconBg="bg-blue-500/10"
              iconColor="text-blue-400"
              title="Coding"
              description="Git repos & local folders"
            />
            <ModeCard
              active={mode === "studio"}
              onClick={() => { setMode("studio"); setError(""); }}
              icon={<Sparkles className="w-5 h-5" />}
              iconBg="bg-[var(--color-highlight)]/10"
              iconColor="text-[var(--color-highlight)]"
              title="Studio"
              description="AI agent workspace"
            />
          </div>
        </div>

        {/* Form area — animated height with min-height to prevent jarring shrinks */}
        <FormArea mode={mode} codingTab={codingTab}>
        {mode === "studio" ? (
          <div className="px-5 py-4 space-y-4">
            <div>
              <label className="block text-sm font-medium text-[var(--color-text-muted)] mb-2">
                Studio Name
              </label>
              <input
                type="text"
                value={studioName}
                onChange={(e) => { setStudioName(e.target.value); setError(""); }}
                placeholder="My AI Workspace"
                className={`w-full px-3 py-2.5 bg-[var(--color-bg)] border rounded-lg
                  text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]
                  focus:outline-none focus:ring-1 transition-all duration-200
                  ${error
                    ? "border-[var(--color-error)] focus:border-[var(--color-error)] focus:ring-[var(--color-error)]"
                    : "border-[var(--color-border)] focus:border-[var(--color-highlight)] focus:ring-[var(--color-highlight)]"
                  }`}
              />
            </div>
            <div className="flex items-start gap-3 p-3 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)]">
              <Sparkles className="w-4 h-4 text-[var(--color-highlight)] mt-0.5 flex-shrink-0" />
              <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">
                Upload files, chat with AI agents, and get results — perfect for data
                analysis, document processing, and report generation.
              </p>
            </div>
            {(error || externalError) && (
              <p className="text-xs text-[var(--color-error)]">{error || externalError}</p>
            )}
          </div>
        ) : (
          <>
            {/* Coding sub-tabs */}
            <div className="flex border-b border-[var(--color-border)] px-5">
              <TabButton
                active={codingTab === "existing"}
                onClick={() => { setCodingTab("existing"); setError(""); }}
                label="Add Existing"
              />
              <TabButton
                active={codingTab === "new"}
                onClick={() => { setCodingTab("new"); setError(""); }}
                label="Create New"
              />
            </div>

            <div className="px-5 py-4 space-y-4">
              {codingTab === "existing" ? (
                <>
                  <div>
                    <label className="block text-sm font-medium text-[var(--color-text-muted)] mb-2">
                      Project Path
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={path}
                        onChange={(e) => { setPath(e.target.value); setError(""); }}
                        placeholder="/path/to/your/project"
                        className={`flex-1 px-3 py-2 bg-[var(--color-bg)] border rounded-lg
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
                      task support; non-git folders can be initialized later.
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
                        onChange={(e) => { setParentDir(e.target.value); setError(""); }}
                        placeholder="/Users/you/code"
                        className="flex-1 px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg
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
                      onChange={(e) => { setName(e.target.value); setError(""); }}
                      placeholder="my-new-project"
                      className="w-full px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg
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
                        Runs <code className="text-[var(--color-text)]">git init</code> with an empty initial commit.
                      </p>
                    </div>
                  </label>
                </>
              )}
              {(error || externalError) && (
                <p className="text-xs text-[var(--color-error)]">{error || externalError}</p>
              )}
            </div>
          </>
        )}
        </FormArea>

        {/* Actions */}
        <div className="flex justify-end gap-3 px-5 py-4 bg-[var(--color-bg)] border-t border-[var(--color-border)]">
          <Button variant="secondary" onClick={resetAndClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isLoading}>
            <Plus className="w-4 h-4 mr-1.5" />
            {submitLabel()}
          </Button>
        </div>
      </div>
    </DialogShell>
  );
}

/** Wrapper that animates height changes smoothly and enforces a min-height */
function FormArea({
  mode,
  codingTab,
  children,
}: {
  mode: string;
  codingTab: string;
  children: React.ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | "auto">("auto");

  // Measure content height on every mode/tab change
  useEffect(() => {
    if (contentRef.current) {
      setHeight(contentRef.current.scrollHeight);
    }
  }, [mode, codingTab]);

  return (
    <motion.div
      animate={{ height: typeof height === "number" ? height : "auto" }}
      transition={{ duration: 0.2, ease: "easeInOut" }}
      className="overflow-hidden"
    >
      <div ref={contentRef}>
        {children}
      </div>
    </motion.div>
  );
}

function ModeCard({
  active,
  onClick,
  icon,
  iconBg,
  iconColor,
  title,
  description,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  iconBg: string;
  iconColor: string;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left p-3.5 rounded-xl border transition-all duration-200 cursor-pointer flex items-center gap-3
        ${active
          ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/5 ring-1 ring-[var(--color-highlight)]"
          : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-text-muted)]/30"
        }`}
    >
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${iconBg}`}>
        <span className={iconColor}>{icon}</span>
      </div>
      <div className="min-w-0">
        <div className="font-medium text-sm text-[var(--color-text)]">{title}</div>
        <p className="text-xs text-[var(--color-text-muted)] truncate">{description}</p>
      </div>
    </button>
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
