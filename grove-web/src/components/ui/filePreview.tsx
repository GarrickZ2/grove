/* eslint-disable react-refresh/only-export-components */
import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Code, Download, Eye, Loader2, Maximize2, Minimize2, RefreshCw, X } from "lucide-react";
import { getPreviewRenderer } from "../Review/previewRenderers";
import { highlightCode, detectLanguage } from "../Review/syntaxHighlight";
import { ImageLightbox } from "./ImageLightbox";


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
}: FilePreviewDrawerProps) {
  const renderer = getPreviewRenderer(fileName);
  const wide = renderer?.id === 'jsx' || renderer?.id === 'html';
  const canToggleSource = renderer?.contentType === 'text';
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [lightboxSvg, setLightboxSvg] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [showSource, setShowSource] = useState(false);

  // Esc: exit fullscreen first, otherwise close the drawer. Uses capture +
  // stopImmediatePropagation so the global useHotkeys (which also runs in
  // capture phase and would close the workspace on Esc) never fires.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Let the Lightbox handle Esc when it's open.
      if (document.querySelector('[data-lightbox-active="true"]')) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (fullscreen) {
        setFullscreen(false);
      } else {
        onClose();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [fullscreen, onClose]);

  return (
    <>
      {!fullscreen && (
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
        data-hotkeys-dialog="true"
        className={fullscreen ? 'fixed inset-0 z-[9998] flex flex-col shadow-2xl' : `absolute inset-y-0 right-0 z-30 ${wide ? 'w-[min(96vw,1100px)]' : 'w-[min(92vw,780px)]'} max-w-full flex flex-col shadow-2xl`}
        style={{
          background: "var(--color-bg)",
          ...(fullscreen ? {} : { borderLeft: "1px solid var(--color-border)" }),
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
              title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
              style={{ color: "var(--color-text-muted)" }}
              onMouseEnter={(e) => e.currentTarget.style.background = "var(--color-bg-tertiary)"}
              onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
            >
              {fullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
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
        <div className="flex-1 overflow-auto">
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
              {renderer.renderFull({ content, onImageClick: setLightboxUrl, onSvgClick: setLightboxSvg })}
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
      <ImageLightbox
        imageUrl={lightboxUrl}
        svgContent={lightboxSvg}
        onClose={() => { setLightboxUrl(null); setLightboxSvg(null); }}
      />
    </>
  );
}
