import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Download, Trash2, Eye,
  Loader2, Upload, MoreHorizontal, FolderOpen, FolderSearch, RefreshCw, ArrowUpFromLine,
  Link as LinkIcon, Edit3, Plus, SquareArrowOutUpRight,
} from "lucide-react";
import type { Task } from "../../../../data/types";
import {
  artifactDownloadUrl,
  type ArtifactFile, type ArtifactWorkDirectoryEntry, type DisplayItem,
} from "../../../../api";
import { useAuthenticatedFileUrl } from "../../../../hooks/useAuthenticatedFileUrl";
import {
  VSCodeIcon,
  FilePreviewDrawer,
  getPreviewType,
  canPreviewFile,
  getExtBadge,
  formatSize,
  formatTime,
  FileConflictDialog,
  AddLinkDialog,
  isLinkFile,
  linkDisplayName,
} from "../../../ui";
import { useOrbitInterface } from "../../../../orbit/ui/interfaceContext";
import { OrbitArtifactsPanel } from "../../../../orbit/workspace/artifacts/OrbitArtifactsPanel";
import { useArtifactsPanel, type ArtifactPreviewRequest } from "./useArtifactsPanel";
import { dragCarriesGrovePath, dropContainsDirectory, getDirectChildren, parentPath } from "./artifactsModel";

export type { ArtifactPreviewRequest } from "./useArtifactsPanel";

interface ArtifactsTabProps {
  projectId?: string;
  task: Task;
  previewRequest?: ArtifactPreviewRequest | null;
  lastChatIdleAt?: number;
  isChatBusy?: boolean;
}

/** Task Artifacts panel: Orbit renders its own body; Workbench keeps the split Uploads / Downloads layout. */
export function ArtifactsTab(props: ArtifactsTabProps) {
  const orbit = useOrbitInterface();
  return orbit ? <OrbitArtifactsPanel {...props} /> : <WorkbenchArtifactsTab {...props} />;
}

function WorkbenchArtifactsTab({ projectId, task, previewRequest, lastChatIdleAt, isChatBusy }: ArtifactsTabProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCountRef = useRef(0);
  const [uploadsOpen, setUploadsOpen] = useState(true);
  const [downloadsOpen, setDownloadsOpen] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [currentOutputPath, setCurrentOutputPath] = useState("");

  const revealTarget = useCallback((target: ArtifactFile) => {
    if (target.directory === "input") {
      setUploadsOpen(true);
    } else if (target.directory === "output") {
      setDownloadsOpen(true);
      setCurrentOutputPath(parentPath(target.path));
    }
  }, []);

  const {
    inputFiles, outputFiles, isLoading, error, setError, toastMessage,
    syncConflict, setSyncConflict, overwriteSyncConflict, renameSyncConflict,
    previewFile, previewLoading, previewError, closePreview,
    isUploading, addLinkOpen, setAddLinkOpen, editLink, setEditLink,
    workdirs, isLoadingWorkdirs, isAddingWorkdir,
    loadFiles, loadWorkdirs, handleUpload, handleAddWorkdir, handleDeleteWorkdir, handleOpenWorkdir,
    handlePreview, handleDownload, handleOpenInApp, handleRevealInFileManager,
    handleCreatePreviewComment, handleUpdatePreviewComment, removePreviewComment,
    currentFilePreviewDrafts, currentFilePreviewMarkers,
    handleOpenLink, handleEditLink, handleDelete, handleSyncToResource, handleOpenFolder,
    submitAddLink, submitEditLink, folderPicker,
  } = useArtifactsPanel({ projectId, task, previewRequest, lastChatIdleAt, isChatBusy, onRevealTarget: revealTarget });

  // Resizable split
  const containerRef = useRef<HTMLDivElement>(null);
  const [splitRatio, setSplitRatio] = useState(0.5);
  const isDraggingRef = useRef(false);

  const handleDrop = useCallback((e: React.DragEvent) => {
    // Internal file drag (from FileCard / FileTree) — let it propagate to other
    // drop targets (e.g. the chat composer). Don't show the upload overlay or
    // try to upload, since these aren't OS files.
    if (dragCarriesGrovePath(e.dataTransfer)) {
      e.preventDefault();
      dragCountRef.current = 0;
      setIsDragOver(false);
      return;
    }
    e.preventDefault();
    dragCountRef.current = 0;
    setIsDragOver(false);
    if (dropContainsDirectory(e.dataTransfer)) {
      setError("Folders are not supported in drag-and-drop. Use the Add button.");
      return;
    }
    if (e.dataTransfer.files.length > 0) handleUpload(e.dataTransfer.files);
  }, [handleUpload, setError]);

  useEffect(() => {
    if (!currentOutputPath) return;
    const folderStillExists = outputFiles.some((file) => file.is_dir && file.path === currentOutputPath);
    if (!folderStillExists) Promise.resolve().then(() => setCurrentOutputPath(""));
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

  const inputFileCount = inputFiles.filter(f => !f.is_dir).length;
  const outputFileCount = outputFiles.filter(f => !f.is_dir).length;
  const uploadDisplayItems = useMemo<DisplayItem<ArtifactFile>[]>(() => {
    const items: DisplayItem<ArtifactFile>[] = [];
    for (const wd of workdirs) {
      items.push({ type: "workdir", data: wd });
    }
    for (const f of inputFiles) {
      if (!f.is_dir) items.push({ type: "file", data: f });
    }
    items.sort((a, b) => {
      const aIsDir = a.type === "workdir" ? 0 : 1;
      const bIsDir = b.type === "workdir" ? 0 : 1;
      if (aIsDir !== bIsDir) return aIsDir - bIsDir;
      return a.data.name.localeCompare(b.data.name);
    });
    return items;
  }, [workdirs, inputFiles]);

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
            downloadUrl={previewFile.downloadUrl}
            loading={previewLoading}
            error={previewError}
            isLive={!!isChatBusy}
            onClose={closePreview}
            onDownload={() => handleDownload(previewFile.file)}
            onRefresh={() => handlePreview(previewFile.file, true)}
            onCreatePreviewComment={(locator, comment, rendererId) =>
              handleCreatePreviewComment(previewFile.file, locator, comment, rendererId)
            }
            onUpdatePreviewComment={handleUpdatePreviewComment}
            onDeletePreviewComment={removePreviewComment}
            previewCommentDrafts={currentFilePreviewDrafts}
            previewCommentMarkers={currentFilePreviewMarkers}
            sketchContext={projectId ? { projectId, taskId: task.id } : undefined}
            location={projectId ? {
              projectId,
              root: { kind: "task", taskId: task.id },
              path: `${previewFile.file.directory}/${previewFile.file.path}`,
            } : undefined}
          />
        )}
      </AnimatePresence>

      {/* Drag overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg pointer-events-none"
          style={{ background: "color-mix(in srgb, var(--color-highlight) 10%, transparent)", border: "2px dashed var(--color-highlight)" }}>
          <div className="flex flex-col items-center gap-2">
            <Upload className="w-8 h-8" style={{ color: "var(--color-highlight)" }} />
            <p className="text-sm font-medium" style={{ color: "var(--color-highlight)" }}>
              Drop files to upload
            </p>
          </div>
        </div>
      )}

      {/* Resizable two-section layout */}
      <div
        ref={containerRef}
        className="flex-1 flex flex-col min-h-0"
        onDrop={handleDrop}
        onDragEnter={(e) => {
          // Internal file drags (FileCard / FileTree) should pass through to
          // other drop targets like the chat composer — don't show the upload
          // overlay or claim the drop.
          if (dragCarriesGrovePath(e.dataTransfer)) return;
          e.preventDefault();
          dragCountRef.current++;
          setIsDragOver(true);
        }}
        onDragOver={(e) => {
          if (dragCarriesGrovePath(e.dataTransfer)) return;
          e.preventDefault();
        }}
        onDragLeave={(e) => {
          if (dragCarriesGrovePath(e.dataTransfer)) return;
          e.preventDefault();
          dragCountRef.current--;
          if (dragCountRef.current === 0) setIsDragOver(false);
        }}
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
            count={inputFileCount + workdirs.length}
            isOpen={uploadsOpen}
            onToggle={() => setUploadsOpen(!uploadsOpen)}
            onRefresh={() => { void loadFiles(); loadWorkdirs(); }}
            onUpload={() => fileInputRef.current?.click()}
            isUploading={isUploading}
            onAddFolder={handleAddWorkdir}
            isAddingFolder={isAddingWorkdir}
            onAddLink={() => setAddLinkOpen(true)}
            onOpenFolder={() => handleOpenFolder("input")}
          />
          <div className="overflow-y-auto px-3 pt-3 pb-3 flex flex-col gap-2" style={{
            flex: uploadsOpen ? "1 1 0%" : "0 0 0px",
            opacity: uploadsOpen ? 1 : 0,
            transition: "flex 0.25s ease, opacity 0.2s ease",
            scrollbarWidth: "thin",
            scrollbarColor: "var(--color-border) transparent",
            overflow: uploadsOpen ? undefined : "hidden",
          }}>
            {isLoadingWorkdirs ? (
              <div className="flex items-center justify-center min-h-[80px]">
                <Loader2 className="w-4 h-4 animate-spin" style={{ color: "var(--color-text-muted)" }} />
              </div>
            ) : uploadDisplayItems.length === 0 ? (
              <button
                className="w-full flex-1 rounded-lg cursor-pointer transition-all flex flex-col items-center justify-center gap-2 px-4"
                style={{ border: "1.5px dashed var(--color-border)", minHeight: "100%" }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--color-text-muted)"; e.currentTarget.style.background = "color-mix(in srgb, var(--color-text) 3%, transparent)"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--color-border)"; e.currentTarget.style.background = "transparent"; }}>
                <div className="flex items-center gap-4">
                  <div className="flex flex-col items-center gap-1.5 cursor-pointer"
                    onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}>
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center"
                      style={{ background: "var(--color-bg-secondary)", border: "1px solid var(--color-border)" }}>
                      <Upload className="w-4 h-4" style={{ color: "var(--color-text-muted)" }} />
                    </div>
                    <p className="text-[12px] font-medium" style={{ color: "var(--color-text-muted)" }}>
                      Drop files to upload
                    </p>
                  </div>
                  <span className="text-[11px]" style={{ color: "var(--color-text-muted)", opacity: 0.3 }}>or</span>
                  <div className="flex flex-col items-center gap-1.5 cursor-pointer"
                    onClick={(e) => { e.stopPropagation(); void handleAddWorkdir(); }}>
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center"
                      style={{ background: "var(--color-bg-secondary)", border: "1px solid var(--color-border)" }}>
                      <Plus className="w-4 h-4" style={{ color: "var(--color-text-muted)" }} />
                    </div>
                    <p className="text-[12px] font-medium" style={{ color: "var(--color-text-muted)" }}>
                      Add a folder
                    </p>
                  </div>
                </div>
              </button>
            ) : (
              uploadDisplayItems.map((item) =>
                item.type === "workdir" ? (
                  <WorkDirectoryCard
                    key={`wd-${item.data.name}`}
                    entry={item.data}
                    onOpen={handleOpenWorkdir}
                    onDelete={handleDeleteWorkdir}
                  />
                ) : (
                  <FileCard key={`f-${item.data.directory}/${item.data.path}`} file={item.data} projectId={projectId} taskId={task.id}
                    onPreview={handlePreview} onDownload={handleDownload} onDelete={handleDelete} allowDelete
                    onSyncToResource={handleSyncToResource} onOpenLink={handleOpenLink} onEditLink={handleEditLink} onOpenInApp={handleOpenInApp} onRevealInFileManager={handleRevealInFileManager} />
                )
              )
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
            onOpenFolder={() => handleOpenFolder("output", currentOutputPath)}
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
                  viewPath={currentOutputPath}
                  onPreview={handlePreview} onDownload={handleDownload}
                  onSyncToResource={handleSyncToResource} onOpenLink={handleOpenLink} onEditLink={handleEditLink} onOpenInApp={handleOpenInApp} onRevealInFileManager={handleRevealInFileManager} />
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
          onOverwrite={overwriteSyncConflict}
          onRename={renameSyncConflict}
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
      <AddLinkDialog
        open={addLinkOpen}
        title="Add Link to Uploads"
        onClose={() => setAddLinkOpen(false)}
        onSubmit={submitAddLink}
      />
      <AddLinkDialog
        open={!!editLink}
        title="Edit Link"
        submitLabel="Save"
        initial={editLink?.initial}
        onClose={() => setEditLink(null)}
        onSubmit={submitEditLink}
      />
      {folderPicker}
    </div>
  );
}

/* ─── Section Header ─── */

function SectionHeader({
  title,
  count,
  isOpen,
  onToggle,
  onUpload,
  onAddLink,
  onOpenFolder,
  onRefresh,
  isUploading,
  onAddFolder,
  isAddingFolder,
  tabs,
  activeTab,
  onTabChange,
}: {
  title: string;
  count: number;
  isOpen?: boolean;
  onToggle?: () => void;
  onUpload?: () => void;
  onAddLink?: () => void;
  onOpenFolder?: () => void;
  onRefresh?: () => void;
  isUploading?: boolean;
  onAddFolder?: () => void;
  isAddingFolder?: boolean;
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
        {isOpen !== false && onAddLink && (
          <button onClick={onAddLink}
            className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium transition-colors"
            title="Add Link"
            style={{ color: "var(--color-text-muted)", border: "1px solid var(--color-border)", background: "none" }}
            onMouseEnter={e => { e.currentTarget.style.color = "var(--color-text)"; e.currentTarget.style.borderColor = "var(--color-text-muted)"; }}
            onMouseLeave={e => { e.currentTarget.style.color = "var(--color-text-muted)"; e.currentTarget.style.borderColor = "var(--color-border)"; }}>
            <LinkIcon className="w-3 h-3" />
            Add Link
          </button>
        )}
        {isOpen !== false && onAddFolder && (
          <button onClick={onAddFolder} disabled={isAddingFolder}
            className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium transition-colors disabled:opacity-50"
            style={{ color: "var(--color-text-muted)", border: "1px solid var(--color-border)", background: "none" }}
            onMouseEnter={e => { e.currentTarget.style.color = "var(--color-text)"; e.currentTarget.style.borderColor = "var(--color-text-muted)"; }}
            onMouseLeave={e => { e.currentTarget.style.color = "var(--color-text-muted)"; e.currentTarget.style.borderColor = "var(--color-border)"; }}>
            {isAddingFolder ? <Loader2 className="w-3 h-3 animate-spin" /> : <FolderOpen className="w-3 h-3" />}
            Add Folder
          </button>
        )}
        {isOpen !== false && onUpload && (
          <button onClick={onUpload} disabled={isUploading}
            className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium transition-colors disabled:opacity-50"
            style={{ color: "var(--color-text-muted)", border: "1px solid var(--color-border)", background: "none" }}
            onMouseEnter={e => { e.currentTarget.style.color = "var(--color-text)"; e.currentTarget.style.borderColor = "var(--color-text-muted)"; }}
            onMouseLeave={e => { e.currentTarget.style.color = "var(--color-text-muted)"; e.currentTarget.style.borderColor = "var(--color-border)"; }}>
            {isUploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
            Upload
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
      onMouseEnter={e => e.currentTarget.style.background = "var(--color-bg)"}
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
  file, projectId, taskId, viewPath = "", onPreview, onDownload, onDelete, allowDelete, onSyncToResource, onOpenLink, onEditLink, onOpenInApp, onRevealInFileManager,
}: {
  file: ArtifactFile; projectId?: string; taskId: string;
  viewPath?: string;
  onPreview: (f: ArtifactFile) => void; onDownload: (f: ArtifactFile) => void;
  onDelete?: (f: ArtifactFile) => void; allowDelete?: boolean;
  onSyncToResource?: (f: ArtifactFile) => void;
  onOpenLink?: (f: ArtifactFile) => void;
  onEditLink?: (f: ArtifactFile) => void;
  onOpenInApp?: (f: ArtifactFile) => void;
  onRevealInFileManager?: (f: ArtifactFile) => void;
}) {
  const canUseHostFileActions =
    typeof window !== "undefined" &&
    (window as unknown as Record<string, unknown>).__GROVE_REMOTE__ !== true;
  const revealLabel =
    typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent)
      ? "Show in Finder"
      : "Show in File Manager";
  // Mirror FileTree.tsx's drag protocol (`application/x-grove-file-path`) so the
  // chat composer can pick this up via its existing handleDrop and convert it
  // into an inline file chip. The path format `${directory}/${path}` matches
  // what `buildStudioMentionItems` produces for `input/*` / `output/*` entries,
  // so `insertFileChipAtPoint`'s `filteredFiles.find` lookup resolves and the
  // chip gets the right displayName (e.g. link-stripped name), category and
  // favicon without extra plumbing.
  const draggablePath = `${file.directory}/${file.path}`;
  const isLink = isLinkFile(file.name);
  const canPreview = !isLink && canPreviewFile(file.name);
  const ext = getExtBadge(file.name);
  const isImage = !isLink && getPreviewType(file.name) === "image";
  const thumbnailPath = isImage && projectId && /\.(png|jpe?g|webp|gif|bmp|ico)$/i.test(file.name)
    ? artifactDownloadUrl(projectId, taskId, file.directory, file.path)
    : null;
  const { url: thumbnailUrl, error: thumbnailError } = useAuthenticatedFileUrl(thumbnailPath);
  const displayName = isLink
    ? linkDisplayName(file.name)
    : viewPath && file.path.startsWith(viewPath + "/")
      ? file.path.slice(viewPath.length + 1)
      : file.name;
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!showMenu || !btnRef.current || !menuRef.current) return;
    const button = btnRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    const gap = 4;
    const margin = 8;
    const below = button.bottom + gap;
    const above = button.top - menu.height - gap;
    const top = below + menu.height <= window.innerHeight - margin
      ? below
      : Math.max(margin, Math.min(above, window.innerHeight - menu.height - margin));
    const left = Math.max(margin, Math.min(button.right - menu.width, window.innerWidth - menu.width - margin));
    setMenuPos({ top, left });
  }, [showMenu]);

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
      onClick={() => isLink ? onOpenLink?.(file) : canPreview ? onPreview(file) : onDownload(file)}
      onMouseEnter={e => e.currentTarget.style.background = "var(--color-bg)"}
      onMouseLeave={e => e.currentTarget.style.background = "transparent"}
      draggable={!file.is_dir}
      onDragStart={(e) => {
        if (file.is_dir) return;
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData("application/x-grove-file-path", draggablePath);
        e.dataTransfer.setData("application/x-grove-file-is-dir", "false");
        e.dataTransfer.setData("text/plain", draggablePath);
      }}
    >
      {isLink ? (
        <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 overflow-hidden bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
          {file.favicon ? (
            <img
              src={file.favicon}
              alt=""
              className="w-5 h-5 object-contain"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          ) : (
            <LinkIcon className="w-4 h-4" style={{ color: "var(--color-highlight)" }} />
          )}
        </div>
      ) : thumbnailPath ? (
        <div className="w-9 h-9 rounded-lg overflow-hidden shrink-0"
          style={{ background: "var(--color-bg-tertiary)", border: "1px solid var(--color-border)" }}>
          {thumbnailUrl ? <img src={thumbnailUrl} alt="" className="w-full h-full object-cover" />
            : thumbnailError ? <VSCodeIcon filename={file.name} size={18} /> : null}
        </div>
      ) : (
        <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: "var(--color-bg-tertiary)" }}>
          <VSCodeIcon filename={file.name} size={18} />
        </div>
      )}

      <div className="flex-1 min-w-0">
        <span className="text-[13px] truncate font-medium block">
          {displayName}
        </span>
        <div className="flex items-center gap-1.5 mt-0.5">
          {ext && (
            <span className="text-[9px] px-1.5 py-0.5 rounded font-mono uppercase shrink-0 leading-none"
              style={{ background: "var(--color-bg-tertiary)", color: "var(--color-text-muted)", border: "1px solid var(--color-border)" }}>
              {ext}
            </span>
          )}
          {isLink ? (
            <span className="text-[11px] truncate" style={{ color: "var(--color-text-muted)" }}>external link</span>
          ) : (
            <>
              <span className="text-[11px] tabular-nums" style={{ color: "var(--color-text-muted)" }}>{formatSize(file.size)}</span>
              {file.modified_at && (
                <>
                  <span style={{ color: "var(--color-border)" }}>·</span>
                  <span className="text-[11px]" style={{ color: "var(--color-text-muted)", opacity: 0.6 }}>{formatTime(file.modified_at)}</span>
                </>
              )}
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
        <div ref={menuRef} className="fixed z-[9999] min-w-[140px] max-h-[calc(100vh-16px)] overflow-y-auto rounded-lg shadow-lg py-1"
          style={{ top: menuPos.top, left: menuPos.left, background: "var(--color-bg)", border: "1px solid var(--color-border)" }}>
          {isLink && onOpenLink && (
            <button onClick={(e) => { e.stopPropagation(); setShowMenu(false); onOpenLink(file); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors"
              onMouseEnter={e => e.currentTarget.style.background = "var(--color-bg-secondary)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <LinkIcon className="w-3.5 h-3.5" /> Open in browser
            </button>
          )}
          {isLink && onEditLink && (
            <button onClick={(e) => { e.stopPropagation(); setShowMenu(false); onEditLink(file); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors"
              onMouseEnter={e => e.currentTarget.style.background = "var(--color-bg-secondary)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <Edit3 className="w-3.5 h-3.5" /> Edit
            </button>
          )}
          {canPreview && (
            <button onClick={(e) => { e.stopPropagation(); setShowMenu(false); onPreview(file); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors"
              onMouseEnter={e => e.currentTarget.style.background = "var(--color-bg-secondary)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <Eye className="w-3.5 h-3.5" /> Preview
            </button>
          )}
          {!isLink && (
            <button onClick={(e) => { e.stopPropagation(); setShowMenu(false); onDownload(file); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors"
              onMouseEnter={e => e.currentTarget.style.background = "var(--color-bg-secondary)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <Download className="w-3.5 h-3.5" /> Download
            </button>
          )}
          {!isLink && canUseHostFileActions && onOpenInApp && (
            <button onClick={(e) => { e.stopPropagation(); setShowMenu(false); onOpenInApp(file); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors"
              onMouseEnter={e => e.currentTarget.style.background = "var(--color-bg-secondary)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <SquareArrowOutUpRight className="w-3.5 h-3.5" /> Open
            </button>
          )}
          {!isLink && canUseHostFileActions && onRevealInFileManager && (
            <button onClick={(e) => { e.stopPropagation(); setShowMenu(false); onRevealInFileManager(file); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors"
              onMouseEnter={e => e.currentTarget.style.background = "var(--color-bg-secondary)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <FolderSearch className="w-3.5 h-3.5" /> {revealLabel}
            </button>
          )}
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
