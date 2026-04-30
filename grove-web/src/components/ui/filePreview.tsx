/* eslint-disable react-refresh/only-export-components */
import { useState, useEffect, useId, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { Code, Download, Expand, Eye, Loader2, Maximize2, MessageSquarePlus, Minimize2, RefreshCw, Shrink, Trash2, X } from "lucide-react";
import { getPreviewRenderer, type PreviewCommentMarker } from "../Review/previewRenderers";
import { highlightCode, detectLanguage } from "../Review/syntaxHighlight";
import { PreviewSearchBar } from "../Review/PreviewSearchBar";
import { useDomSearch } from "../Review/useDomSearch";
import { ImageLightbox } from "./ImageLightbox";
import type { PreviewCommentLocator, PreviewCommentDraft } from "../../context";


export function getExtBadge(name: string): string {
  // `.link.json` sidecars are rendered as link items; show "LINK" instead
  // of the literal "JSON" extension.
  if (name.toLowerCase().endsWith(".link.json")) return "LINK";
  return name.split(".").pop()?.toUpperCase() || "";
}

type TauriInternals = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
};

function getTauriInternals(): TauriInternals | null {
  const w = window as Window & { __TAURI_INTERNALS__?: TauriInternals };
  return w.__TAURI_INTERNALS__ ?? null;
}

function fallbackDownloadViaAnchor(url: string, suggestedName?: string) {
  // <a download> works in Tauri's webview for same-origin URLs, unlike
  // <iframe src>, which the webview treats as a navigation attempt.
  const a = document.createElement("a");
  a.href = url;
  if (suggestedName) a.download = suggestedName;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 1000);
}

export function downloadViaIframe(url: string, suggestedName?: string) {
  const tauri = getTauriInternals();
  if (tauri) {
    // In the Tauri desktop build, browser-style downloads don't reach the
    // OS download manager. Route through a native save dialog instead.
    const name = suggestedName ?? inferNameFromUrl(url);
    tauri
      .invoke("download_file_dialog", { url, suggestedName: name })
      .catch((err) => {
        console.error("[downloadFile] Tauri save dialog failed:", err);
        fallbackDownloadViaAnchor(url, name);
      });
    return;
  }
  fallbackDownloadViaAnchor(url, suggestedName);
}

function inferNameFromUrl(url: string): string {
  try {
    const u = new URL(url, window.location.origin);
    const parts = u.pathname.split("/").filter(Boolean);
    return decodeURIComponent(parts[parts.length - 1] ?? "download");
  } catch {
    return "download";
  }
}

export function getPreviewType(fileName: string): "image" | "text" | null {
  const renderer = getPreviewRenderer(fileName);
  if (!renderer) return null;
  return renderer.contentType === 'url' ? "image" : "text";
}

const TEXT_EXTENSIONS = new Set([
  "txt", "log", "env",
  "json", "jsonl", "ndjson", "yaml", "yml", "toml", "ini", "xml", "csv", "tsv",
  "html", "htm", "css", "scss", "less",
  "js", "jsx", "ts", "tsx", "mjs", "cjs",
  "sh", "bash", "zsh", "fish",
  "py", "rb", "php", "lua", "r",
  "rs", "go", "java", "kt", "swift", "cs", "cpp", "c", "h", "hpp",
  "sql",
]);

/** Use this in Resource/Artifacts contexts where plain text files should also be previewable. */
export function canPreviewFile(fileName: string): boolean {
  if (getPreviewRenderer(fileName)) return true;
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXTENSIONS.has(ext);
}

interface FilePreviewDrawerProps {
  fileName: string;
  content: string;
  loading?: boolean;
  error?: string | null;
  isLive?: boolean;
  onClose: () => void;
  onDownload: () => void;
  onRefresh?: () => void;
  onCreatePreviewComment?: (locator: PreviewCommentLocator, comment: string, rendererId: string) => void;
  onUpdatePreviewComment?: (id: string, comment: string) => void;
  onDeletePreviewComment?: (id: string) => void;
  onStaleMarkersCleaned?: (count: number) => void;
  previewCommentMarkers?: PreviewCommentMarker[];
  previewCommentDrafts?: PreviewCommentDraft[];
}

export function FilePreviewDrawer({
  fileName,
  content,
  loading = false,
  error,
  isLive,
  onClose,
  onDownload,
  onRefresh,
  onCreatePreviewComment,
  onUpdatePreviewComment,
  onDeletePreviewComment,
  onStaleMarkersCleaned,
  previewCommentMarkers,
  previewCommentDrafts,
}: FilePreviewDrawerProps) {
  const renderer = getPreviewRenderer(fileName);
  const wide = renderer?.id === 'jsx' || renderer?.id === 'html';
  const canToggleSource = renderer?.contentType === 'text';
  const commentable = !!onCreatePreviewComment && !!renderer && renderer.supportsComments !== false;
  const previewId = useId().replace(/:/g, "");
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [lightboxSvg, setLightboxSvg] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [groveFullscreen, setGroveFullscreen] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [commentMode, setCommentMode] = useState(false);
  // Stabilize markers by value-hash so iframe postMessage effect doesn't fire on
  // each render due to a new array reference from the parent.
  const markerKey = useMemo(() => JSON.stringify(previewCommentMarkers ?? []), [previewCommentMarkers]);
  const stableMarkers = useMemo<PreviewCommentMarker[]>(() => JSON.parse(markerKey), [markerKey]);
  const [pendingLocator, setPendingLocator] = useState<PreviewCommentLocator | null>(null);
  const [commentText, setCommentText] = useState("");
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);

  // ── Search ─────────────────────────────────────────────────────────────
  const drawerRef = useRef<HTMLDivElement>(null);
  const searchRootRef = useRef<HTMLDivElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // Iframe (HTML/JSX) renderers route search through the bridge; for those
  // we rely on bridge-reported counts instead of running TreeWalker locally.
  const isIframeRenderer = renderer?.id === "html" || renderer?.id === "jsx";
  const searchEnabled = searchOpen && !isIframeRenderer;
  const dom = useDomSearch(searchRootRef, searchEnabled ? searchQuery : "", searchEnabled);
  const [iframeTotal, setIframeTotal] = useState(0);
  const [iframeCurrent, setIframeCurrent] = useState(0);
  const total = isIframeRenderer ? iframeTotal : dom.total;
  const current = isIframeRenderer ? iframeCurrent : dom.current;
  const next = () => {
    if (isIframeRenderer) setIframeCurrent((c) => (iframeTotal === 0 ? 0 : (c + 1) % iframeTotal));
    else dom.next();
  };
  const prev = () => {
    if (isIframeRenderer) setIframeCurrent((c) => (iframeTotal === 0 ? 0 : (c - 1 + iframeTotal) % iframeTotal));
    else dom.prev();
  };

  // Reset iframe match state when query changes
  useEffect(() => {
    if (!isIframeRenderer) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setIframeCurrent(0);
    });
    return () => {
      cancelled = true;
    };
  }, [searchQuery, isIframeRenderer]);

  // Iframe search bridge: send query / goto / clear, listen for results
  useEffect(() => {
    if (!isIframeRenderer || !searchOpen) return;
    const iframe = drawerRef.current?.querySelector<HTMLIFrameElement>("iframe");
    if (!iframe?.contentWindow) return;
    iframe.contentWindow.postMessage(
      { type: "grove-preview-search:query", previewId, query: searchQuery },
      "*",
    );
  }, [searchQuery, searchOpen, isIframeRenderer, previewId]);

  useEffect(() => {
    if (!isIframeRenderer || !searchOpen) return;
    const iframe = drawerRef.current?.querySelector<HTMLIFrameElement>("iframe");
    if (!iframe?.contentWindow) return;
    iframe.contentWindow.postMessage(
      { type: "grove-preview-search:goto", previewId, index: iframeCurrent },
      "*",
    );
  }, [iframeCurrent, isIframeRenderer, searchOpen, previewId]);

  useEffect(() => {
    if (!isIframeRenderer) return;
    const handler = (event: MessageEvent) => {
      const data = event.data as { type?: string; previewId?: string; total?: number };
      if (!data || data.previewId !== previewId) return;
      if (data.type === "grove-preview-search:result" && typeof data.total === "number") {
        setIframeTotal(data.total);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [isIframeRenderer, previewId]);

  useEffect(() => {
    if (!searchOpen && isIframeRenderer) {
      const iframe = drawerRef.current?.querySelector<HTMLIFrameElement>("iframe");
      iframe?.contentWindow?.postMessage(
        { type: "grove-preview-search:clear", previewId },
        "*",
      );
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) setIframeTotal(0);
      });
      return () => {
        cancelled = true;
      };
    }
  }, [searchOpen, isIframeRenderer, previewId]);

  // Cmd/Ctrl+F: only intercept when this drawer contains the keyboard focus.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "f" || !(e.metaKey || e.ctrlKey)) return;
      const root = drawerRef.current;
      if (!root) return;
      const target = document.activeElement;
      if (!target || !root.contains(target)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      setSearchOpen((v) => !v);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  // Reset search state when file changes
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setSearchOpen(false);
      setSearchQuery("");
    });
    return () => {
      cancelled = true;
    };
  }, [fileName]);

  // Esc: exit true fullscreen first, then panel fullscreen, otherwise close the drawer. Uses capture +
  // stopImmediatePropagation so the global useHotkeys (which also runs in
  // capture phase and would close the workspace on Esc) never fires.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Let the Lightbox handle Esc when it's open.
      if (document.querySelector('[data-lightbox-active="true"]')) return;
      // Let the comment modal handle its own Esc first — without this, the
      // drawer handler swallows Esc and closes the whole drawer, losing any
      // in-progress comment text.
      if (pendingLocator) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (groveFullscreen) {
        setGroveFullscreen(false);
      } else if (fullscreen) {
        setFullscreen(false);
      } else {
        onClose();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [fullscreen, groveFullscreen, onClose, pendingLocator]);

  useEffect(() => {
    if (!commentable) return;
    const handler = (event: MessageEvent) => {
      const data = event.data as { type?: string; previewId?: string; payload?: PreviewCommentLocator; markerId?: string; ids?: string[] };
      if (!data || data.previewId !== previewId) return;
      if (data.type === "grove-preview-comment:selected" && data.payload) {
        // Keep commentMode true so the picker resumes once the modal closes,
        // letting users add multiple comments in one session. The `enabled`
        // prop below gates the overlay on `!pendingLocator` so the picker UI
        // hides while the modal is up.
        setPendingLocator(data.payload);
        setCommentText("");
        setEditingDraftId(null);
      } else if (data.type === "grove-preview-comment:cancel") {
        setCommentMode(false);
      } else if (data.type === "grove-preview-comment:marker-click" && data.markerId) {
        const draft = previewCommentDrafts?.find((d) => d.id === data.markerId);
        if (draft) {
          setPendingLocator(draft.locator);
          setCommentText(draft.comment);
          setEditingDraftId(draft.id);
        }
      } else if (data.type === "grove-preview-comment:markers-stale" && Array.isArray(data.ids) && onDeletePreviewComment) {
        data.ids.forEach((id) => onDeletePreviewComment(id));
        if (data.ids.length) onStaleMarkersCleaned?.(data.ids.length);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [commentable, previewId, previewCommentDrafts, onDeletePreviewComment, onStaleMarkersCleaned]);

  const closeCommentModal = () => {
    setPendingLocator(null);
    setCommentText("");
    setEditingDraftId(null);
  };

  // Reset comment state when the previewed file changes, so a pending modal
  // from the previous file doesn't submit against the new one.
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setPendingLocator(null);
      setCommentText("");
      setEditingDraftId(null);
      setCommentMode(false);
    });
    return () => {
      cancelled = true;
    };
  }, [fileName]);

  useEffect(() => {
    if (!pendingLocator) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      closeCommentModal();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [pendingLocator]);

  const submitPreviewComment = () => {
    if (!pendingLocator || !commentText.trim() || !renderer) return;
    if (editingDraftId) {
      if (!onUpdatePreviewComment) return;
      onUpdatePreviewComment(editingDraftId, commentText.trim());
    } else {
      if (!onCreatePreviewComment) return;
      onCreatePreviewComment(pendingLocator, commentText.trim(), renderer.id);
    }
    closeCommentModal();
  };

  const deletePreviewComment = () => {
    if (!editingDraftId || !onDeletePreviewComment) return;
    onDeletePreviewComment(editingDraftId);
    closeCommentModal();
  };

  const drawer = (
    <>
      {!fullscreen && !groveFullscreen && (
        <motion.div
          className="absolute inset-0 z-20 bg-black/20"
          onClick={onClose}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        />
      )}
      <motion.div
        ref={drawerRef}
        data-hotkeys-dialog="true"
        tabIndex={-1}
        onPointerDown={(e) => {
          const root = drawerRef.current;
          if (!root) return;
          if (root === e.target || !(e.target as Element).closest?.("input,textarea,select,button,a,iframe,[contenteditable=true]")) {
            if (!root.contains(document.activeElement)) {
              root.focus({ preventScroll: true });
            }
          }
        }}
        className={`outline-none ${fullscreen || groveFullscreen ? 'fixed inset-0 z-[9998] flex flex-col shadow-2xl' : `absolute inset-y-0 right-0 z-30 ${wide ? 'w-[min(96vw,1100px)]' : 'w-[min(92vw,780px)]'} max-w-full flex flex-col shadow-2xl`}`}
        style={{
          background: "var(--color-bg)",
          ...(fullscreen || groveFullscreen ? {} : { borderLeft: "1px solid var(--color-border)" }),
        }}
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "spring", damping: 30, stiffness: 300 }}
      >
        <div
          className="flex items-center justify-between px-4 py-3 shrink-0"
          style={{ borderBottom: "1px solid var(--color-border)", background: "var(--color-bg-secondary)" }}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <Eye className="w-4 h-4 shrink-0" style={{ color: "var(--color-highlight)" }} />
            <span className="text-sm font-medium truncate">{fileName}</span>
            <span
              className="text-[9px] px-1.5 py-0.5 rounded font-mono shrink-0"
              style={{ background: "var(--color-bg-tertiary)", color: "var(--color-text-muted)" }}
            >
              {getExtBadge(fileName)}
            </span>
            {isLive && (
              <span className="flex items-center gap-1 text-[10px] font-medium shrink-0" style={{ color: "var(--color-success)" }}>
                <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "var(--color-success)" }} />
                LIVE
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {canToggleSource && (
              <button
                onClick={() => setShowSource(s => !s)}
                className="p-1.5 rounded-md transition-colors"
                title={showSource ? "Show preview" : "Show source"}
                style={{
                  color: showSource ? "var(--color-highlight)" : "var(--color-text-muted)",
                  background: showSource ? "color-mix(in srgb, var(--color-highlight) 12%, transparent)" : "transparent",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = showSource ? "color-mix(in srgb, var(--color-highlight) 20%, transparent)" : "var(--color-bg-tertiary)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = showSource ? "color-mix(in srgb, var(--color-highlight) 12%, transparent)" : "transparent"; }}
              >
                <Code className="w-4 h-4" />
              </button>
            )}
            {onRefresh && (
              <button
                onClick={onRefresh}
                className="p-1.5 rounded-md transition-colors"
                title="Refresh"
                style={{ color: "var(--color-text-muted)" }}
                onMouseEnter={(e) => e.currentTarget.style.background = "var(--color-bg-tertiary)"}
                onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            )}
            {commentable && !showSource && (
              <button
                onClick={() => setCommentMode((v) => !v)}
                className="p-1.5 rounded-md transition-colors"
                title={commentMode ? "Cancel comment selection" : "Comment on preview"}
                style={{
                  color: commentMode ? "var(--color-highlight)" : "var(--color-text-muted)",
                  background: commentMode ? "color-mix(in srgb, var(--color-highlight) 12%, transparent)" : "transparent",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = commentMode ? "color-mix(in srgb, var(--color-highlight) 20%, transparent)" : "var(--color-bg-tertiary)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = commentMode ? "color-mix(in srgb, var(--color-highlight) 12%, transparent)" : "transparent"; }}
              >
                <MessageSquarePlus className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={onDownload}
              className="p-1.5 rounded-md transition-colors"
              title="Download"
              style={{ color: "var(--color-text-muted)" }}
              onMouseEnter={(e) => e.currentTarget.style.background = "var(--color-bg-tertiary)"}
              onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
            >
              <Download className="w-4 h-4" />
            </button>
            <button
              onClick={() => setFullscreen(f => !f)}
              className="p-1.5 rounded-md transition-colors"
              title={fullscreen ? "Exit panel fullscreen" : "Panel fullscreen"}
              style={{ color: "var(--color-text-muted)" }}
              onMouseEnter={(e) => e.currentTarget.style.background = "var(--color-bg-tertiary)"}
              onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
            >
              {fullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>
            <button
              onClick={() => setGroveFullscreen(f => !f)}
              className="p-1.5 rounded-md transition-colors"
              title={groveFullscreen ? "Exit Grove fullscreen" : "Grove fullscreen"}
              style={{ color: "var(--color-text-muted)" }}
              onMouseEnter={(e) => e.currentTarget.style.background = "var(--color-bg-tertiary)"}
              onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
            >
              {groveFullscreen ? <Shrink className="w-4 h-4" /> : <Expand className="w-4 h-4" />}
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-md transition-colors"
              style={{ color: "var(--color-text-muted)" }}
              onMouseEnter={(e) => e.currentTarget.style.background = "var(--color-bg-tertiary)"}
              onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        {error && (
          <div className="px-4 py-2 text-xs shrink-0 flex items-center gap-2" style={{ background: "color-mix(in srgb, var(--color-error) 8%, transparent)", color: "var(--color-error)", borderBottom: "1px solid color-mix(in srgb, var(--color-error) 20%, transparent)" }}>
            <span className="flex-1 truncate">{error}</span>
            {onRefresh && (
              <button onClick={onRefresh} className="shrink-0 underline text-[11px] font-medium hover:opacity-80">
                Retry
              </button>
            )}
          </div>
        )}
        <div ref={searchRootRef} className="flex-1 overflow-auto relative">
          {searchOpen && (
            <PreviewSearchBar
              query={searchQuery}
              onQueryChange={setSearchQuery}
              total={total}
              current={current}
              onNext={next}
              onPrev={prev}
              onClose={() => { setSearchOpen(false); setSearchQuery(""); }}
            />
          )}
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="w-5 h-5 animate-spin" style={{ color: "var(--color-text-muted)" }} />
            </div>
          ) : showSource ? (() => {
            const lang = detectLanguage(fileName);
            const highlighted = lang ? highlightCode(content, lang) : null;
            return highlighted ? (
              <pre className="markdown-code-block p-5 text-xs font-mono whitespace-pre leading-6 overflow-x-auto" style={{ color: "var(--color-text)" }}>
                <code dangerouslySetInnerHTML={{ __html: highlighted }} />
              </pre>
            ) : (
              <pre className="p-5 text-xs font-mono whitespace-pre-wrap break-words leading-relaxed" style={{ color: "var(--color-text)" }}>
                {content}
              </pre>
            );
          })() : renderer ? (
            <div className={renderer.id === 'image' || renderer.id === 'jsx' || renderer.id === 'html' ? 'h-full' : 'p-5'}>
              {renderer.renderFull({
                content,
                onImageClick: setLightboxUrl,
                onSvgClick: setLightboxSvg,
                previewComment: commentable ? { enabled: commentMode && !pendingLocator, previewId, markers: stableMarkers } : undefined,
              })}
            </div>
          ) : (() => {
            const lang = detectLanguage(fileName);
            const highlighted = lang ? highlightCode(content, lang) : null;
            return highlighted ? (
              <pre className="markdown-code-block p-5 text-xs font-mono whitespace-pre leading-6 overflow-x-auto" style={{ color: "var(--color-text)" }}>
                <code dangerouslySetInnerHTML={{ __html: highlighted }} />
              </pre>
            ) : (
              <pre className="p-5 text-xs font-mono whitespace-pre-wrap break-words leading-relaxed" style={{ color: "var(--color-text)" }}>
                {content}
              </pre>
            );
          })()}
        </div>
      </motion.div>
      {pendingLocator && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-[2px] animate-in fade-in duration-150"
          data-hotkeys-dialog="true"
          onMouseDown={(e) => { if (e.target === e.currentTarget) closeCommentModal(); }}
        >
          <div
            className="w-[min(92vw,460px)] overflow-hidden rounded-xl border shadow-2xl"
            style={{ background: "var(--color-bg)", borderColor: "var(--color-border)" }}
          >
            <div className="flex items-center justify-between gap-2 px-4 py-2.5" style={{ borderBottom: "1px solid var(--color-border)", background: "var(--color-bg-secondary)" }}>
              <div className="flex min-w-0 items-center gap-1.5">
                <MessageSquarePlus className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--color-highlight)" }} />
                <span className="text-[13px] font-semibold text-[var(--color-text)]">
                  {editingDraftId ? "Edit preview comment" : "New preview comment"}
                </span>
              </div>
              <button
                onClick={closeCommentModal}
                className="rounded-md p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]"
                title="Close (Esc)"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="px-4 pt-3">
              <div className="truncate font-mono text-[10.5px] text-[var(--color-text-muted)]" title={pendingLocator.selector || pendingLocator.tagName}>
                {pendingLocator.selector || pendingLocator.tagName}
              </div>
              {pendingLocator.text && (
                <div className="mt-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2.5 py-1.5 text-[11px] leading-snug text-[var(--color-text-muted)] line-clamp-2">
                  {pendingLocator.text}
                </div>
              )}
            </div>
            <div className="px-4 py-3">
              <textarea
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                autoFocus
                rows={3}
                className="w-full resize-none rounded-lg border bg-[var(--color-bg-secondary)] px-2.5 py-2 text-[13px] leading-snug outline-none transition-colors focus:border-[var(--color-highlight)]"
                style={{ borderColor: "var(--color-border)", color: "var(--color-text)" }}
                placeholder="What should change about this area?"
                onKeyDown={(e) => {
                  if (e.key === "Escape") { e.preventDefault(); closeCommentModal(); }
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitPreviewComment();
                }}
              />
              <div className="mt-2.5 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {editingDraftId && onDeletePreviewComment && (
                    <button
                      onClick={deletePreviewComment}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[var(--color-text-muted)] transition-colors hover:bg-[color-mix(in_srgb,var(--color-error)_12%,transparent)] hover:text-[var(--color-error)]"
                      title="Delete comment"
                    >
                      <Trash2 className="h-3 w-3" />
                      Delete
                    </button>
                  )}
                  <span className="text-[10px] text-[var(--color-text-muted)]">
                    <kbd className="rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-1 py-px font-mono text-[10px]">⌘↵</kbd> to submit
                  </span>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={closeCommentModal}
                    className="rounded-md px-2.5 py-1 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={submitPreviewComment}
                    disabled={!commentText.trim()}
                    className="rounded-md px-3 py-1 text-[11px] font-semibold text-white shadow-sm transition-opacity disabled:opacity-40"
                    style={{ background: "var(--color-highlight)" }}
                  >
                    {editingDraftId ? "Save" : "Add comment"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      <ImageLightbox
        imageUrl={lightboxUrl}
        svgContent={lightboxSvg}
        onClose={() => { setLightboxUrl(null); setLightboxSvg(null); }}
      />
    </>
  );

  return groveFullscreen && typeof document !== "undefined"
    ? createPortal(drawer, document.body)
    : drawer;
}
