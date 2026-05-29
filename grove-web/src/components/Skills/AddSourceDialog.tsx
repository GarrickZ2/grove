import { useState } from "react";
import { X, GitBranch, FolderOpen } from "lucide-react";
import { Button } from "../ui";
import { DialogShell } from "../ui/DialogShell";
import { useIsMobile } from "../../hooks";
import { apiClient } from "../../api/client";
import { addSource, updateSource } from "../../api";
import type { SkillSource } from "../../api";
import { useCommand, useKeyboardScope } from "../../keyboard";

function extractNameFromUrl(url: string): string {
  let cleaned = url.trim();
  if (/^https?:\/\//i.test(cleaned)) {
    try {
      const parsed = parseGitInput(cleaned);
      if (parsed.url) {
        cleaned = parsed.url;
      }
    } catch {
      // ignore and use raw
    }
  }
  // Remove trailing slashes and any trailing .git (including multiple .git)
  cleaned = cleaned.replace(/\/+$/, "").replace(/(?:\.git)+$/i, "");
  // Split on delimiters (including ? and # to strip queries/fragments)
  const segments = cleaned.split(/[/:\\?#]/).filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : "";
}

// Smart-parse a user-pasted string into a canonical git URL (+ optional subpath).
// Handles:
//   - Standard https://github.com/<owner>/<repo>(.git)?
//   - SSH git@github.com:<owner>/<repo>(.git)?
//   - Bare shortcut <owner>/<repo>  →  https://github.com/<owner>/<repo>.git
//   - GitHub tree/blob URLs        →  base repo URL + subpath
//   - CLI-style "npx skills add <repo> [flags]" / "skills add <repo>"
function parseGitInput(raw: string): { url: string; subpath?: string } {
  let input = raw.trim();
  if (!input) return { url: "" };
  // Cap input length — the parsers below are cheap, but pathologically long
  // strings are almost never a legitimate git URL and could exercise
  // worst-case regex behaviour. Cheap to reject.
  if (input.length > 2000) return { url: "" };

  // Strip CLI command prefixes: "npx skills add X -y -g" → "X"
  const cliMatch = input.match(/^(?:npx\s+)?skills\s+add\s+(.+)$/i);
  if (cliMatch) {
    const tokens = cliMatch[1].split(/\s+/).filter((t) => t && !t.startsWith("-"));
    if (tokens.length > 0) input = tokens[0];
  }

  // HTTP/HTTPS URLs
  if (/^https?:\/\//i.test(input)) {
    try {
      const urlObj = new URL(input);
      let pathname = urlObj.pathname;

      // Look for web UI markers to split the repo URL and extract optional subpath.
      // Matches standard paths like tree, blob, pulls, issues, merge_requests, etc.
      const markerMatch = pathname.match(
        /\/(?:-\/)?(?:tree|blob|pulls|pull|issues|issue|merge_requests|actions|projects|wiki|releases|tags|commits|commit|branches|milestones|settings)(?:\/|$)/i
      );

      let subpath: string | undefined;

      if (markerMatch && markerMatch.index !== undefined && markerMatch.index > 0) {
        const repoPathname = pathname.slice(0, markerMatch.index);
        const marker = markerMatch[0];

        // Extract subpath only for tree/blob markers
        if (/\/tree\//i.test(marker) || /\/blob\//i.test(marker)) {
          const remaining = pathname.slice(markerMatch.index + marker.length);
          const parts = remaining.split("/").filter(Boolean);
          if (parts.length > 1) {
            subpath = parts.slice(1).join("/");
          }
        }

        pathname = repoPathname;
      }

      // Clean up trailing slash and any trailing .git (handling duplicate .git too)
      const cleanPathname = pathname.replace(/\/+$/, "").replace(/(?:\.git)+$/i, "");

      if (cleanPathname && cleanPathname !== "/") {
        urlObj.pathname = cleanPathname + ".git";
      } else {
        urlObj.pathname = cleanPathname;
      }

      // Clear out query parameters and hashes from the repository URL
      urlObj.search = "";
      urlObj.hash = "";

      return {
        url: urlObj.toString(),
        subpath: subpath || undefined,
      };
    } catch {
      // Fallback if URL parsing fails
    }
  }

  // SSH form — leave as-is (already canonical, but clean up duplicate .git)
  if (/^git@[^:]+:[^/]+\/.+/.test(input)) {
    const cleanedSsh = input.replace(/\/+$/, "").replace(/(?:\.git)+$/i, "");
    return { url: `${cleanedSsh}.git` };
  }

  // Bare owner/repo shortcut
  const shortMatch = input.match(/^([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*?)(?:\.git)?$/);
  if (shortMatch) {
    return { url: `https://github.com/${shortMatch[1]}/${shortMatch[2]}.git` };
  }

  return { url: input };
}

interface AddSourceDialogProps {
  isOpen: boolean;
  editingSource: SkillSource | null;
  onClose: () => void;
  onSaved: () => void;
}

export function AddSourceDialog({ isOpen, editingSource, onClose, onSaved }: AddSourceDialogProps) {
  const [name, setName] = useState("");
  const [sourceType, setSourceType] = useState<"git" | "local">("git");
  const [url, setUrl] = useState("");
  const [subpath, setSubpath] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [isNameAutoFilled, setIsNameAutoFilled] = useState(false);
  const { isMobile } = useIsMobile();

  const isEditing = editingSource !== null;

  // Sync form fields to (editingSource, isOpen) without setState-in-effect:
  // detect prop changes during render and reset state synchronously.
  const [prevSync, setPrevSync] = useState<{ source: SkillSource | null; open: boolean }>({ source: editingSource, open: isOpen });
  if (prevSync.source !== editingSource || prevSync.open !== isOpen) {
    setPrevSync({ source: editingSource, open: isOpen });
    if (editingSource) {
      setName(editingSource.name);
      setSourceType(editingSource.source_type);
      setUrl(editingSource.url);
      setSubpath(editingSource.subpath || "");
      setIsNameAutoFilled(false);
    } else {
      setName("");
      setSourceType("git");
      setUrl("");
      setSubpath("");
      setIsNameAutoFilled(false);
    }
    setError(null);
  }

  // Auto-fill name from URL when name is empty or was auto-filled. Moved
  // from useEffect into the URL onChange handler to avoid setState-in-effect
  // — observable behavior is unchanged: extract & set only when not editing
  // and the name is either empty or was auto-filled previously.
  const handleUrlChange = (value: string) => {
    setUrl(value);
    if (isEditing) return;
    if (!value.trim()) return;
    if (name && !isNameAutoFilled) return;
    const extracted = extractNameFromUrl(value);
    if (extracted) {
      setName(extracted);
      setIsNameAutoFilled(true);
    }
  };

  // Normalize on blur (git mode only) so the canonical form lands in the
  // field after the user finishes pasting/typing. Idempotent — safe to re-run.
  const handleUrlBlur = () => {
    if (sourceType !== "git") return;
    if (isEditing) return;
    if (!url.trim()) return;
    const parsed = parseGitInput(url);
    if (parsed.url && parsed.url !== url) {
      setUrl(parsed.url);
      if (!name || isNameAutoFilled) {
        const extracted = extractNameFromUrl(parsed.url);
        if (extracted) {
          setName(extracted);
          setIsNameAutoFilled(true);
        }
      }
    }
    if (parsed.subpath && !subpath.trim()) {
      setSubpath(parsed.subpath);
    }
  };

  // Catalog handlers register inside <AddSourceDialogBindings> only while
  // isOpen=true. Multiple AddSourceDialog wrappers can coexist (the Skills
  // page renders one per source row, all isOpen=false at rest); a top-level
  // useCommand would otherwise overwrite each other on every re-render —
  // only the last-mounted dialog's binding would be live.
  useKeyboardScope("dialog.addSource", isOpen);

  const handleBrowse = async () => {
    setIsBrowsing(true);
    try {
      // apiClient signs requests with HMAC in mobile mode; raw fetch would 401.
      const data = await apiClient.get<{ path: string | null }>("/api/v1/browse-folder");
      if (data.path) {
        handleUrlChange(data.path.replace(/\/+$/, ""));
      }
    } catch {
      // ignore — picker dismissed or unavailable
    }
    setIsBrowsing(false);
  };

  const handleSubmit = async () => {
    if (!name.trim()) { setError("Name is required"); return; }
    if (!url.trim()) { setError(sourceType === "git" ? "Repository URL is required" : "Path is required"); return; }

    setIsSaving(true);
    setError(null);
    let finalUrl = url.trim();
    let finalSubpath = subpath.trim();
    if (sourceType === "git" && !isEditing) {
      const parsed = parseGitInput(finalUrl);
      if (parsed.url) finalUrl = parsed.url;
      if (parsed.subpath && !finalSubpath) finalSubpath = parsed.subpath;
    }
    const req = {
      name: name.trim(),
      source_type: sourceType,
      url: finalUrl,
      subpath: finalSubpath ? finalSubpath : undefined,
    };
    let saveErr: unknown = null;
    try {
      if (isEditing) {
        await updateSource(editingSource!.name, req);
      } else {
        await addSource(req);
      }
    } catch (err) {
      saveErr = err;
    }
    if (saveErr !== null) {
      setError(saveErr instanceof Error ? saveErr.message : "Failed to save source");
    } else {
      onSaved();
    }
    setIsSaving(false);
  };

  return (
    <DialogShell isOpen={isOpen} onClose={onClose} maxWidth="max-w-lg">
      {isOpen && (
        <AddSourceDialogBindings
          onClose={onClose}
          onSubmit={handleSubmit}
        />
      )}
      <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl shadow-xl overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
                <h2 className="text-lg font-semibold text-[var(--color-text)]">
                  {isEditing ? "Edit Source" : "Add Source"}
                </h2>
                <button
                  onClick={onClose}
                  className="p-1.5 rounded-lg hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Form */}
              <div className="px-5 py-4 space-y-4">
                {/* Name */}
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1.5">
                    Name
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => { setName(e.target.value); setIsNameAutoFilled(false); }}
                    placeholder="Auto-filled from URL"
                    disabled={isEditing}
                    className="w-full px-3 py-2 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)] disabled:opacity-50"
                  />
                </div>

                {/* Type Toggle */}
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1.5">
                    Type
                  </label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setSourceType("git")}
                      className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-lg border transition-colors ${
                        sourceType === "git"
                          ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
                          : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-text-muted)]"
                      }`}
                    >
                      <GitBranch className="w-4 h-4" />
                      Git
                    </button>
                    <button
                      onClick={() => setSourceType("local")}
                      className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-lg border transition-colors ${
                        sourceType === "local"
                          ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
                          : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-text-muted)]"
                      }`}
                    >
                      <FolderOpen className="w-4 h-4" />
                      Local
                    </button>
                  </div>
                </div>

                {/* URL / Path */}
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1.5">
                    {sourceType === "git" ? "Repository URL" : "Local Path"}
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={url}
                      onChange={(e) => handleUrlChange(e.target.value)}
                      onBlur={handleUrlBlur}
                      placeholder={
                        sourceType === "git"
                          ? "URL · owner/repo · npx skills add ..."
                          : "/home/user/my-skills"
                      }
                      className="flex-1 px-3 py-2 text-sm font-mono bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)]"
                    />
                    {sourceType === "local" && !isMobile && (
                      <Button variant="secondary" onClick={handleBrowse} disabled={isBrowsing}>
                        <FolderOpen className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                </div>

                {/* Subpath */}
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1.5">
                    Subpath <span className="text-[var(--color-text-muted)]/50">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={subpath}
                    onChange={(e) => setSubpath(e.target.value)}
                    placeholder="e.g., skills/coding"
                    className="w-full px-3 py-2 text-sm font-mono bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)]"
                  />
                  <p className="text-[10px] text-[var(--color-text-muted)] mt-1">
                    Only scan skills from this subdirectory within the repository.
                  </p>
                </div>

                {error && (
                  <p className="text-xs text-[var(--color-error)]">{error}</p>
                )}
              </div>

              {/* Actions */}
              <div className="flex justify-end gap-3 px-5 py-4 bg-[var(--color-bg)] border-t border-[var(--color-border)]">
                <Button variant="secondary" onClick={onClose}>Cancel</Button>
                <Button variant="primary" onClick={handleSubmit} disabled={isSaving}>
                  {isSaving ? "Saving..." : isEditing ? "Save" : "Add Source"}
                </Button>
              </div>
      </div>
    </DialogShell>
  );
}

// Registers the dialog.addSource.* catalog handlers only while the dialog
// is actually open. See top-of-component comment for the multi-mount rationale.
function AddSourceDialogBindings({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: () => Promise<void>;
}) {
  useCommand("dialog.addSource.close", onClose, [onClose]);
  useCommand(
    "dialog.addSource.submit",
    () => {
      void onSubmit();
    },
    [onSubmit],
  );
  return null;
}
