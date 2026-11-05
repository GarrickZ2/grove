import { Download, File, FileArchive, FileAudio, FileVideo, SquareArrowOutUpRight, Type, type LucideIcon } from "lucide-react";
import { formatSize } from "./FileListUtils";
import { fileExtension, fileInfoCategory } from "./filePreviewPolicy";

const ICONS: Record<string, LucideIcon> = {
  archive: FileArchive,
  audio: FileAudio,
  video: FileVideo,
  font: Type,
};

interface FileInfoPreviewProps {
  fileName: string;
  fileSize?: number;
  onDownload?: () => void;
  /** Open with the default app of the machine hosting Grove. */
  onOpenFile?: () => void;
}

/** What a file we cannot show looks like: what it is and what to do with it. */
export function FileInfoPreview({ fileName, fileSize, onDownload, onOpenFile }: FileInfoPreviewProps) {
  const Icon = ICONS[fileInfoCategory(fileName)] ?? File;
  const name = fileName.split("/").pop() ?? fileName;
  const facts = [fileExtension(fileName).toUpperCase(), fileSize === undefined ? "" : formatSize(fileSize)]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex h-full min-h-[320px] w-full flex-col items-center justify-center gap-5 p-8 text-center">
      <div
        className="flex h-16 w-16 items-center justify-center rounded-2xl"
        style={{ background: "var(--color-bg-tertiary)", color: "var(--color-text-muted)" }}
      >
        <Icon className="h-7 w-7" strokeWidth={1.5} />
      </div>
      <div className="flex min-w-0 max-w-full flex-col gap-1">
        <p className="truncate text-sm font-medium" style={{ color: "var(--color-text)" }} title={name}>{name}</p>
        {facts && <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>{facts}</p>}
      </div>
      <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>This file can't be previewed here.</p>
      {(onDownload || onOpenFile) && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {onDownload && (
            <button
              type="button"
              onClick={onDownload}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition-opacity hover:opacity-90"
              style={{ background: "var(--color-text)", color: "var(--color-bg)" }}
            >
              <Download className="h-3.5 w-3.5" />
              Download
            </button>
          )}
          {onOpenFile && (
            <button
              type="button"
              onClick={onOpenFile}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-colors hover:bg-[var(--color-bg-tertiary)]"
              style={{ borderColor: "var(--color-border)", color: "var(--color-text)" }}
            >
              <SquareArrowOutUpRight className="h-3.5 w-3.5" />
              Open in default app
            </button>
          )}
        </div>
      )}
    </div>
  );
}
