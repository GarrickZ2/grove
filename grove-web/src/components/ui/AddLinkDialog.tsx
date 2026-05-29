// Add-Link dialog used by both Artifacts and Shared Assets.
//
// Fields: URL (required), Name (required, auto-filled from URL title),
// Description (optional). Caller passes an async `onSubmit` that persists
// the link via the appropriate backend endpoint.

import { useEffect, useRef, useState, useMemo } from "react";
import { Link as LinkIcon, Loader2, X, Globe } from "lucide-react";
import { fetchUrlMetadata, type ApiError } from "../../api";
import { listExtensionTabs, type ExtensionTab } from "../../api/extension";
import { hostnameOf } from "./linkFile";
import { useCommand, useKeyboardScope } from "../../keyboard";

interface AddLinkDialogProps {
  open: boolean;
  title?: string;
  /** Pre-filled values for edit mode. When provided, metadata auto-fetch
   *  is skipped on open so a user-saved name isn't overwritten. */
  initial?: { name: string; url: string; description?: string; favicon?: string };
  /** Text shown on the confirm button. Defaults to "Add Link". */
  submitLabel?: string;
  onClose: () => void;
  onSubmit: (payload: { name: string; url: string; description?: string; favicon?: string }) => Promise<void>;
}

function deriveFallbackName(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "";
  }
  const tail = u.pathname.split("/").filter(Boolean).pop();
  if (tail) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(tail);
    } catch {
      decoded = tail;
    }
    return `${u.hostname} · ${decoded}`;
  }
  return u.hostname;
}

function deriveFaviconUrl(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    return `https://www.google.com/s2/favicons?sz=64&domain=${u.hostname}`;
  } catch {
    return "";
  }
}

function urlsMatch(urlA: string, urlB: string): boolean {
  const clean = (uStr: string) => {
    try {
      const u = new URL(uStr.trim());
      return (u.origin + u.pathname).toLowerCase().replace(/\/$/, "");
    } catch {
      return uStr.trim().toLowerCase().split(/[?#]/)[0].replace(/\/$/, "");
    }
  };
  return clean(urlA) === clean(urlB);
}

export function AddLinkDialog({ open, title = "Add Link", initial, submitLabel, onClose, onSubmit }: AddLinkDialogProps) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [metadataLoading, setMetadataLoading] = useState(false);
  // prev-url marker so we can flip the loading flag synchronously during
  // render when the URL changes (set-state-during-render pattern), avoiding
  // a setState-in-effect cascade-render warning while still showing the
  // spinner during the 400ms debounce.
  const [prevUrlForLoading, setPrevUrlForLoading] = useState(url);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);

  // Tabs snapshot fetched on dialog open.
  const [extensionTabs, setExtensionTabs] = useState<ExtensionTab[]>([]);
  // True ONLY when the tabs fetch succeeded (returned an array, even if
  // empty). Lets the "Extension Connected" badge show when the extension
  // is reachable but the user happens to have 0 open tabs — instead of
  // false-negative-hiding the badge.
  const [extensionConnected, setExtensionConnected] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);

  // Favicon is purely derived from `url` + `extensionTabs` — prefer the
  // exact `favIconUrl` from the matched open browser tab (Chrome resolved
  // it from the real page), otherwise fall back to google's s2 favicons
  // service. Computed via useMemo to avoid the in-effect setState pattern
  // that React lints reject.
  const favicon = useMemo(() => {
    const trimmed = url.trim();
    if (!/^https?:\/\/\S+$/i.test(trimmed)) return "";
    const matched = extensionTabs.find((t) => urlsMatch(t.url, trimmed));
    return matched?.favIconUrl ?? deriveFaviconUrl(trimmed);
  }, [url, extensionTabs]);

  // Reset state on open/close so a cancelled dialog doesn't leak stale input.
  // Uses the documented "Adjusting state on prop change" pattern (compared to
  // a stored marker) so the reset doesn't sit inside an effect.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [lastOpenKey, setLastOpenKey] = useState<{ open: boolean; initial: typeof initial } | null>(null);
  const justOpened = open && (lastOpenKey?.open !== open || lastOpenKey?.initial !== initial);
  if (justOpened) {
    setLastOpenKey({ open, initial });
    setUrl(initial?.url ?? "");
    setName(initial?.name ?? "");
    setDescription(initial?.description ?? "");
    // In edit mode the user is presumed to own the name — don't let the
    // metadata fetcher overwrite it just because the URL stayed the same.
    setNameTouched(!!initial);
    setMetadataLoading(false);
    setSubmitting(false);
    setError(null);
    setShowDropdown(false);
  } else if (!open && lastOpenKey?.open) {
    // Closing — drop any tabs cached during this session so a re-open
    // shows a clean state and doesn't leak the previous browser snapshot.
    setLastOpenKey({ open, initial });
    setExtensionTabs([]);
    setExtensionConnected(false);
  }
  // Focus the URL field so users can immediately paste, after the reset above.
  useEffect(() => {
    if (open) urlInputRef.current?.focus();
  }, [open, initial]);

  // Fetch extension tabs when the modal is opened.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const tabs = await listExtensionTabs();
        if (cancelled) return;
        setExtensionTabs(tabs);
        setExtensionConnected(true);
      } catch {
        if (cancelled) return;
        setExtensionTabs([]);
        setExtensionConnected(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // `name` is read inside the metadata-fetch effect only as a gate (skip if
  // already filled). Keep it in a ref so we read the latest value without
  // re-firing the effect on keystrokes.
  const nameRef = useRef(name);
  useEffect(() => {
    nameRef.current = name;
  });

  // Sync `metadataLoading` to `true` synchronously when the URL changes to
  // a new candidate fetch target. Done during render via the prev-prop
  // pattern so we get UX feedback during the 400ms debounce without
  // triggering an in-effect setState cascade-render warning. Ref read
  // (`nameRef.current`) is intentionally avoided here — fall back to `name`
  // state directly to stay render-pure.
  if (url !== prevUrlForLoading) {
    setPrevUrlForLoading(url);
    if (open && !nameTouched && !name.trim() && /^https?:\/\/\S+$/i.test(url.trim())) {
      if (!metadataLoading) setMetadataLoading(true);
    }
  }

  // Debounced metadata fetch. Skipped entirely when the Name field already
  // has content (edit mode, or user typed a name first).
  useEffect(() => {
    if (!open) return;
    if (nameTouched || nameRef.current.trim()) return;
    const trimmed = url.trim();
    if (!/^https?:\/\/\S+$/i.test(trimmed)) return;

    let cancelled = false;
    const handle = setTimeout(async () => {
      if (cancelled) return;

      // 1. Try to find a matching open browser tab for instant autofill.
      // Favicon is derived from (url, extensionTabs) via useMemo — no setter
      // call needed here.
      const matched = extensionTabs.find(t => urlsMatch(t.url, trimmed));
      if (matched) {
        setName(matched.title);
        setMetadataLoading(false);
        return;
      }

      // 2. Fall back to url/metadata scraper
      let metaTitle: string | null = null;
      let metaFailed = false;
      try {
        const meta = await fetchUrlMetadata(trimmed);
        metaTitle = meta.title.trim();
      } catch {
        metaFailed = true;
      }
      if (cancelled) return;
      let chosen: string;
      if (metaFailed) {
        chosen = deriveFallbackName(trimmed);
      } else {
        chosen = metaTitle || deriveFallbackName(trimmed);
      }
      setName(chosen);
      setMetadataLoading(false);
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(handle);
      setMetadataLoading(false);
    };
  }, [url, open, nameTouched, extensionTabs]);

  const filteredTabs = useMemo(() => {
    return extensionTabs.filter(tab => {
      if (!url.trim()) return true;
      const query = url.toLowerCase();
      return tab.title.toLowerCase().includes(query) || tab.url.toLowerCase().includes(query);
    });
  }, [extensionTabs, url]);

  const canSubmit =
    /^https?:\/\/\S+$/i.test(url.trim()) && name.trim().length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const trimmedDesc = description.trim();
    const payload = {
      name: name.trim(),
      url: url.trim(),
      description: trimmedDesc ? trimmedDesc : undefined,
      favicon: favicon.trim() ? favicon.trim() : undefined,
    };
    let succeeded = false;
    let caught: unknown = null;
    try {
      await onSubmit(payload);
      succeeded = true;
    } catch (err) {
      caught = err;
    }
    if (!succeeded) {
      const apiErr = caught as ApiError | null;
      const msg = apiErr?.message;
      const errorText =
        typeof msg === "string" && msg ? msg : "Failed to add link";
      setError(errorText);
    }
    setSubmitting(false);
    if (succeeded) onClose();
  };

  // Catalog handlers register inside <AddLinkDialogBindings> only while
  // open=true. Multiple AddLinkDialog wrappers can coexist (sidebar +
  // panel + task-level), all but one with open=false; a top-level
  // useCommand would otherwise overwrite each other on every re-render —
  // only the last-mounted dialog's binding would be live.
  useKeyboardScope("dialog.addLink", open);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <AddLinkDialogBindings onClose={onClose} onSubmit={handleSubmit} />
      <div
        onClick={(e) => e.stopPropagation()}
        data-hotkeys-dialog="true"
        className="w-[min(92vw,480px)] rounded-lg shadow-2xl"
        style={{
          background: "var(--color-bg)",
          border: "1px solid var(--color-border)",
        }}
      >
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: "1px solid var(--color-border)" }}
        >
          <div className="flex items-center gap-2">
            <LinkIcon className="w-4 h-4" style={{ color: "var(--color-highlight)" }} />
            <span className="text-sm font-medium">{title}</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--color-bg-tertiary)]"
            style={{ color: "var(--color-text-muted)" }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <label className="block relative">
            <span
              className="text-[11px] font-medium uppercase tracking-wide flex items-center justify-between"
              style={{ color: "var(--color-text-muted)" }}
            >
              Link
              {extensionConnected && (
                <span className="text-[9px] text-[var(--color-highlight)] flex items-center gap-1 normal-case font-normal">
                  <Globe className="w-2.5 h-2.5" /> Extension Connected (open tabs ready)
                </span>
              )}
            </span>
            <input
              ref={urlInputRef}
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              // Only show the open-tabs dropdown when the field is empty —
              // otherwise re-focusing while editing a URL pops noise back
              // over the autocomplete the user is trying to type.
              onFocus={() => {
                if (url.trim() === "") setShowDropdown(true);
              }}
              onBlur={() => setTimeout(() => setShowDropdown(false), 250)}
              placeholder="https://example.com/page"
              className="mt-1 w-full px-3 py-2 text-sm rounded-md outline-none focus:ring-1"
              style={{
                background: "var(--color-bg-secondary)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text)",
              }}
            />
            {showDropdown && filteredTabs.length > 0 && (
              <div
                className="absolute left-0 right-0 mt-1 max-h-48 overflow-y-auto rounded-md shadow-lg border z-50 py-1"
                style={{
                  background: "var(--color-bg)",
                  borderColor: "var(--color-border)",
                }}
              >
                {filteredTabs.map((tab, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault(); // prevent input blur
                      setUrl(tab.url);
                      setName(tab.title);
                      // Favicon derives from (url, extensionTabs) via useMemo.
                      setNameTouched(true);
                      setShowDropdown(false);
                    }}
                    className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 hover:bg-[var(--color-bg-tertiary)] transition-colors"
                  >
                    <img
                      src={tab.favIconUrl || deriveFaviconUrl(tab.url)}
                      alt=""
                      className="w-4 h-4 object-contain rounded-sm shrink-0"
                      onError={(e) => {
                        e.currentTarget.style.display = 'none';
                      }}
                    />
                    <div className="truncate flex-1">
                      <div className="font-medium text-[var(--color-text)] truncate">{tab.title}</div>
                      <div className="text-[10px] text-[var(--color-text-muted)] truncate">{tab.url}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
            {url && (
              <div
                className="mt-1 text-[11px] truncate"
                style={{ color: "var(--color-text-muted)" }}
              >
                {hostnameOf(url)}
              </div>
            )}
          </label>
          <label className="block">
            <span
              className="flex items-center justify-between text-[11px] font-medium uppercase tracking-wide"
              style={{ color: "var(--color-text-muted)" }}
            >
              Name
              {metadataLoading && (
                <Loader2 className="w-3 h-3 animate-spin" />
              )}
            </span>
            <div className="mt-1 flex gap-2 items-center">
              {favicon && (
                <img
                  src={favicon}
                  alt=""
                  className="w-6 h-6 object-contain rounded-md border p-0.5 shrink-0 bg-[var(--color-bg-secondary)]"
                  style={{ borderColor: "var(--color-border)" }}
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                  }}
                />
              )}
              <input
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameTouched(true);
                }}
                placeholder="Auto-filled from link title"
                className="w-full px-3 py-2 text-sm rounded-md outline-none focus:ring-1"
                style={{
                  background: "var(--color-bg-secondary)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text)",
                }}
              />
            </div>
          </label>
          <label className="block">
            <span
              className="text-[11px] font-medium uppercase tracking-wide"
              style={{ color: "var(--color-text-muted)" }}
            >
              Description <span className="normal-case opacity-70">(optional)</span>
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Why this link is useful for the task / project"
              rows={3}
              className="mt-1 w-full px-3 py-2 text-sm rounded-md outline-none focus:ring-1 resize-none"
              style={{
                background: "var(--color-bg-secondary)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text)",
              }}
            />
          </label>
          {error && (
            <div
              className="text-xs px-2 py-1.5 rounded"
              style={{
                background: "color-mix(in srgb, var(--color-error) 10%, transparent)",
                color: "var(--color-error)",
              }}
            >
              {error}
            </div>
          )}
        </div>
        <div
          className="flex items-center justify-end gap-2 px-4 py-3"
          style={{ borderTop: "1px solid var(--color-border)" }}
        >
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 text-xs rounded-md transition-colors disabled:opacity-50"
            style={{ color: "var(--color-text-muted)" }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="px-3 py-1.5 text-xs rounded-md font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-highlight)",
              color: "white",
            }}
          >
            {submitting ? "Saving..." : (submitLabel ?? "Add Link")}
          </button>
        </div>
      </div>
    </div>
  );
}

// Registers the dialog.addLink.* catalog handlers only while the dialog is
// actually open. See top-of-component comment for the multi-mount rationale.
function AddLinkDialogBindings({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: () => Promise<void>;
}) {
  useCommand("dialog.addLink.close", onClose, [onClose]);
  useCommand(
    "dialog.addLink.submit",
    () => {
      void onSubmit();
    },
    [onSubmit],
  );
  return null;
}
