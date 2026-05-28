import { useEffect, useRef, useState } from "react";
import { Folder, GitBranch, ChevronUp, Home as HomeIcon, Check, X } from "lucide-react";
import { Button, DialogShell } from "../ui";
import { listFolder, type ListFolderResponse } from "../../api/projects";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** Called with the absolute path the user selected. */
  onSelect: (path: string) => void;
  /** Modal title. Default: "Select Folder". */
  title?: string;
  /** Starting dir. Default: server's $HOME (probed via root). */
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

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (isOpen && !prevIsOpenRef.current) {
      // close→open transition: initialize browser state
      if (initialPath) {
        void load(initialPath);
      } else {
        void (async () => {
          const myId = ++reqIdRef.current;
          try {
            const probe = await listFolder("/");
            if (reqIdRef.current !== myId) return;
            await load(probe.home || "/");
          } catch (e: unknown) {
            if (reqIdRef.current === myId) setError(extractErrorMessage(e));
          }
        })();
      }
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, initialPath]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!isOpen) return null;

  // Build breadcrumb segments. data.path = "/home/dev/projects" → [{label:"/", path:""}, {label:"home", path:"/home"}, ...]
  const crumbs = data
    ? data.path
        .split("/")
        .filter(Boolean)
        .reduce<Array<{ label: string; path: string }>>(
          (acc, seg) => {
            const prev = acc.length ? acc[acc.length - 1].path : "";
            acc.push({ label: seg, path: `${prev}/${seg}` });
            return acc;
          },
          [{ label: "/", path: "" }],
        )
    : [];

  return (
    <DialogShell isOpen={isOpen} onClose={onClose} maxWidth="max-w-2xl">
      <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl shadow-xl overflow-hidden w-full max-w-[95vw]">
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
              onClick={() => data?.home && void load(data.home)}
              disabled={!data?.home || loading}
              type="button"
            >
              <HomeIcon className="w-4 h-4 mr-1" /> Home
            </Button>
            <div className="flex-1 overflow-x-auto text-xs text-[var(--color-text-muted)] whitespace-nowrap">
              {crumbs.map((c, i) => (
                <span key={c.path || "/"}>
                  {i > 0 && <span className="mx-1">/</span>}
                  <button
                    type="button"
                    className="hover:underline hover:text-[var(--color-text)] disabled:opacity-50"
                    onClick={() => void load(c.path || "/")}
                    disabled={loading}
                  >
                    {c.label}
                  </button>
                </span>
              ))}
            </div>
          </div>

          {/* List */}
          <div className="border border-[var(--color-border)] rounded-md max-h-80 overflow-y-auto bg-[var(--color-bg)]">
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
                  className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-[var(--color-bg-tertiary)] border-b border-[var(--color-border)] last:border-b-0 text-sm text-[var(--color-text)] disabled:opacity-50"
                >
                  <Folder className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
                  <span className="flex-1 truncate">{e.name}</span>
                  {e.is_git_repo && (
                    <span className="text-xs text-[var(--color-highlight)] flex items-center gap-1 shrink-0">
                      <GitBranch className="w-3 h-3" /> git
                    </span>
                  )}
                </button>
              ))}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-4 bg-[var(--color-bg)] border-t border-[var(--color-border)]">
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
            Select this folder
          </Button>
        </div>
      </div>
    </DialogShell>
  );
}
