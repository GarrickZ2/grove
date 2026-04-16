import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Download, Trash2, Eye,
  Loader2, Upload, MoreHorizontal, FolderOpen, RefreshCw, ArrowUpFromLine,
} from "lucide-react";
import type { Task } from "../../../../data/types";
import {
  listArtifacts, previewArtifact, artifactDownloadUrl, deleteArtifact,
  uploadArtifacts, syncArtifactToResource, listArtifactWorkdirs, addArtifactWorkdir, deleteArtifactWorkdir, openArtifactWorkdir,
  listResources,
  type ArtifactFile, type ArtifactWorkDirectoryEntry,
} from "../../../../api";
import { apiClient } from "../../../../api/client";
import {
  VSCodeIcon,
  FilePreviewDrawer,
  getPreviewType,
  canPreviewFile,
  getExtBadge,
  downloadViaIframe,
  formatSize,
  formatTime,
  FileConflictDialog,
} from "../../../ui";

interface ArtifactsTabProps {
  projectId?: string;
  task: Task;
  previewRequest?: ArtifactPreviewRequest | null;
  lastChatIdleAt?: number;
  isChatBusy?: boolean;
}

interface LoadFilesOptions {
  silent?: boolean;
}

export interface ArtifactPreviewRequest {
  file: string;
  seq: number;
}

function dropContainsDirectory(dataTransfer: DataTransfer): boolean {
  for (const item of Array.from(dataTransfer.items || [])) {
    const entry = (item as DataTransferItem & {
      webkitGetAsEntry?: () => { isDirectory?: boolean } | null;
    }).webkitGetAsEntry?.();
    if (entry?.isDirectory) return true;
  }
  return false;
}

export function ArtifactsTab({ projectId, task, previewRequest, lastChatIdleAt, isChatBusy }: ArtifactsTabProps) {
  const [inputFiles, setInputFiles] = useState<ArtifactFile[]>([]);
  const [outputFiles, setOutputFiles] = useState<ArtifactFile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [syncConflict, setSyncConflict] = useState<{
    file: ArtifactFile;
    newName: string;
    existingNames: Set<string>;
  } | null>(null);

  const [previewFile, setPreviewFile] = useState<{ file: ArtifactFile; content: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [isUploading, setIsUploading] = useState(false);
  const isUploadingRef = useRef(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCountRef = useRef(0);
  const [uploadsOpen, setUploadsOpen] = useState(true);
  const [downloadsOpen, setDownloadsOpen] = useState(true);
  const [uploadsTab, setUploadsTab] = useState<"uploads" | "workdir">("uploads");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [workdirs, setWorkdirs] = useState<ArtifactWorkDirectoryEntry[]>([]);
  const [isLoadingWorkdirs, setIsLoadingWorkdirs] = useState(true);
  const [isAddingWorkdir, setIsAddingWorkdir] = useState(false);
  const [currentOutputPath, setCurrentOutputPath] = useState("");

  // Resizable split
  const containerRef = useRef<HTMLDivElement>(null);
  const [splitRatio, setSplitRatio] = useState(0.5);
  const isDraggingRef = useRef(false);
  const lastPreviewSeqRef = useRef(0);
  const lastGoodContentRef = useRef<string | null>(null);
  const liveRefreshSeqRef = useRef(0);
  const previousChatBusyRef = useRef(!!isChatBusy);
  const previewFileRef = useRef(previewFile);
  useEffect(() => { previewFileRef.current = previewFile; }, [previewFile]);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const refreshPreviewContent = useCallback((file: ArtifactFile, seq: number) => {
    if (!projectId || getPreviewType(file.name) === "image") return;
    previewArtifact(projectId, task.id, file.directory, file.path)
      .then((content) => {
        if (seq !== liveRefreshSeqRef.current) return;
        lastGoodContentRef.current = content;
        setPreviewFile({ file, content });
        setPreviewError(null);
      })
      .catch(() => {});
  }, [projectId, task.id]);

  useEffect(() => {
    if (!isChatBusy || !previewFile || !projectId) return;
    const seq = ++liveRefreshSeqRef.current;
    const file = previewFile.file;
    const timer = setInterval(() => {
      refreshPreviewContent(file, seq);
    }, 10_000);
    return () => clearInterval(timer);
  }, [isChatBusy, previewFile, projectId, refreshPreviewContent]);

  // Auto-dismiss toast after 3 seconds
  useEffect(() => {
    if (!toastMessage) return;
    const timer = setTimeout(() => setToastMessage(null), 3000);
    return () => clearTimeout(timer);
  }, [toastMessage]);

  const loadFiles = useCallback(async (options?: LoadFilesOptions) => {
    if (!projectId) return;
    const silent = options?.silent === true;
    if (!silent) setIsLoading(true);
    setError(null);
    try {
      const data = await listArtifacts(projectId, task.id);
      setInputFiles(data.input);
      setOutputFiles(data.output);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load files");
    } finally {
      if (!silent) setIsLoading(false);
    }
  }, [projectId, task.id]);

  const loadWorkdirs = useCallback(async () => {
    if (!projectId) return;
    setIsLoadingWorkdirs(true);
    try {
      const data = await listArtifactWorkdirs(projectId, task.id);
      setWorkdirs(data.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load work directories");
    } finally {
      setIsLoadingWorkdirs(false);
    }
  }, [projectId, task.id]);

  useEffect(() => { loadFiles(); loadWorkdirs(); }, [loadFiles, loadWorkdirs]);

  // Refresh when ACP chat finishes work.
  // Use isUploadingRef (not isUploading state) to avoid stale closure:
  // the ref always reflects the current upload state when this effect fires.
  useEffect(() => {
    if (lastChatIdleAt === undefined) return;
    if (!isUploadingRef.current) void loadFiles({ silent: true });
  }, [lastChatIdleAt, loadFiles]);

  const handleUpload = useCallback(async (files: FileList | File[]) => {
    if (!projectId || files.length === 0) return;
    isUploadingRef.current = true;
    setIsUploading(true);
    setError(null);
    try {
      await uploadArtifacts(projectId, task.id, Array.from(files));
      await loadFiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      isUploadingRef.current = false;
      setIsUploading(false);
    }
  }, [projectId, task.id, loadFiles]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCountRef.current = 0;
    setIsDragOver(false);
    if (uploadsTab === "workdir") {
      setError("Drag-and-drop folders are not supported for Work Directory yet. Use Add Folder.");
      return;
    }
    if (dropContainsDirectory(e.dataTransfer)) {
      setError("Folders are not supported in Uploads. Use Work Directory and Add Folder.");
      return;
    }
    if (e.dataTransfer.files.length > 0) handleUpload(e.dataTransfer.files);
  }, [handleUpload, uploadsTab]);

  const handleAddWorkdir = useCallback(async () => {
    if (!projectId) return;
    setIsAddingWorkdir(true);
    try {
      const data = await apiClient.get<{ path: string | null }>("/api/v1/browse-folder");
      if (!data.path) return;
      await addArtifactWorkdir(projectId, task.id, data.path);
      await loadWorkdirs();
      setUploadsTab("workdir");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add folder");
    } finally {
      setIsAddingWorkdir(false);
    }
  }, [projectId, task.id, loadWorkdirs]);

  const handleDeleteWorkdir = useCallback(async (entry: ArtifactWorkDirectoryEntry) => {
    if (!projectId) return;
    try {
      await deleteArtifactWorkdir(projectId, task.id, entry.name);
      await loadWorkdirs();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove folder");
    }
  }, [projectId, task.id, loadWorkdirs]);

  const handleOpenWorkdir = useCallback(async (entry: ArtifactWorkDirectoryEntry) => {
    if (!projectId) return;
    try {
      await openArtifactWorkdir(projectId, task.id, entry.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open folder");
    }
  }, [projectId, task.id]);

  const handlePreview = useCallback(async (file: ArtifactFile, force?: boolean) => {
    if (!projectId || file.is_dir) return;
    if (getPreviewType(file.name) === "image") {
      const url = artifactDownloadUrl(projectId, task.id, file.directory, file.path);
      setPreviewFile({ file, content: url });
      lastGoodContentRef.current = url;
      setPreviewError(null);
      return;
    }
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const content = await previewArtifact(projectId, task.id, file.directory, file.path);
      lastGoodContentRef.current = content;
      setPreviewFile({ file, content });
    } catch (err) {
      const message = err && typeof err === 'object' && 'message' in err
        ? (err as { message: string }).message
        : 'Failed to load preview';
      if (force || !lastGoodContentRef.current) {
        setPreviewFile({ file, content: `Error: ${message}` });
        setPreviewError(message);
      } else if (lastGoodContentRef.current && previewFileRef.current?.file.path === file.path) {
        setPreviewFile({ file, content: lastGoodContentRef.current });
      }
    } finally {
      setPreviewLoading(false);
    }
  }, [projectId, task.id]);

  useEffect(() => {
    const wasBusy = previousChatBusyRef.current;
    const busy = !!isChatBusy;
    previousChatBusyRef.current = busy;
    if (!wasBusy || busy || !previewFile) return;
    void handlePreview(previewFile.file, true);
  }, [isChatBusy, previewFile, handlePreview]);

  const [pendingPreview, setPendingPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!previewRequest || previewRequest.seq === lastPreviewSeqRef.current) return;
    lastPreviewSeqRef.current = previewRequest.seq;
    setPendingPreview(previewRequest.file);
  }, [previewRequest]);

  useEffect(() => {
    if (isLoading || !pendingPreview) return;
    const requestedPath = pendingPreview;
    setPendingPreview(null);

    const trimmedPath = requestedPath.trim().replace(/^\.?\//, "");
    if (!trimmedPath) return;
    const requestedSegments = trimmedPath.split("/");

    let requestedDir = requestedSegments[0] === "input" || requestedSegments[0] === "output"
      ? requestedSegments[0]
      : null;
    const normalizedRequestedPath = requestedDir
      ? requestedSegments.slice(1).join("/")
      : trimmedPath;

    const allFiles = [...inputFiles, ...outputFiles].filter((file) => !file.is_dir);

    let target = allFiles.find((file) =>
      (requestedDir === null || file.directory === requestedDir) && (
        file.path === normalizedRequestedPath ||
        file.name === normalizedRequestedPath ||
        file.path.endsWith(`/${normalizedRequestedPath}`)
      )
    );

    if (!target && !requestedDir) {
      const inputIdx = requestedSegments.findIndex(s => s === "input" || s === "output");
      if (inputIdx !== -1) {
        requestedDir = requestedSegments[inputIdx];
        const remainingSegments = requestedSegments.slice(inputIdx + 1);
        const relativePath = remainingSegments.join("/");
        target = allFiles.find((file) =>
          file.directory === requestedDir && (
            file.path === relativePath ||
            file.name === relativePath ||
            file.path.endsWith(`/${relativePath}`) ||
            file.name === relativePath.split("/").pop()
          )
        );
      }
    }

    if (!target) {
      const fileName = trimmedPath.split("/").pop() || trimmedPath;
      target = allFiles.find((file) => file.name === fileName);
    }

    if (!target) {
      setToastMessage(`"${trimmedPath.split("/").pop() || trimmedPath}" is outside scope`);
      return;
    }

    if (target.directory === "input") {
      setUploadsOpen(true);
      setUploadsTab("uploads");
    } else if (target.directory === "output") {
      setDownloadsOpen(true);
      setCurrentOutputPath(parentPath(target.path));
    }

    void handlePreview(target);
  }, [isLoading, pendingPreview, inputFiles, outputFiles, handlePreview]);

  const handleDownload = useCallback((file: ArtifactFile) => {
    if (!projectId || file.is_dir) return;
    downloadViaIframe(artifactDownloadUrl(projectId, task.id, file.directory, file.path));
  }, [projectId, task.id]);

  const handleDelete = useCallback(async (file: ArtifactFile) => {
    if (!projectId) return;
    try {
      await deleteArtifact(projectId, task.id, file.directory, file.path);
      await loadFiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete file");
    }
  }, [projectId, task.id, loadFiles]);

  const handleSyncToResource = useCallback(async (
    file: ArtifactFile,
    options?: { force?: boolean; renameTo?: string },
    cachedExistingNames?: Set<string>,
  ) => {
    if (!projectId) return;
    try {
      await syncArtifactToResource(projectId, task.id, file.directory, file.path, options);
      setToastMessage(`Synced "${options?.renameTo ?? file.name}" to Shared Assets`);
    } catch (err) {
      const apiErr = err as { status?: number; data?: unknown };
      if (apiErr.status === 409) {
        // Fetch resource root filenames once and cache them for the dialog
        const existingNames = cachedExistingNames ?? await (async () => {
          try {
            const data = await listResources(projectId);
            return new Set(data.files.map(f => f.name));
          } catch {
            return new Set<string>();
          }
        })();
        setSyncConflict({ file, newName: options?.renameTo ?? file.name, existingNames });
        return;
      }
      setError(err instanceof Error ? err.message : "Sync failed");
    }
  }, [projectId, task.id]);

  const handleOpenFolder = (dir: string) => {
    if (!projectId) return;
    apiClient.post(`/api/v1/projects/${projectId}/tasks/${task.id}/open-folder?dir=${encodeURIComponent(dir)}&path=.`).catch(() => {});
  };

  useEffect(() => {
    if (!currentOutputPath) return;
    const folderStillExists = outputFiles.some((file) => file.is_dir && file.path === currentOutputPath);
    if (!folderStillExists) setCurrentOutputPath("");
  }, [currentOutputPath, outputFiles]);

  // Resize handler
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    const startY = e.clientY;
    const startRatio = splitRatio;
    const container = containerRef.current;
    if (!container) return;
    const containerHeight = container.getBoundingClientRect().height;

    const onMove = (ev: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const delta = ev.clientY - startY;
      const newRatio = Math.max(0.15, Math.min(0.85, startRatio + delta / containerHeight));
      setSplitRatio(newRatio);
    };
    const onUp = () => {
      isDraggingRef.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }, [splitRatio]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-5 h-5 animate-spin" style={{ color: "var(--color-text-muted)" }} />
      </div>
    );
  }

  if (error && inputFiles.length === 0 && outputFiles.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <p className="text-sm" style={{ color: "var(--color-error)" }}>{error}</p>
        <button onClick={() => { void loadFiles(); }} className="text-xs hover:underline" style={{ color: "var(--color-highlight)" }}>Retry</button>
      </div>
    );
  }

  const inputFileCount = inputFiles.filter(f => !f.is_dir).length;
  const outputFileCount = outputFiles.filter(f => !f.is_dir).length;
  const outputEntries = getDirectChildren(outputFiles, currentOutputPath);

  return (
    <div
      className="flex flex-col h-full relative"
      style={{ color: "var(--color-text)", overflow: previewFile ? 'hidden' : undefined }}
    >
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => { if (e.target.files) handleUpload(e.target.files); e.target.value = ""; }}
      />

      {/* Preview drawer */}
      <AnimatePresence>
        {previewFile && (
          <FilePreviewDrawer
            fileName={previewFile.file.name}
            content={previewFile.content}
            loading={previewLoading}
            error={previewError}
            isLive={!!isChatBusy}
            onClose={() => { setPreviewFile(null); lastGoodContentRef.current = null; setPreviewError(null); }}
            onDownload={() => handleDownload(previewFile.file)}
            onRefresh={() => handlePreview(previewFile.file, true)}
          />
        )}
      </AnimatePresence>

      {/* Drag overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg pointer-events-none"
          style={{ background: "color-mix(in srgb, var(--color-highlight) 10%, transparent)", border: "2px dashed var(--color-highlight)" }}>
          <div className="flex flex-col items-center gap-2">
            {uploadsTab === "uploads"
              ? <Upload className="w-8 h-8" style={{ color: "var(--color-highlight)" }} />
              : <FolderOpen className="w-8 h-8" style={{ color: "var(--color-highlight)" }} />}
            <p className="text-sm font-medium" style={{ color: "var(--color-highlight)" }}>
              {uploadsTab === "uploads" ? "Drop files to upload" : "Use Add Folder for Work Directory"}
            </p>
          </div>
        </div>
      )}

      {/* Resizable two-section layout */}
      <div
        ref={containerRef}
        className="flex-1 flex flex-col min-h-0"
        onDrop={handleDrop}
        onDragEnter={(e) => { e.preventDefault(); dragCountRef.current++; setIsDragOver(true); }}
        onDragOver={(e) => { e.preventDefault(); }}
        onDragLeave={(e) => { e.preventDefault(); dragCountRef.current--; if (dragCountRef.current === 0) setIsDragOver(false); }}
      >
        {error && (
          <div className="text-xs px-4 py-2 shrink-0" style={{ color: "var(--color-error)" }}>{error}</div>
        )}

        {/* Uploads section */}
        <div className="flex flex-col min-h-0" style={{
          flex: !uploadsOpen ? "0 0 auto"
            : !downloadsOpen ? "1 1 0%"
            : `${splitRatio} 1 0%`,
          transition: "flex 0.25s ease",
          overflow: "hidden",
        }}>
          <SectionHeader
            title="Uploads"
            count={uploadsTab === "uploads" ? inputFileCount : workdirs.length}
            isOpen={uploadsOpen}
            onToggle={() => setUploadsOpen(!uploadsOpen)}
            onRefresh={uploadsTab === "uploads" ? () => { void loadFiles(); } : loadWorkdirs}
            onUpload={uploadsTab === "uploads" ? () => fileInputRef.current?.click() : handleAddWorkdir}
            onOpenFolder={uploadsTab === "uploads" ? () => handleOpenFolder("input") : undefined}
            isUploading={uploadsTab === "uploads" ? isUploading : isAddingWorkdir}
            uploadLabel={uploadsTab === "uploads" ? "Upload" : "Add Folder"}
            tabs={[
              { key: "uploads", label: "Uploads" },
              { key: "workdir", label: "Work Directory" },
            ]}
            activeTab={uploadsTab}
            onTabChange={(tab) => setUploadsTab(tab as "uploads" | "workdir")}
          />
          <div className="overflow-y-auto px-3 pt-3 pb-3 flex flex-col" style={{
            flex: uploadsOpen ? "1 1 0%" : "0 0 0px",
            opacity: uploadsOpen ? 1 : 0,
            transition: "flex 0.25s ease, opacity 0.2s ease",
            scrollbarWidth: "thin",
            scrollbarColor: "var(--color-border) transparent",
            overflow: uploadsOpen ? undefined : "hidden",
          }}>
            {uploadsTab === "uploads" ? (
              <>
                {inputFiles.filter(f => !f.is_dir).map((file) => (
                  <FileCard key={file.path} file={file} projectId={projectId} taskId={task.id}
                    onPreview={handlePreview} onDownload={handleDownload} onDelete={handleDelete} allowDelete
                    onSyncToResource={handleSyncToResource} />
                ))}
                {inputFileCount === 0 && (
                  <button onClick={() => fileInputRef.current?.click()}
                    className="w-full flex-1 rounded-lg cursor-pointer transition-all flex flex-col items-center justify-center gap-2 px-4"
                    style={{ border: "1.5px dashed var(--color-border)", minHeight: "100%" }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--color-text-muted)"; e.currentTarget.style.background = "color-mix(in srgb, var(--color-text) 3%, transparent)"; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--color-border)"; e.currentTarget.style.background = "transparent"; }}>
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center"
                      style={{ background: "var(--color-bg-secondary)", border: "1px solid var(--color-border)" }}>
                      <Upload className="w-4 h-4" style={{ color: "var(--color-text-muted)" }} />
                    </div>
                    <p className="text-[12px] font-medium" style={{ color: "var(--color-text-muted)" }}>
                      Drop files to upload
                    </p>
                    <p className="text-[11px]" style={{ color: "var(--color-text-muted)", opacity: 0.5 }}>
                      or click to browse
                    </p>
                  </button>
                )}
              </>
            ) : isLoadingWorkdirs ? (
              <div className="flex items-center justify-center min-h-[80px]">
                <Loader2 className="w-4 h-4 animate-spin" style={{ color: "var(--color-text-muted)" }} />
              </div>
            ) : workdirs.length === 0 ? (
              <button onClick={handleAddWorkdir}
                className="w-full flex-1 rounded-lg cursor-pointer transition-all flex flex-col items-center justify-center gap-2 px-4"
                style={{ border: "1.5px dashed var(--color-border)", minHeight: "100%" }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--color-text-muted)"; e.currentTarget.style.background = "color-mix(in srgb, var(--color-text) 3%, transparent)"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--color-border)"; e.currentTarget.style.background = "transparent"; }}>
                <div className="w-8 h-8 rounded-lg flex items-center justify-center"
                  style={{ background: "var(--color-bg-secondary)", border: "1px solid var(--color-border)" }}>
                  <FolderOpen className="w-4 h-4" style={{ color: "var(--color-text-muted)" }} />
                </div>
                <p className="text-[12px] font-medium" style={{ color: "var(--color-text-muted)" }}>
                  Add a folder
                </p>
                <p className="text-[11px]" style={{ color: "var(--color-text-muted)", opacity: 0.5 }}>
                  Link a read-only directory
                </p>
              </button>
            ) : (
              <div className="space-y-2">
                {workdirs.map((entry) => (
                  <WorkDirectoryCard
                    key={entry.name}
                    entry={entry}
                    onOpen={handleOpenWorkdir}
                    onDelete={handleDeleteWorkdir}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Resize handle — only when both sections open */}
        <div className="shrink-0"
          onMouseDown={uploadsOpen && downloadsOpen ? handleResizeStart : undefined}
          style={{
            height: uploadsOpen && downloadsOpen ? "5px" : "1px",
            borderTop: "1px solid var(--color-border)",
            background: "var(--color-bg)",
            transition: "height 0.25s ease",
            cursor: uploadsOpen && downloadsOpen ? "row-resize" : "default",
          }}
        />

        {/* Downloads section */}
        <div className="flex flex-col min-h-0" style={{
          flex: !downloadsOpen ? "0 0 auto"
            : !uploadsOpen ? "1 1 0%"
            : `${1 - splitRatio} 1 0%`,
          transition: "flex 0.25s ease",
          overflow: "hidden",
        }}>
          <SectionHeader
            title="Downloads"
            count={outputFileCount}
            isOpen={downloadsOpen}
            onToggle={() => setDownloadsOpen(!downloadsOpen)}
            onOpenFolder={() => handleOpenFolder("output")}
          />
          <div className="overflow-y-auto px-3 pb-3" style={{
            flex: downloadsOpen ? "1 1 0%" : "0 0 0px",
            opacity: downloadsOpen ? 1 : 0,
            transition: "flex 0.25s ease, opacity 0.2s ease",
            scrollbarWidth: "thin",
            scrollbarColor: "var(--color-border) transparent",
            overflow: downloadsOpen ? undefined : "hidden",
          }}>
            {outputFileCount > 0 && (
              <div className="mb-2 flex items-center gap-1.5 px-1 text-[11px]" style={{ color: "var(--color-text-muted)" }}>
                <button
                  type="button"
                  onClick={() => setCurrentOutputPath("")}
                  className="rounded px-1.5 py-0.5 transition-colors"
                  style={currentOutputPath ? {} : { color: "var(--color-text)" }}
                >
                  output
                </button>
                {currentOutputPath.split("/").filter(Boolean).map((segment, index, parts) => {
                  const nextPath = parts.slice(0, index + 1).join("/");
                  return (
                    <div key={nextPath} className="flex items-center gap-1.5">
                      <span>/</span>
                      <button
                        type="button"
                        onClick={() => setCurrentOutputPath(nextPath)}
                        className="rounded px-1.5 py-0.5 transition-colors"
                        style={index === parts.length - 1 ? { color: "var(--color-text)" } : undefined}
                      >
                        {segment}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {outputEntries.map((entry) => (
              entry.is_dir ? (
                <FolderEntryRow
                  key={entry.path}
                  entry={entry}
                  onOpen={() => setCurrentOutputPath(entry.path)}
                />
              ) : (
                <FileCard key={entry.path} file={entry} projectId={projectId} taskId={task.id}
                  onPreview={handlePreview} onDownload={handleDownload}
                  onSyncToResource={handleSyncToResource} />
              )
            ))}
            {outputFileCount === 0 && (
              <div className="flex flex-col items-center justify-center h-full min-h-[80px] gap-1.5">
                <p className="text-[12px] font-medium" style={{ color: "var(--color-text-muted)", opacity: 0.5 }}>
                  No outputs yet
                </p>
                <p className="text-[11px] text-center" style={{ color: "var(--color-text-muted)", opacity: 0.35, maxWidth: "170px", lineHeight: "1.5" }}>
                  Files written by the AI agent will appear here
                </p>
              </div>
            )}
            {outputFileCount > 0 && outputEntries.length === 0 && (
              <div className="flex items-center justify-center h-full min-h-[80px]">
                <p className="text-xs opacity-50" style={{ color: "var(--color-text-muted)" }}>
                  This folder is empty
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {syncConflict && (
        <FileConflictDialog
          fileName={syncConflict.file.name}
          newName={syncConflict.newName}
          existingNames={syncConflict.existingNames}
          onNewNameChange={(v) => setSyncConflict({ ...syncConflict, newName: v })}
          onCancel={() => setSyncConflict(null)}
          onOverwrite={() => {
            const { file, existingNames } = syncConflict;
            setSyncConflict(null);
            void handleSyncToResource(file, { force: true }, existingNames);
          }}
          onRename={() => {
            const { file, newName, existingNames } = syncConflict;
            if (!newName.trim()) return;
            setSyncConflict(null);
            void handleSyncToResource(file, { renameTo: newName.trim() }, existingNames);
          }}
        />
      )}

      <AnimatePresence>
        {toastMessage && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="fixed top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] shadow-lg"
          >
            <span className="text-sm text-[var(--color-text)]">{toastMessage}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function parentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/");
}

function getDirectChildren(files: ArtifactFile[], parent: string): ArtifactFile[] {
  const normalizedParent = parent.trim().replace(/^\/+|\/+$/g, "");
  return files
    .filter((file) => parentPath(file.path) === normalizedParent)
    .sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      // Sort by modified_at descending (newest first)
      const timeA = a.modified_at ? new Date(a.modified_at).getTime() : 0;
      const timeB = b.modified_at ? new Date(b.modified_at).getTime() : 0;
      if (timeB !== timeA) return timeB - timeA;
      return a.name.localeCompare(b.name);
    });
}

/* ─── Section Header ─── */

function SectionHeader({
  title,
  count,
  isOpen,
  onToggle,
  onUpload,
  onOpenFolder,
  onRefresh,
  isUploading,
  uploadLabel,
  tabs,
  activeTab,
  onTabChange,
}: {
  title: string;
  count: number;
  isOpen?: boolean;
  onToggle?: () => void;
  onUpload?: () => void;
  onOpenFolder?: () => void;
  onRefresh?: () => void;
  isUploading?: boolean;
  uploadLabel?: string;
  tabs?: { key: string; label: string }[];
  activeTab?: string;
  onTabChange?: (tab: string) => void;
}) {
  return (
    <div className="flex items-center justify-between px-4 pt-4 pb-3 shrink-0 select-none"
      style={{ borderBottom: "1px solid var(--color-border)" }}>
      {/* Left: chevron + title + count */}
      <div className="flex items-center gap-2">
        {onToggle && (
          <button onClick={onToggle} className="p-0.5 rounded transition-colors"
            style={{ color: "var(--color-text-muted)" }}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"
              style={{ transform: isOpen ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}>
              <path d="M3 1.5L7 5L3 8.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <span className="text-[15px] font-semibold cursor-pointer"
          style={{ color: "var(--color-text)", letterSpacing: "-0.01em" }}
          onClick={onToggle}>
          {title}
        </span>
        <span className="text-[12px]" style={{ color: "var(--color-text-muted)" }}>{count}</span>
      </div>
      {/* Right: tabs + action buttons */}
      <div className="flex items-center gap-1.5">
        {isOpen !== false && tabs && activeTab && onTabChange && (
          <div className="inline-flex rounded-md p-0.5 mr-1"
            style={{ background: "var(--color-bg-tertiary)", border: "1px solid var(--color-border)" }}>
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => onTabChange(tab.key)}
                className="rounded px-2.5 py-1 text-[11px] font-medium transition-all"
                style={activeTab === tab.key
                  ? { background: "var(--color-bg)", color: "var(--color-text)", boxShadow: "0 1px 2px rgba(0,0,0,0.15)" }
                  : { color: "var(--color-text-muted)", background: "transparent" }}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}
        {isOpen !== false && onRefresh && (
          <button onClick={onRefresh}
            className="p-1 rounded transition-colors" title="Refresh"
            style={{ color: "var(--color-text-muted)" }}
            onMouseEnter={e => { e.currentTarget.style.background = "var(--color-bg-tertiary)"; e.currentTarget.style.color = "var(--color-text)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--color-text-muted)"; }}>
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        )}
        {isOpen !== false && onOpenFolder && (
          <button onClick={onOpenFolder}
            className="p-1 rounded transition-colors" title="Open in Finder"
            style={{ color: "var(--color-text-muted)" }}
            onMouseEnter={e => { e.currentTarget.style.background = "var(--color-bg-tertiary)"; e.currentTarget.style.color = "var(--color-text)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--color-text-muted)"; }}>
            <FolderOpen className="w-3.5 h-3.5" />
          </button>
        )}
        {isOpen !== false && onUpload && (
          <button onClick={onUpload} disabled={isUploading}
            className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium transition-colors disabled:opacity-50"
            style={{ color: "var(--color-text-muted)", border: "1px solid var(--color-border)", background: "none" }}
            onMouseEnter={e => { e.currentTarget.style.color = "var(--color-text)"; e.currentTarget.style.borderColor = "var(--color-text-muted)"; }}
            onMouseLeave={e => { e.currentTarget.style.color = "var(--color-text-muted)"; e.currentTarget.style.borderColor = "var(--color-border)"; }}>
            {isUploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
            {uploadLabel || "Upload"}
          </button>
        )}
      </div>
    </div>
  );
}

/* ─── FileCard ─── */

function WorkDirectoryCard({
  entry,
  onOpen,
  onDelete,
}: {
  entry: ArtifactWorkDirectoryEntry;
  onOpen: (entry: ArtifactWorkDirectoryEntry) => void;
  onDelete: (entry: ArtifactWorkDirectoryEntry) => void;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-lg"
      style={{ background: "var(--color-bg-secondary)" }}>
      <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
        style={{ background: "var(--color-bg-tertiary)" }}>
        <FolderOpen className="w-4 h-4" style={{ color: "var(--color-highlight)" }} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[13px] truncate font-medium">{entry.name}</span>
          <span className="text-[9px] px-1 py-0.5 rounded font-mono uppercase shrink-0 leading-none"
            style={{
              background: "var(--color-bg-tertiary)",
              color: entry.exists ? "var(--color-success)" : "var(--color-warning)",
            }}>
            {entry.exists ? "READ-ONLY" : "MISSING"}
          </span>
        </div>
        <div className="text-[11px] truncate mt-0.5" style={{ color: "var(--color-text-muted)" }}>
          {entry.target_path}
        </div>
      </div>
      <button onClick={() => onOpen(entry)}
        className="p-1.5 rounded-md transition-all shrink-0"
        style={{ color: "var(--color-text-muted)" }}>
        <Eye className="w-4 h-4" />
      </button>
      <button onClick={() => onDelete(entry)}
        className="p-1.5 rounded-md transition-all shrink-0"
        style={{ color: "var(--color-text-muted)" }}>
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  );
}

function FolderEntryRow({
  entry,
  onOpen,
}: {
  entry: ArtifactFile;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-center gap-3 px-3 py-2 rounded-lg text-left transition-all"
      onMouseEnter={e => e.currentTarget.style.background = "var(--color-bg-secondary)"}
      onMouseLeave={e => e.currentTarget.style.background = "transparent"}
    >
      <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
        style={{ background: "var(--color-bg-tertiary)" }}>
        <FolderOpen className="w-4 h-4" style={{ color: "var(--color-highlight)" }} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] truncate font-medium">{entry.name}</div>
        <div className="text-[11px] mt-0.5" style={{ color: "var(--color-text-muted)" }}>
          Folder
        </div>
      </div>
    </button>
  );
}

/* ─── FileCard ─── */

function FileCard({
  file, projectId, taskId, onPreview, onDownload, onDelete, allowDelete, onSyncToResource,
}: {
  file: ArtifactFile; projectId?: string; taskId: string;
  onPreview: (f: ArtifactFile) => void; onDownload: (f: ArtifactFile) => void;
  onDelete?: (f: ArtifactFile) => void; allowDelete?: boolean;
  onSyncToResource?: (f: ArtifactFile) => void;
}) {
  const canPreview = canPreviewFile(file.name);
  const ext = getExtBadge(file.name);
  const isImage = getPreviewType(file.name) === "image";
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!showMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowMenu(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showMenu]);

  const openMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 4, left: rect.right - 140 });
    }
    setShowMenu(!showMenu);
  };

  return (
    <div
      className="group flex items-center gap-3 px-3 py-2 rounded-lg transition-all cursor-pointer"
      onClick={() => canPreview ? onPreview(file) : onDownload(file)}
      onMouseEnter={e => e.currentTarget.style.background = "var(--color-bg-secondary)"}
      onMouseLeave={e => e.currentTarget.style.background = "transparent"}
    >
      {isImage && projectId ? (
        <div className="w-9 h-9 rounded-lg overflow-hidden shrink-0"
          style={{ background: "var(--color-bg-tertiary)", border: "1px solid var(--color-border)" }}>
          <img src={artifactDownloadUrl(projectId, taskId, file.directory, file.path)} alt="" className="w-full h-full object-cover" />
        </div>
      ) : (
        <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: "var(--color-bg-tertiary)" }}>
          <VSCodeIcon filename={file.name} size={18} />
        </div>
      )}

      <div className="flex-1 min-w-0">
        <span className="text-[13px] truncate font-medium block">
          {file.path.includes("/") ? file.path : file.name}
        </span>
        <div className="flex items-center gap-1.5 mt-0.5">
          {ext && (
            <span className="text-[9px] px-1.5 py-0.5 rounded font-mono uppercase shrink-0 leading-none"
              style={{ background: "var(--color-bg-tertiary)", color: "var(--color-text-muted)", border: "1px solid var(--color-border)" }}>
              {ext}
            </span>
          )}
          <span className="text-[11px] tabular-nums" style={{ color: "var(--color-text-muted)" }}>{formatSize(file.size)}</span>
          {file.modified_at && (
            <>
              <span style={{ color: "var(--color-border)" }}>·</span>
              <span className="text-[11px]" style={{ color: "var(--color-text-muted)", opacity: 0.6 }}>{formatTime(file.modified_at)}</span>
            </>
          )}
        </div>
      </div>

      <button ref={btnRef} onClick={openMenu}
        className="p-1.5 rounded-md opacity-0 group-hover:opacity-100 transition-all shrink-0"
        style={{ color: "var(--color-text-muted)" }}
        onMouseEnter={e => { e.currentTarget.style.background = "var(--color-bg-tertiary)"; e.currentTarget.style.color = "var(--color-text)"; }}
        onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--color-text-muted)"; }}>
        <MoreHorizontal className="w-4 h-4" />
      </button>
      {showMenu && menuPos && createPortal(
        <div ref={menuRef} className="fixed z-[9999] min-w-[140px] rounded-lg shadow-lg py-1"
          style={{ top: menuPos.top, left: menuPos.left, background: "var(--color-bg)", border: "1px solid var(--color-border)" }}>
          {canPreview && (
            <button onClick={(e) => { e.stopPropagation(); setShowMenu(false); onPreview(file); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors"
              onMouseEnter={e => e.currentTarget.style.background = "var(--color-bg-secondary)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <Eye className="w-3.5 h-3.5" /> Preview
            </button>
          )}
          <button onClick={(e) => { e.stopPropagation(); setShowMenu(false); onDownload(file); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors"
            onMouseEnter={e => e.currentTarget.style.background = "var(--color-bg-secondary)"}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <Download className="w-3.5 h-3.5" /> Download
          </button>
          {onSyncToResource && (
            <button onClick={(e) => { e.stopPropagation(); setShowMenu(false); onSyncToResource(file); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors"
              onMouseEnter={e => e.currentTarget.style.background = "var(--color-bg-secondary)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <ArrowUpFromLine className="w-3.5 h-3.5" /> Sync to Shared Assets
            </button>
          )}
          {allowDelete && onDelete && (
            <>
              <div className="my-1" style={{ borderTop: "1px solid var(--color-border)" }} />
              <button onClick={(e) => { e.stopPropagation(); setShowMenu(false); onDelete(file); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors"
                style={{ color: "var(--color-error)" }}
                onMouseEnter={e => e.currentTarget.style.background = "color-mix(in srgb, var(--color-error) 10%, transparent)"}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <Trash2 className="w-3.5 h-3.5" /> Delete
              </button>
            </>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}

