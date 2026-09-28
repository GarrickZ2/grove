import { useRef, useState, type DragEvent } from "react";
import { CheckCircle2, Code, FileArchive, FolderOpen, GitBranch, Sparkles, Terminal, X } from "lucide-react";
import { Button, DialogShell } from "../ui";
import {
  installLocalPlugin,
  installGitPlugin,
  installZipPlugin,
  registerDevPlugin,
  scaffoldPlugin,
} from "../../api/plugins";
import { parseGitInput } from "../../utils/gitUrl";
import { useBrowseFolder } from "../Projects/useBrowseFolder";

type Mode = "local" | "git" | "dev" | "create";

const MODE_META: Record<Mode, { label: string; icon: typeof Terminal }> = {
  local: { label: "Local package", icon: Terminal },
  git: { label: "Git repository", icon: GitBranch },
  dev: { label: "Development folder", icon: Code },
  create: { label: "Create new", icon: Sparkles },
};

/**
 * Unified Plugin entry point:
 *   - local: drop a .zip (auto-extracted) or pick a folder — copied into Grove
 *   - git:   clone any git repo (optional subpath) into Grove's storage
 *   - dev:   register an existing folder in place (referenced, hot-reload)
 *   - create: scaffold a new plugin and register it as development source
 */
export function AddPluginDialog({ onClose }: { onClose: () => void }) {
  const { browseFolder, folderPicker } = useBrowseFolder("Select Plugin Folder");
  const [mode, setMode] = useState<Mode>("local");
  const [gitUrl, setGitUrl] = useState("");
  const [subpath, setSubpath] = useState("");
  const [newPluginName, setNewPluginName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [done, setDone] = useState<{
    name: string;
    warning?: string | null;
    path?: string;
    next?: string;
  } | null>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);

  const pickFolderThen = async (
    install: (path: string) => Promise<{ plugin: { name: string }; warning?: string | null }>,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const path = await browseFolder();
      if (!path) {
        setBusy(false);
        return; // cancelled
      }
      const res = await install(path);
      setDone({ name: res.plugin.name, warning: res.warning });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleLocal = () => pickFolderThen(installLocalPlugin);
  const handleDev = () => pickFolderThen(registerDevPlugin);

  const handleCreate = async () => {
    const trimmed = newPluginName.trim();
    if (!trimmed) {
      setError("Enter a plugin name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const path = await browseFolder();
      if (!path) return;
      const result = await scaffoldPlugin(path, trimmed);
      setDone({ name: result.name, path: result.path, next: result.next });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleZipFile = async (file: File) => {
    if (!/\.zip$/i.test(file.name)) {
      setError("Please drop a .zip file.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await installZipPlugin(file);
      setDone({ name: res.plugin.name, warning: res.warning });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDrop = (e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (busy) return;
    const file = e.dataTransfer.files?.[0];
    if (file) void handleZipFile(file);
  };

  // Normalize a pasted git URL on blur: canonicalize and auto-fill subpath from
  // a GitHub tree/blob link or owner/repo shortcut (reuses the Skills parser).
  const handleGitBlur = () => {
    const raw = gitUrl.trim();
    if (!raw) return;
    const parsed = parseGitInput(raw);
    if (parsed.url && parsed.url !== gitUrl) setGitUrl(parsed.url);
    if (parsed.subpath && !subpath.trim()) setSubpath(parsed.subpath);
  };

  const handleGit = async () => {
    const parsed = parseGitInput(gitUrl.trim());
    const url = parsed.url;
    if (!url) {
      setError("Enter a git URL.");
      return;
    }
    const finalSubpath = subpath.trim() || parsed.subpath;
    setBusy(true);
    setError(null);
    try {
      const res = await installGitPlugin(url, finalSubpath || undefined);
      setDone({ name: res.plugin.name, warning: res.warning });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
    <DialogShell isOpen onClose={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-5 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Add Plugin</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {done ? (
          <div className="space-y-5">
            <div className="flex flex-col items-center px-4 pb-1 pt-2 text-center">
              <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-[var(--color-success)]/10">
                <CheckCircle2 className="h-6 w-6 text-[var(--color-success)]" />
              </div>
              <h3 className="text-base font-semibold text-[var(--color-text)]">
                Plugin added
              </h3>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                “{done.name}” was installed successfully.
              </p>
            </div>

            {(done.path || done.next) && (
              <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3.5">
                {done.path && (
                  <div>
                    <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                      Created at
                    </div>
                    <code className="block break-all text-xs text-[var(--color-text)]">
                      {done.path}
                    </code>
                  </div>
                )}
                {done.next && (
                  <div>
                    <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                      Next step
                    </div>
                    <code className="block overflow-x-auto whitespace-nowrap rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 text-xs text-[var(--color-text)]">
                      {done.next}
                    </code>
                  </div>
                )}
              </div>
            )}

            {done.warning && (
              <div className="rounded-lg border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/5 px-3 py-2 text-xs text-[var(--color-text)]">
                {done.warning}
              </div>
            )}
            <div className="flex justify-end">
              <Button variant="primary" size="sm" onClick={onClose}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Mode toggle */}
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(MODE_META) as Mode[]).map((m) => {
                const active = mode === m;
                const Icon = MODE_META[m].icon;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-xs transition-all ${
                      active
                        ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10 text-[var(--color-text)]"
                        : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-text-muted)]"
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {MODE_META[m].label}
                  </button>
                );
              })}
            </div>

            {mode === "local" && (
              <div className="space-y-3">
                {/* Drop a .zip — auto-extracted, no manual unzip needed. */}
                <input
                  ref={zipInputRef}
                  type="file"
                  accept=".zip,application/zip"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleZipFile(file);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => zipInputRef.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop}
                  className={`flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-6 text-center transition-colors ${
                    dragOver
                      ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10"
                      : "border-[var(--color-border)] hover:border-[var(--color-text-muted)]"
                  }`}
                >
                  <FileArchive className="h-6 w-6 text-[var(--color-text-muted)]" />
                  <span className="text-xs text-[var(--color-text)]">
                    {busy ? "Installing…" : "Drop a .zip here, or click to choose"}
                  </span>
                  <span className="text-[10px] text-[var(--color-text-muted)]">
                    Auto-extracted — the zip must contain a{" "}
                    <code className="text-[var(--color-highlight)]">plugin.json</code>.
                  </span>
                </button>

                {/* Or pick an already-unzipped folder. */}
                <div className="flex items-center gap-2 text-[10px] text-[var(--color-text-muted)]">
                  <span className="h-px flex-1 bg-[var(--color-border)]" />
                  or pick a folder
                  <span className="h-px flex-1 bg-[var(--color-border)]" />
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleLocal}
                  disabled={busy}
                  className="w-full"
                >
                  <FolderOpen className="mr-1.5 h-4 w-4" />
                  {busy ? "Installing…" : "Choose folder & install"}
                </Button>
                <p className="text-[10px] text-[var(--color-text-muted)]">
                  Either way, the plugin is copied into Grove; deleting it removes the copy.
                </p>
              </div>
            )}
            {mode === "dev" && (
              <p className="text-xs text-[var(--color-text-muted)]">
                Reference an existing plugin folder in place — edits hot-reload, and your
                folder is left untouched on uninstall. Must contain a{" "}
                <code className="text-[var(--color-highlight)]">plugin.json</code>.
              </p>
            )}
            {mode === "git" && (
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs text-[var(--color-text-muted)]">
                    Git URL
                  </label>
                  <input
                    value={gitUrl}
                    onChange={(e) => setGitUrl(e.target.value)}
                    onBlur={handleGitBlur}
                    placeholder="URL · owner/repo · tree/blob link"
                    className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)]"
                  />
                  <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                    Any git host. Paste a GitHub tree/blob link and the subpath is filled in
                    automatically.
                  </p>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-[var(--color-text-muted)]">
                    Subpath (optional)
                  </label>
                  <input
                    value={subpath}
                    onChange={(e) => setSubpath(e.target.value)}
                    placeholder="packages/my-plugin"
                    className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)]"
                  />
                  <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                    Folder inside the repo that contains plugin.json. Leave empty if it's at
                    the root.
                  </p>
                </div>
              </div>
            )}
            {mode === "create" && (
              <div className="space-y-2">
                <label className="block text-xs text-[var(--color-text-muted)]">Plugin name</label>
                <input
                  autoFocus
                  value={newPluginName}
                  onChange={(event) => setNewPluginName(event.target.value)}
                  placeholder="my-grove-plugin"
                  className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)]"
                />
                <p className="text-[10px] text-[var(--color-text-muted)]">Choose a parent folder next. Grove creates a TypeScript plugin starter and registers it as a development plugin.</p>
              </div>
            )}

            {error && (
              <div className="break-all rounded-lg border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 px-3 py-2 text-xs text-[var(--color-error)]">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              {mode === "git" && (
                <Button variant="primary" size="sm" onClick={handleGit} disabled={busy}>
                  <GitBranch className="mr-1.5 h-4 w-4" />
                  {busy ? "Cloning…" : "Clone & install"}
                </Button>
              )}
              {mode === "dev" && (
                <Button variant="primary" size="sm" onClick={handleDev} disabled={busy}>
                  <FolderOpen className="mr-1.5 h-4 w-4" />
                  {busy ? "Registering…" : "Choose folder & register"}
                </Button>
              )}
              {mode === "create" && (
                <Button variant="primary" size="sm" onClick={handleCreate} disabled={busy}>
                  <Sparkles className="mr-1.5 h-4 w-4" />
                  {busy ? "Creating…" : "Choose folder & create"}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </DialogShell>
    {folderPicker}
    </>
  );
}
