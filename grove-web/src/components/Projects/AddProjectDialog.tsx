import { useState, useRef, useEffect } from "react";
import { motion } from "framer-motion";
import { X, Plus, FolderOpen, GitBranch, Sparkles, Code2, Globe } from "lucide-react";
import { Button } from "../ui";
import { DialogShell } from "../ui/DialogShell";
import { FolderTreePickerDialog } from "./FolderTreePickerDialog";
import { useIsMobile } from "../../hooks";
import { apiClient } from "../../api/client";
import { useCommand, useKeyboardScope } from "../../keyboard";

type ProjectMode = "coding" | "studio";
type CodingTab = "existing" | "new" | "git";

// Smart-parse a user-pasted string into a canonical git URL.
// Handles standard https URLs, SSH URLs, bare owner/repo shortcuts, and
// web UI URLs from GitHub/GitLab (tree, blob, pulls, merge_requests, etc.).
// Mirrors the logic in Skills/AddSourceDialog.tsx.
function parseGitInput(raw: string): { url: string; name?: string } {
  const input = raw.trim();
  if (!input) return { url: "" };
  if (input.length > 2000) return { url: "" };

  // HTTP/HTTPS URLs
  if (/^https?:\/\//i.test(input)) {
    try {
      const urlObj = new URL(input);
      let pathname = urlObj.pathname;

      // Look for web UI markers to split the repo URL from the rest of the path.
      // Matches: tree, blob, pulls, pull, issues, merge_requests, actions, etc.
      const markerMatch = pathname.match(
        /\/(?:-\/)?(?:tree|blob|pulls|pull|issues|issue|merge_requests|actions|projects|wiki|releases|tags|commits|commit|branches|milestones|settings)(?:\/|$)/i
      );

      if (markerMatch && markerMatch.index !== undefined && markerMatch.index > 0) {
        pathname = pathname.slice(0, markerMatch.index);
      }

      // Clean up trailing slash and any trailing .git (handling duplicate .git too)
      const cleanPathname = pathname.replace(/\/+$/, "").replace(/(?:\.git)+$/i, "");

      if (cleanPathname && cleanPathname !== "/") {
        urlObj.pathname = cleanPathname + ".git";
      } else {
        urlObj.pathname = cleanPathname;
      }

      // Clear out query parameters and hashes
      urlObj.search = "";
      urlObj.hash = "";

      // Derive repo name from the cleaned pathname
      const segments = cleanPathname.split("/").filter(Boolean);
      const name = segments.length > 0 ? segments[segments.length - 1] : undefined;

      return { url: urlObj.toString(), name };
    } catch {
      // Fallback if URL parsing fails
    }
  }

  // SSH form — leave as-is (already canonical, but clean up duplicate .git)
  if (/^git@[^:]+:[^/]+\/.+/.test(input)) {
    const cleanedSsh = input.replace(/\/+$/, "").replace(/(?:\.git)+$/i, "");
    const segments = cleanedSsh.split(/[/:]/).filter(Boolean);
    const name = segments.length > 0 ? segments[segments.length - 1].replace(/\.git$/, "") : undefined;
    return { url: `${cleanedSsh}.git`, name };
  }

  // Bare owner/repo shortcut
  const shortMatch = input.match(/^([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*?)(?:\.git)?$/);
  if (shortMatch) {
    return {
      url: `https://github.com/${shortMatch[1]}/${shortMatch[2]}.git`,
      name: shortMatch[2],
    };
  }

  return { url: input };
}

interface AddProjectDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (path: string, name?: string) => void | Promise<void>;
  onCreateNew: (parentDir: string, name: string, initGit: boolean, projectType?: string) => void | Promise<void>;
  onClone: (url: string, name?: string) => void | Promise<void>;
  isLoading?: boolean;
  externalError?: string | null;
  initialMode?: ProjectMode;
}

export function AddProjectDialog({
  isOpen,
  onClose,
  onAdd,
  onCreateNew,
  onClone,
  isLoading,
  externalError,
  initialMode = "coding",
}: AddProjectDialogProps) {
  const [mode, setMode] = useState<ProjectMode>(initialMode);
  const [codingTab, setCodingTab] = useState<CodingTab>("existing");

  // Existing-tab state. `existingNameTouched` flips to true once the user
  // edits the name field; until then, we keep auto-syncing it from the path.
  const [path, setPath] = useState("");
  const [existingName, setExistingName] = useState("");
  const [existingNameTouched, setExistingNameTouched] = useState(false);

  // New-tab state
  const [parentDir, setParentDir] = useState("");
  const [name, setName] = useState("");
  const [initGit, setInitGit] = useState(true);

  // Studio-tab state
  const [studioName, setStudioName] = useState("");

  // Git clone tab state. Same touched-pattern as existing tab.
  const [gitUrl, setGitUrl] = useState("");
  const [gitName, setGitName] = useState("");
  const [gitNameTouched, setGitNameTouched] = useState(false);

  const [error, setError] = useState("");
  const { isMobile } = useIsMobile();

  const [pickerOpen, setPickerOpen] = useState<null | "existing" | "parent">(null);

  const prevIsOpenRef = useRef(isOpen);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (isOpen && !prevIsOpenRef.current) {
      setMode(initialMode);
      setCodingTab("existing");
      setPath("");
      setExistingName("");
      setExistingNameTouched(false);
      setParentDir("");
      setName("");
      setInitGit(true);
      setStudioName("");
      setGitUrl("");
      setGitName("");
      setGitNameTouched(false);
      setError("");
      setPickerOpen(null);
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
    setExistingName("");
    setExistingNameTouched(false);
    setParentDir("");
    setName("");
    setInitGit(true);
    setStudioName("");
    setGitUrl("");
    setGitName("");
    setGitNameTouched(false);
    setError("");
    onClose();
  };

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!isOpen) return;
    setMode(initialMode);
    setCodingTab("existing");
    setError("");
  }, [initialMode, isOpen]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Auto-derive a project name from a filesystem path (last segment).
  const deriveNameFromPath = (p: string): string => {
    const trimmed = p.trim().replace(/\/+$/, "");
    if (!trimmed) return "";
    const parts = trimmed.split("/");
    return parts[parts.length - 1] ?? "";
  };

  // Auto-derive a project name from a git URL — uses parseGitInput to
  // handle web UI URLs (merge_requests, pulls, tree, etc.) properly.
  const deriveNameFromGitUrl = (u: string): string => {
    const parsed = parseGitInput(u);
    if (parsed.name) return parsed.name;
    // Fallback: last path segment
    const trimmed = (parsed.url || u).trim().replace(/\/+$/, "").replace(/(?:\.git)+$/i, "");
    const last = trimmed.split(/[/:]/).pop() ?? trimmed;
    return last;
  };

  const displayedExistingName = existingNameTouched ? existingName : deriveNameFromPath(path);
  const displayedGitName = gitNameTouched ? gitName : deriveNameFromGitUrl(gitUrl);

  // In remote/mobile mode the native dialog would open on the server's
  // physical screen (invisible to the remote user) and `Command::output()`
  // blocks until someone dismisses it on that screen — so the request hangs
  // and our "fallback when null/throw" path never triggers. Skip the native
  // call entirely in that mode and go straight to the web picker.
  // `window.__GROVE_REMOTE__` is set by AuthGate when `/api/v1/auth/info`
  // reports either `remote: true` or `required: true`.
  const isRemoteMode = (): boolean =>
    (window as unknown as Record<string, unknown>).__GROVE_REMOTE__ === true;

  // Use apiClient (not raw fetch) so HMAC headers are attached in mobile mode.
  const handleBrowseExisting = async () => {
    if (isRemoteMode()) {
      setPickerOpen("existing");
      return;
    }
    try {
      const data = await apiClient.get<{ path: string | null }>("/api/v1/browse-folder");
      if (data.path) {
        setPath(data.path);
        if (!existingNameTouched) setExistingName(deriveNameFromPath(data.path));
        setError("");
      } else {
        // Native dialog unavailable (headless host) — open web picker.
        setPickerOpen("existing");
      }
    } catch (err) {
      console.error("Failed to browse folder:", err);
      // Network/API failure — fall back to web picker rather than dead-ending.
      setPickerOpen("existing");
    }
  };

  const handleBrowseParent = async () => {
    if (isRemoteMode()) {
      setPickerOpen("parent");
      return;
    }
    try {
      const data = await apiClient.get<{ path: string | null }>("/api/v1/browse-folder");
      if (data.path) {
        setParentDir(data.path);
        setError("");
      } else {
        setPickerOpen("parent");
      }
    } catch (err) {
      console.error("Failed to browse folder:", err);
      setPickerOpen("parent");
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
    const finalName = displayedExistingName.trim();
    await onAdd(path.trim(), finalName || undefined);
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

  const handleSubmitGit = async () => {
    if (!gitUrl.trim()) {
      setError("Git URL is required");
      return;
    }
    // Normalize the URL before submitting — strip web UI paths, add .git suffix
    const parsed = parseGitInput(gitUrl);
    const finalUrl = parsed.url || gitUrl.trim();
    setError("");
    const finalName = (gitNameTouched ? gitName : parsed.name || deriveNameFromGitUrl(gitUrl)).trim();
    await onClone(finalUrl, finalName || undefined);
  };

  // Normalize git URL on blur so merge_requests/pulls/tree URLs become clone URLs
  const handleGitUrlBlur = () => {
    if (!gitUrl.trim()) return;
    const parsed = parseGitInput(gitUrl);
    if (parsed.url && parsed.url !== gitUrl.trim()) {
      setGitUrl(parsed.url);
      if (!gitNameTouched && parsed.name) {
        setGitName(parsed.name);
      }
    }
  };

  const handleSubmit = () => {
    if (mode === "studio") return handleSubmitStudio();
    if (codingTab === "existing") return handleSubmitExisting();
    if (codingTab === "git") return handleSubmitGit();
    return handleSubmitNew();
  };

  const submitLabel = () => {
    if (isLoading) {
      if (mode === "studio") return "Creating...";
      if (codingTab === "git") return "Cloning...";
      if (codingTab === "existing") return "Adding...";
      return "Creating...";
    }
    if (mode === "studio") return "Create Studio";
    if (codingTab === "git") return "Clone Project";
    if (codingTab === "existing") return "Add Project";
    return "Create Project";
  };

  // Catalog handlers register inside <AddProjectDialogBindings> only while
  // isOpen=true. Multiple AddProjectDialog wrappers can coexist (Workspace +
  // Projects pane); a top-level useCommand would otherwise overwrite each
  // other on every re-render — only the last-mounted dialog's binding
  // would be live.
  useKeyboardScope("dialog.addProject", isOpen);

  return (
    <>
    <DialogShell isOpen={isOpen} onClose={resetAndClose}>
      {isOpen && (
        <AddProjectDialogBindings
          onClose={resetAndClose}
          onSubmit={handleSubmit}
        />
      )}
      <div
        className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl shadow-xl overflow-hidden w-[480px] max-w-[95vw]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
          <h2 className="text-lg font-semibold text-[var(--color-text)]">New Project</h2>
          <button
            onClick={resetAndClose}
            disabled={isLoading}
            className="p-1.5 rounded-lg hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
              <TabButton
                active={codingTab === "git"}
                onClick={() => { setCodingTab("git"); setError(""); }}
                label="From Git"
              />
            </div>

            <div className="px-5 py-4 space-y-4">
              {codingTab === "git" ? (
                <>
                  <div>
                    <label className="block text-sm font-medium text-[var(--color-text-muted)] mb-2">
                      Git URL
                    </label>
                    <input
                      type="text"
                      value={gitUrl}
                      onChange={(e) => { setGitUrl(e.target.value); setError(""); }}
                      onBlur={handleGitUrlBlur}
                      placeholder="https://github.com/user/repo.git"
                      className={`w-full px-3 py-2 bg-[var(--color-bg)] border rounded-lg
                        text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]
                        focus:outline-none focus:ring-1 transition-all duration-200
                        ${error
                          ? "border-[var(--color-error)] focus:border-[var(--color-error)] focus:ring-[var(--color-error)]"
                          : "border-[var(--color-border)] focus:border-[var(--color-highlight)] focus:ring-[var(--color-highlight)]"
                        }`}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-[var(--color-text-muted)] mb-2">
                      Project Name
                    </label>
                    <input
                      type="text"
                      value={displayedGitName}
                      onChange={(e) => {
                        setGitName(e.target.value);
                        setGitNameTouched(true);
                        setError("");
                      }}
                      placeholder="Auto-derived from URL"
                      className="w-full px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg
                        text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]
                        focus:outline-none focus:border-[var(--color-highlight)] focus:ring-1 focus:ring-[var(--color-highlight)]
                        transition-all duration-200"
                    />
                  </div>
                  <div className="flex items-start gap-3 p-3 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)]">
                    <Globe className="w-4 h-4 text-[var(--color-highlight)] mt-0.5 flex-shrink-0" />
                    <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">
                      Clones into <code className="text-[var(--color-text)]">~/.grove/cloned/</code> and registers
                      it as a Grove project. HTTPS works with public repos; SSH URLs
                      require an active <code className="text-[var(--color-text)]">ssh-agent</code> with the
                      key loaded (interactive prompts are disabled and will fail fast).
                      Times out after 5 minutes.
                    </p>
                  </div>
                </>
              ) : codingTab === "existing" ? (
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
                  <div>
                    <label className="block text-sm font-medium text-[var(--color-text-muted)] mb-2">
                      Project Name
                    </label>
                    <input
                      type="text"
                      value={displayedExistingName}
                      onChange={(e) => {
                        setExistingName(e.target.value);
                        setExistingNameTouched(true);
                        setError("");
                      }}
                      placeholder="Auto-derived from path"
                      className="w-full px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg
                        text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]
                        focus:outline-none focus:border-[var(--color-highlight)] focus:ring-1 focus:ring-[var(--color-highlight)]
                        transition-all duration-200"
                    />
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
    <FolderTreePickerDialog
      isOpen={pickerOpen !== null}
      onClose={() => setPickerOpen(null)}
      onSelect={(p) => {
        if (pickerOpen === "existing") {
          setPath(p);
          if (!existingNameTouched) setExistingName(deriveNameFromPath(p));
        } else if (pickerOpen === "parent") {
          setParentDir(p);
        }
        setError("");
        setPickerOpen(null);
      }}
      title={pickerOpen === "parent" ? "Select Parent Directory" : "Select Project Folder"}
    />
    </>
  );
}

// Registers the dialog.addProject.* catalog handlers only while the dialog
// is actually open. See top-of-component comment for the multi-mount rationale.
function AddProjectDialogBindings({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: () => void | Promise<void>;
}) {
  useCommand("dialog.addProject.close", onClose, [onClose]);
  useCommand(
    "dialog.addProject.submit",
    () => {
      void onSubmit();
    },
    [onSubmit],
  );
  return null;
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
