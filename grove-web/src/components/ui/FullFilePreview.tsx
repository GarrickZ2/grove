import { useEffect, useRef, useState, type Ref } from "react";
import { ArrowLeft, Loader2 } from 'lucide-react';
import { apiClient } from '../../api/client';
import { fileLocationUrl, resolveRelativeFilePath } from './fileLocation';
import {
  getPreviewRenderer,
  type PreviewRenderer,
  type RenderFullProps,
} from "../Review/previewRenderers";
import { PreviewCommentHost } from "../Review/PreviewCommentHost";
import {
  VirtualizedMarkdownRenderer,
  type VirtualizedMarkdownHandle,
  type VirtualizedMarkdownHeading,
} from "./VirtualizedMarkdownRenderer";
import { isVirtualizedMarkdownPreview } from "./filePreviewPolicy";

export interface FullFilePreviewProps extends Omit<RenderFullProps, "fileName"> {
  fileName: string;
  /** Reuse a renderer already resolved by the caller when available. */
  renderer?: PreviewRenderer;
  className?: string;
  markdownRef?: Ref<VirtualizedMarkdownHandle>;
  onMarkdownHeadingsChange?: (headings: VirtualizedMarkdownHeading[]) => void;
  onMarkdownSearchStateChange?: (total: number, current: number) => void;
  onMarkdownScrollerRef?: (element: HTMLElement | null) => void;
}

/**
 * The single full-file preview boundary used by Editor, Artifacts/Resources,
 * and full-file Review. File-type selection, layout ownership, and the
 * ordinary/virtualized Markdown policy live here so surfaces cannot drift.
 * Diff-segment rendering intentionally remains separate because it does not
 * receive a complete file.
 */
export function FullFilePreview(props: FullFilePreviewProps) {
  // A different source file starts a fresh navigation history. Live content
  // updates still reach the original page when returning from a linked file.
  return props.location && (props.renderer ?? getPreviewRenderer(props.fileName, 'full'))?.id === 'html'
    ? <NavigableFilePreview key={JSON.stringify(props.location)} {...props} />
    : <FilePreviewContent {...props} />;
}

function NavigableFilePreview(props: FullFilePreviewProps) {
  const [history, setHistory] = useState<FullFilePreviewProps[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const current = history.at(-1) ?? props;

  const navigate = async (reference: string) => {
    if (!current.location) return;
    const resolved = resolveRelativeFilePath(current.location.path, reference);
    if (!resolved) return;
    // Browser hrefs percent-encode spaces and non-ASCII filenames; the raw
    // endpoint expects an actual filesystem path, encoded exactly once.
    let path = resolved.path;
    try { path = decodeURIComponent(path); } catch { /* Keep literal malformed escapes. */ }
    const location = { ...current.location, path };
    const url = fileLocationUrl(location, resolved.suffix);
    const renderer = getPreviewRenderer(path, 'full');
    if (!renderer) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError(null);
    try {
      // Read through the authenticated client, including on mobile. Never
      // send the iframe directly to the server's application routes.
      const blob = await apiClient.getBlob(url.split('#')[0], controller.signal);
      const content = renderer.contentType === 'text' ? await blob.text() : url;
      if (controller.signal.aborted) return;
      setHistory((previous) => [...previous, {
        fileName: path, content, renderer, location, downloadUrl: url,
        htmlFragment: resolved.suffix.includes('#') ? resolved.suffix.slice(resolved.suffix.indexOf('#')) : '',
        onImageClick: props.onImageClick, onSvgClick: props.onSvgClick,
        sketchContext: props.sketchContext,
      }]);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not open linked file');
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  };

  return <div className="h-full min-h-0 flex flex-col">
    {(history.length > 0 || pending || error) && <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] p-2 text-xs">
      <button type="button" aria-label="Back to previous file" className="shrink-0 p-1 hover:bg-[var(--color-bg-tertiary)] rounded" onClick={() => {
        request.current?.abort();
        setPending(false);
        setError(null);
        if (!pending && !error) setHistory((previous) => previous.slice(0, -1));
      }}><ArrowLeft className="w-4 h-4" /></button>
      {pending && <Loader2 className="w-4 h-4 shrink-0 animate-spin" />}
      <span className="truncate" title={error ?? current.fileName} role={error ? 'alert' : undefined}>{error ?? current.fileName}</span>
    </div>}
    <div className="flex-1 min-h-0 overflow-auto">
      <FilePreviewContent {...current} onNavigateFile={(reference) => { void navigate(reference); }} />
    </div>
  </div>;
}

function FilePreviewContent({
  fileName,
  renderer: providedRenderer,
  className = "",
  content,
  downloadUrl,
  onImageClick,
  onSvgClick,
  previewComment,
  sketchContext,
  location,
  onNavigateFile,
  htmlFragment,
  markdownRef,
  onMarkdownHeadingsChange,
  onMarkdownSearchStateChange,
  onMarkdownScrollerRef,
}: FullFilePreviewProps) {
  const renderer = providedRenderer ?? getPreviewRenderer(fileName, "full");
  if (!renderer) return null;

  if (renderer.id === "markdown" && isVirtualizedMarkdownPreview(fileName, content)) {
    return (
      <div
        className={`h-full min-h-0 w-full ${className}`.trim()}
        data-file-preview-renderer="markdown"
        data-file-preview-virtualized="true"
      >
        <PreviewCommentHost previewComment={previewComment} fill>
          <VirtualizedMarkdownRenderer
            ref={markdownRef}
            content={content}
            onImageClick={onImageClick}
            onMermaidClick={onSvgClick}
            onD2Click={onSvgClick}
            sketchContext={sketchContext}
            sketchRenderMode="image"
            location={location}
            renderMode="document"
            onHeadingsChange={onMarkdownHeadingsChange}
            onSearchStateChange={onMarkdownSearchStateChange}
            onScrollerRef={onMarkdownScrollerRef}
            style={{ height: "100%" }}
          />
        </PreviewCommentHost>
      </div>
    );
  }

  const layoutClass = renderer.layout === "fill"
    ? "h-full min-h-0 w-full relative"
    : "w-full p-5";

  return (
    <div
      className={`${layoutClass} ${className}`.trim()}
      data-file-preview-renderer={renderer.id}
      data-file-preview-virtualized="false"
    >
      {renderer.renderFull({
        content,
        fileName,
        downloadUrl,
        onImageClick,
        onSvgClick,
        previewComment,
        sketchContext,
        location,
        onNavigateFile,
        htmlFragment,
      })}
    </div>
  );
}
