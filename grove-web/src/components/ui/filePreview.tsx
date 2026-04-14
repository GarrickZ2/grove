/* eslint-disable react-refresh/only-export-components */
import { motion } from "framer-motion";
import { Download, Eye, Loader2, RefreshCw, X } from "lucide-react";
import { getPreviewRenderer } from "../Review/previewRenderers";
import { highlightCode, detectLanguage } from "../Review/syntaxHighlight";


export function getExtBadge(name: string): string {
  return name.split(".").pop()?.toUpperCase() || "";
}

export function downloadViaIframe(url: string) {
  const iframe = document.createElement("iframe");
  iframe.style.display = "none";
  iframe.src = url;
  document.body.appendChild(iframe);
  setTimeout(() => iframe.remove(), 10000);
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
  return (
    <>
      <motion.div
        className="absolute inset-0 z-20 bg-black/20"
        onClick={onClose}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
      />
      <motion.div
        className={`absolute inset-y-0 right-0 z-30 ${wide ? 'w-[min(96vw,1100px)]' : 'w-[min(92vw,780px)]'} max-w-full flex flex-col shadow-2xl`}
        style={{
          background: "var(--color-bg)",
          borderLeft: "1px solid var(--color-border)",
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
          ) : renderer ? (
            <div className={renderer.id === 'image' || renderer.id === 'jsx' || renderer.id === 'html' ? 'h-full' : 'p-5'}>
              {renderer.renderFull({ content })}
            </div>
          ) : (() => {
            const lang = detectLanguage(fileName);
            const highlighted = lang ? highlightCode(content, lang) : null;
            return highlighted ? (
              <pre className="p-5 text-xs font-mono whitespace-pre leading-6 overflow-x-auto" style={{ color: "var(--color-text)" }}>
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
    </>
  );
}
