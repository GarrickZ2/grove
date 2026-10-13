import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { File, Image, Mic, X } from "lucide-react";
import { useDefineCommand, useKeyboardScope } from "../../../keyboard";
import { openExternalUrl } from "../../../utils/openExternal";

interface QueueAttachment {
  type: string;
  data?: string;
  mime_type?: string;
  name?: string;
  label?: string;
  title?: string;
  uri?: string;
}

function attachmentName(attachment: QueueAttachment): string {
  return attachment.name || attachment.title || attachment.label
    || attachment.uri?.split(/[\\/]/).filter(Boolean).at(-1)
    || (attachment.type === "image" ? "Image" : attachment.type === "audio" ? "Audio" : "File");
}

function imageSource(attachment: QueueAttachment): string | undefined {
  return attachment.type === "image" && attachment.data
    ? `data:${attachment.mime_type || "image/png"};base64,${attachment.data}`
    : undefined;
}

function AttachmentTile({ attachment, large = false }: { attachment: QueueAttachment; large?: boolean }) {
  const source = imageSource(attachment);
  const [failedSource, setFailedSource] = useState<string>();
  const extension = attachmentName(attachment).split(".").at(-1);
  const fileType = extension && /^[a-z0-9]{1,4}$/i.test(extension) ? extension.toUpperCase() : "FILE";
  return (
    <span className={`flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] ${large ? "h-14 w-14" : "h-7 w-7"}`}>
      {source && source !== failedSource ? (
        <img src={source} alt={attachmentName(attachment)} className="h-full w-full object-cover" onError={() => setFailedSource(source)} />
      ) : attachment.type === "image" ? (
        <Image className={large ? "h-5 w-5" : "h-3.5 w-3.5"} />
      ) : attachment.type === "audio" ? (
        <Mic className={large ? "h-5 w-5" : "h-3.5 w-3.5"} />
      ) : (
        <span className="flex flex-col items-center gap-0.5">
          <File className={large ? "h-4 w-4" : "h-3 w-3"} />
          <span className="text-[7px] font-semibold leading-none">{fileType}</span>
        </span>
      )}
    </span>
  );
}

/** Compact attachment identifiers, with previews portaled out of the queue's scroll container. */
export function PendingQueueAttachments({ attachments, onImageClick }: {
  attachments: QueueAttachment[];
  onImageClick: (url: string) => void;
}) {
  const [overlay, setOverlay] = useState<{ mode: "hover" | "details"; index: number } | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  const detailsOpen = overlay?.mode === "details";

  const close = useCallback(() => {
    setOverlay(null);
    triggerRef.current?.focus();
  }, []);
  useKeyboardScope(`popover.pendingAttachments.${id}`, detailsOpen);
  useDefineCommand({
    id: `pendingAttachments.close.${id}`,
    name: "Close Pending Attachments",
    category: "Preview",
    scope: `popover.pendingAttachments.${id}`,
    defaultBindings: [{ key: "Escape" }],
    handler: close,
  });

  const positionPanel = useCallback(() => {
    const group = groupRef.current;
    const panel = panelRef.current;
    if (!group || !panel) return;
    const viewport = window.visualViewport;
    const leftEdge = (viewport?.offsetLeft ?? 0) + 8;
    const topEdge = (viewport?.offsetTop ?? 0) + 8;
    const rightEdge = leftEdge + (viewport?.width ?? window.innerWidth) - 16;
    const bottomEdge = topEdge + (viewport?.height ?? window.innerHeight) - 16;
    const anchor = group.getBoundingClientRect();
    const above = Math.max(0, anchor.top - topEdge - 6);
    const below = Math.max(0, bottomEdge - anchor.bottom - 6);
    panel.style.width = `${Math.min(detailsOpen ? 300 : 200, rightEdge - leftEdge)}px`;
    panel.style.maxHeight = `${Math.max(above, below)}px`;
    const height = panel.getBoundingClientRect().height;
    const top = above >= height || above >= below ? anchor.top - height - 6 : anchor.bottom + 6;
    panel.style.top = `${Math.max(topEdge, Math.min(top, bottomEdge - height))}px`;
    panel.style.left = `${Math.max(leftEdge, Math.min(anchor.left, rightEdge - panel.getBoundingClientRect().width))}px`;
    panel.style.visibility = "visible";
  }, [detailsOpen]);

  useLayoutEffect(() => {
    if (!overlay) return;
    positionPanel();
    if (overlay.mode === "details") panelRef.current?.focus();
  }, [overlay, positionPanel]);

  useEffect(() => {
    if (!overlay) return;
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !groupRef.current?.contains(event.target) && !panelRef.current?.contains(event.target)) setOverlay(null);
    };
    const dismissOnScroll = (event: Event) => {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return;
      setOverlay(null);
    };
    document.addEventListener("pointerdown", dismissOutside);
    window.addEventListener("scroll", dismissOnScroll, true);
    window.addEventListener("resize", positionPanel);
    window.visualViewport?.addEventListener("resize", positionPanel);
    window.visualViewport?.addEventListener("scroll", positionPanel);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      window.removeEventListener("scroll", dismissOnScroll, true);
      window.removeEventListener("resize", positionPanel);
      window.visualViewport?.removeEventListener("resize", positionPanel);
      window.visualViewport?.removeEventListener("scroll", positionPanel);
    };
  }, [overlay, positionPanel]);

  const dismissHover = () => setOverlay((current) => current?.mode === "hover" ? null : current);
  const showHover = (index: number) => setOverlay((current) => current?.mode === "details" ? current : { mode: "hover", index });
  const previewImage = (source: string) => {
    setOverlay(null);
    onImageClick(source);
  };
  const openDetails = (button: HTMLButtonElement) => {
    triggerRef.current = button;
    setOverlay((current) => current?.mode === "details" ? null : { mode: "details", index: 0 });
  };
  const hoveredAttachment = overlay ? attachments[overlay.index] : undefined;

  if (attachments.length === 0) return null;

  return (
    <div ref={groupRef} className="flex shrink-0 items-center gap-1">
      {attachments.slice(0, 2).map((attachment, index) => {
        const source = imageSource(attachment);
        return (
          <button
            key={index}
            type="button"
            aria-label={`${source ? "Preview" : "View"} ${attachmentName(attachment)}`}
            aria-haspopup="dialog"
            aria-expanded={source ? undefined : detailsOpen}
            aria-controls={!source && detailsOpen ? id : undefined}
            className="rounded-md transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-highlight)]"
            onMouseEnter={() => showHover(index)}
            onMouseLeave={dismissHover}
            onFocus={() => showHover(index)}
            onBlur={dismissHover}
            onClick={(event) => source ? previewImage(source) : openDetails(event.currentTarget)}
          >
            <AttachmentTile attachment={attachment} />
          </button>
        );
      })}
      {attachments.length > 2 && (
        <button
          type="button"
          aria-label={`View all ${attachments.length} attachments`}
          aria-haspopup="dialog"
          aria-expanded={detailsOpen}
          aria-controls={detailsOpen ? id : undefined}
          onClick={(event) => openDetails(event.currentTarget)}
          className="flex h-7 min-w-7 items-center justify-center rounded-md px-1 text-[10px] font-medium text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)] focus-visible:outline-2 focus-visible:outline-[var(--color-highlight)]"
        >
          +{attachments.length - 2}
        </button>
      )}
      {overlay && hoveredAttachment && createPortal(
        <div
          ref={panelRef}
          id={id}
          role={detailsOpen ? "dialog" : "tooltip"}
          aria-label={detailsOpen ? "Pending attachments" : attachmentName(hoveredAttachment)}
          tabIndex={detailsOpen ? -1 : undefined}
          className={`fixed z-[1000] overflow-y-auto overscroll-contain rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-[var(--color-text)] shadow-lg outline-none ${detailsOpen ? "" : "pointer-events-none"}`}
          style={{ visibility: "hidden" }}
        >
          {detailsOpen ? (
            <>
              <div className="mb-1 flex items-center justify-between px-1 text-[11px] font-medium text-[var(--color-text-muted)]">
                <span>Attachments · {attachments.length}</span>
                <button type="button" onClick={close} aria-label="Close attachments" className="rounded p-1 hover:bg-[var(--color-bg-tertiary)]"><X className="h-3.5 w-3.5" /></button>
              </div>
              {attachments.map((attachment, index) => {
                const source = imageSource(attachment);
                return (
                  <div key={index} className="flex items-start gap-2 rounded-lg p-1.5">
                    <button type="button" disabled={!source} onClick={() => source && previewImage(source)} aria-label={`Preview ${attachmentName(attachment)}`} className="shrink-0 rounded-md enabled:hover:opacity-80"><AttachmentTile attachment={attachment} large /></button>
                    <div className="min-w-0 flex-1 py-0.5">
                      <div className="break-words text-xs leading-4">{attachmentName(attachment)}</div>
                      <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">{attachment.mime_type || (attachment.type === "image" ? "Image" : attachment.type === "audio" ? "Audio" : "File")}</div>
                      {source && <button type="button" onClick={() => previewImage(source)} className="mt-1 text-[11px] text-[var(--color-highlight)]">Preview</button>}
                      {attachment.type === "audio" && attachment.data && <audio controls preload="none" src={`data:${attachment.mime_type || "audio/wav"};base64,${attachment.data}`} className="mt-1 h-8 w-full" />}
                      {attachment.type !== "image" && attachment.type !== "audio" && attachment.uri && <button type="button" onClick={() => openExternalUrl(attachment.uri!)} className="mt-1 text-[11px] text-[var(--color-highlight)]">Open file</button>}
                      {attachment.type === "image" && !source && <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">Preview unavailable</div>}
                    </div>
                  </div>
                );
              })}
            </>
          ) : (
            <>
              {imageSource(hoveredAttachment) && <img src={imageSource(hoveredAttachment)} alt={attachmentName(hoveredAttachment)} onLoad={positionPanel} className="mb-2 max-h-40 w-full rounded-lg object-contain" />}
              <div className="break-words px-1 text-xs">{attachmentName(hoveredAttachment)}</div>
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
