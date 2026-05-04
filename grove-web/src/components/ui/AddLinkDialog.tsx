// Add-Link dialog used by both Artifacts and Shared Assets.
//
// Fields: URL (required), Name (required, auto-filled from URL title),
// Description (optional). Caller passes an async `onSubmit` that persists
// the link via the appropriate backend endpoint.

import { useEffect, useRef, useState } from "react";
import { Link as LinkIcon, Loader2, X } from "lucide-react";
import { fetchUrlMetadata, type ApiError } from "../../api";
import { hostnameOf } from "./linkFile";

interface AddLinkDialogProps {
  open: boolean;
  title?: string;
  /** Pre-filled values for edit mode. When provided, metadata auto-fetch
   *  is skipped on open so a user-saved name isn't overwritten. */
  initial?: { name: string; url: string; description?: string };
  /** Text shown on the confirm button. Defaults to "Add Link". */
  submitLabel?: string;
  onClose: () => void;
  onSubmit: (payload: { name: string; url: string; description?: string }) => Promise<void>;
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
  } else if (!open && lastOpenKey?.open) {
    setLastOpenKey({ open, initial });
  }
  // Focus the URL field so users can immediately paste, after the reset above.
  useEffect(() => {
    if (open) urlInputRef.current?.focus();
  }, [open, initial]);

  // `name` is read inside the metadata-fetch effect only as a gate (skip if
  // already filled). Keep it in a ref so we read the latest value without
  // re-firing the effect on every keystroke.
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
  // has content (edit mode, or user typed a name first) — no point spending
  // a network round-trip and flashing a spinner when we won't use the result.
  useEffect(() => {
    if (!open) return;
    if (nameTouched || nameRef.current.trim()) return;
    const trimmed = url.trim();
    if (!/^https?:\/\/\S+$/i.test(trimmed)) return;

    let cancelled = false;
    const handle = setTimeout(async () => {
      if (cancelled) return;
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
  }, [url, open, nameTouched]);

  if (!open) return null;

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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
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
          <label className="block">
            <span
              className="text-[11px] font-medium uppercase tracking-wide"
              style={{ color: "var(--color-text-muted)" }}
            >
              Link
            </span>
            <input
              ref={urlInputRef}
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/page"
              className="mt-1 w-full px-3 py-2 text-sm rounded-md outline-none focus:ring-1"
              style={{
                background: "var(--color-bg-secondary)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text)",
              }}
            />
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
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
              placeholder="Auto-filled from link title"
              className="mt-1 w-full px-3 py-2 text-sm rounded-md outline-none focus:ring-1"
              style={{
                background: "var(--color-bg-secondary)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text)",
              }}
            />
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
