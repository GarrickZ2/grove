import { useEffect, useRef, useState } from "react";
import { Folder, GitBranch, ChevronUp, ChevronRight, Home as HomeIcon, Check, X } from "lucide-react";
import { Button, DialogShell } from "../ui";
import { getFolderRoots, listFolder, type ListFolderResponse } from "../../api/projects";
import { filesystemBreadcrumbs } from "../../utils/filesystemPath";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** Called with the absolute path the user selected. */
  onSelect: (path: string) => void;
  /** Modal title. Default: "Select Folder". */
  title?: string;
  /** Starting dir. Default: the server user's home directory. */
  initialPath?: string;
}

/**
 * Extract a human-readable message from anything thrown by apiClient.
 * apiClient throws plain object literals {status, message, data}, not Error
 * instances, so plain `e.message` access requires type narrowing.
 */
function extractErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null && "message" in e) {
    const msg = (e as { message: unknown }).message;
    if (typeof msg === "string") return msg;
  }
  return String(e);
}

export function FolderTreePickerDialog({
  isOpen,
  onClose,
  onSelect,
  title = "Select Folder",
  initialPath,
}: Props) {
  const [data, setData] = useState<ListFolderResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roots, setRoots] = useState<string[]>([]);
  const [home, setHome] = useState<string | null>(null);
  const [directPath, setDirectPath] = useState("");

  const reqIdRef = useRef(0);
  const prevIsOpenRef = useRef(false);

  const load = async (path: string) => {
    const myId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const resp = await listFolder(path);
      if (reqIdRef.current === myId) setData(resp);
    } catch (e: unknown) {
      if (reqIdRef.current === myId) {
        setError(extractErrorMessage(e));
        setData(null);
      }
    } finally {
      if (reqIdRef.current === myId) setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && !prevIsOpenRef.current) {
      // close→open transition: initialize browser state
      setData(null);
      setLoading(true);
      void (async () => {
        const myId = ++reqIdRef.current;
        try {
          const locations = await getFolderRoots();
          if (reqIdRef.current !== myId) return;
          setRoots(locations.roots);
          setHome(locations.home);
          const start = initialPath || locations.home || locations.roots[0];
          if (start) await load(start);
          else {
            setError("No folders are available on this system.");
            setLoading(false);
          }
        } catch (e: unknown) {
          if (reqIdRef.current === myId) {
            setError(extractErrorMessage(e));
            setLoading(false);
          }
        }
      })();
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, initialPath]);

  if (!isOpen) return null;

  const crumbs = data ? filesystemBreadcrumbs(data.path) : [];

  const currentName = crumbs.length ? crumbs[crumbs.length - 1].label : "";

  return (
    <DialogShell isOpen={isOpen} onClose={onClose} maxWidth="max-w-2xl" zIndex={300}>
      <div className="glass-overlay rounded-2xl overflow-hidden w-full max-w-[95vw]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
          <h2 className="text-lg font-semibold text-[var(--color-text)]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 rounded-lg hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-3">
          {/* Toolbar */}
          <div className="flex items-center gap-2">
            {roots.length > 0 && roots[0] !== "/" && (
              <select
                aria-label="Drive"
                value={roots.find((root) => data?.path.slice(0, 2).toLowerCase() === root.slice(0, 2).toLowerCase()) || ""}
                onChange={(e) => void load(e.target.value)}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm text-[var(--color-text)]"
              >
                <option value="" disabled>Drive</option>
                {roots.map((root) => <option key={root} value={root}>{root}</option>)}
              </select>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => data?.parent && void load(data.parent)}
              disabled={!data?.parent || loading}
              type="button"
            >
              <ChevronUp className="w-4 h-4 mr-1" /> Up
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => home && void load(home)}
              disabled={!home || loading}
              type="button"
            >
              <HomeIcon className="w-4 h-4 mr-1" /> Home
            </Button>
            <div className="flex-1 flex items-center gap-0.5 overflow-x-auto text-xs text-[var(--color-text-muted)] whitespace-nowrap">
              {crumbs.map((c, i) => (
                <span key={c.path} className="flex items-center gap-0.5 shrink-0">
                  {i > 0 && <ChevronRight className="w-3 h-3 opacity-40 shrink-0" />}
                  <button
                    type="button"
                    className="px-1.5 py-0.5 rounded-md hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)] disabled:opacity-50 transition-colors"
                    onClick={() => void load(c.path)}
                    disabled={loading}
                    title={c.path}
                  >
                    {c.label}
                  </button>
                </span>
              ))}
            </div>
          </div>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (directPath.trim()) void load(directPath.trim());
            }}
          >
            <input
              aria-label="Folder path"
              value={directPath}
              onChange={(event) => setDirectPath(event.target.value)}
              placeholder="Go to an absolute path, including network shares"
              className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm text-[var(--color-text)]"
            />
            <Button type="submit" variant="secondary" size="sm" disabled={!directPath.trim() || loading}>Go</Button>
          </form>

          {/* List */}
          <div
            className="rounded-lg max-h-80 overflow-y-auto border border-[var(--color-border)] p-1"
            style={{ background: "color-mix(in oklab, var(--color-bg) 55%, transparent)" }}
          >
            {loading && (
              <div className="p-4 text-sm text-[var(--color-text-muted)]">Loading…</div>
            )}
            {error && !loading && (
              <div className="p-4 text-sm text-[var(--color-error)]">{error}</div>
            )}
            {data && !loading && !error && data.entries.length === 0 && (
              <div className="p-4 text-sm text-[var(--color-text-muted)]">
                No sub-directories.
              </div>
            )}
            {data &&
              !loading &&
              !error &&
              data.entries.map((e) => (
                <button
                  key={e.name}
                  type="button"
                  onClick={() => void load(e.path)}
                  disabled={loading}
                  className="group w-full text-left px-2.5 py-2 flex items-center gap-2.5 rounded-md hover:bg-[var(--color-bg-tertiary)] text-sm text-[var(--color-text)] disabled:opacity-50 transition-colors"
                >
                  <Folder
                    className={`w-4 h-4 shrink-0 ${e.is_git_repo ? "text-[var(--color-highlight)]" : "text-[var(--color-text-muted)]"}`}
                  />
                  <span className="flex-1 truncate">{e.name}</span>
                  {e.is_git_repo && (
                    <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-highlight)] flex items-center gap-1 shrink-0">
                      <GitBranch className="w-3 h-3" /> git
                    </span>
                  )}
                  <ChevronRight className="w-4 h-4 text-[var(--color-text-muted)] opacity-0 group-hover:opacity-60 shrink-0 transition-opacity" />
                </button>
              ))}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-[var(--color-border)]">
          <Button variant="secondary" onClick={onClose} type="button">
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => data && onSelect(data.path)}
            disabled={!data || loading}
            type="button"
          >
            <Check className="w-4 h-4 mr-1" />
            {currentName ? `Select “${currentName}”` : "Select this folder"}
          </Button>
        </div>
      </div>
    </DialogShell>
  );
}
