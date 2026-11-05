import { hostFileActionsAvailable } from "../../orbit/studio/studioView";
import { useEscapeScope } from "../../keyboard/useEscapeScope";
import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  Trash2, Upload, Loader2, MoreHorizontal, Download, Eye,
  FolderOpen, FolderSearch, Save, FileText, RefreshCw, Sparkles,
  Search, ArrowRight, Files, ShieldCheck, Clock3, X, Brain,
  FolderPlus, ChevronRight, Pencil, Check, CornerLeftUp, Edit3,
  Link as LinkIcon, SquareArrowOutUpRight,
} from "lucide-react";
import { useProject } from "../../context";
import { type ResourceFile, type WorkDirectoryEntry } from "../../api";
import { useBrowseFolder } from "../Projects/useBrowseFolder";
import {
  VSCodeIcon,
  FilePreviewDrawer,
  MarkdownRenderer,
  canPreviewFile,
  getExtBadge,
  formatSize,
  formatTime,
  FileConflictDialog,
  AddLinkDialog,
  isLinkFile,
  linkDisplayName,
} from "../ui";
import { ConfirmDialog } from "../Dialogs/ConfirmDialog";
import { DRAG_TYPE, INSTRUCTION_TEMPLATES, mergeResourceItems, resourceStats } from "./resourceModel";
import { useResourceLibrary } from "./useResourceLibrary";
import { useWorkspaceInstructions } from "./useWorkspaceInstructions";
import { useLegacyMemory } from "./useLegacyMemory";
import { useStudioCommands } from "./useStudioCommands";

export function ResourcePage() {
  const { browseFolder, folderPicker } = useBrowseFolder("Select Resource Folder");
  const { selectedProject } = useProject();
  const projectId = selectedProject?.id;

  const [isDragOver, setIsDragOver] = useState(false);
  const dragCountRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [mainPanel, setMainPanel] = useState<"assets" | "instructions" | "memory">("assets");

  const library = useResourceLibrary(projectId, browseFolder);
  const {
    files, workdirs, isLoadingFiles, isLoadingWorkdirs, fileError, workdirError,
    isUploading, isAddingWorkdir, loadFiles, loadWorkdirs,
    currentPath, navigateTo, searchQuery, setSearchQuery,
    isCreatingFolder, setIsCreatingFolder, newFolderName, setNewFolderName, handleCreateFolder,
    renamingPath, setRenamingPath, renameValue, setRenameValue, handleRenameFile,
    moveConflict, setMoveConflict, handleMoveFile, overwriteConflict, renameConflict,
    handleUpload, uploadFromDrop, handleAddWorkdir, handleDeleteWorkdir, handleOpenWorkdir,
    handleDelete, handlePreview, handleDownload, handleOpenInApp, handleRevealInFileManager,
    handleOpenLink, handleEditLink,
    addLinkOpen, setAddLinkOpen, submitAddLink, editLink, setEditLink, submitEditLink,
    previewFile, setPreviewFile, previewLoading,
  } = library;
  const newFolderInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const instructionsState = useWorkspaceInstructions(projectId);
  const {
    instructions, setInstructions, savedInstructions, isLoadingInstructions, isSaving, saveMessage,
    isEditingInstructions, setIsEditingInstructions, hasUnsaved, instructionLineCount,
    handleSaveInstructions, insertTemplate,
  } = instructionsState;
  const [searchFocused, setSearchFocused] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  useEscapeScope(searchFocused, () => { setSearchQuery(""); searchRef.current?.blur(); });

  const {
    memory, isLoadingMemory, isMigratingMemory, memoryMigrationOpen, setMemoryMigrationOpen, handleMigrateMemory,
  } = useLegacyMemory(projectId, { onMigrated: () => setMainPanel("assets") });

  const mergedItems = mergeResourceItems(files, workdirs, searchQuery);
  const { fileCount: fileOnlyCount, totalBytes, latestUpdate } = resourceStats(files);

  useEffect(() => {
    if (!isLoadingMemory && !memory.trim() && mainPanel === "memory") {
      void Promise.resolve().then(() => setMainPanel("assets"));
    }
  }, [isLoadingMemory, mainPanel, memory]);

  // Focus new folder input when it appears
  useEffect(() => {
    if (isCreatingFolder) setTimeout(() => newFolderInputRef.current?.focus(), 0);
  }, [isCreatingFolder]);

  // Focus rename input when it appears
  useEffect(() => {
    if (renamingPath) setTimeout(() => { renameInputRef.current?.focus(); renameInputRef.current?.select(); }, 0);
  }, [renamingPath]);

  const openFilePicker = useCallback(() => fileInputRef.current?.click(), []);
  useStudioCommands({ library, instructions: instructionsState, openFilePicker });

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCountRef.current = 0;
    setIsDragOver(false);
    uploadFromDrop(e.dataTransfer);
  };

  if (!selectedProject || selectedProject.projectType !== "studio") {
    return (
      <div className="flex items-center justify-center h-full">
        <p style={{ color: "var(--color-text-muted)" }}>Resource is only available for Studio projects.</p>
      </div>
    );
  }

  const breadcrumbSegments = currentPath.split("/").filter(Boolean);

  const showLegacyMemory = isLoadingMemory || memory.trim().length > 0;
  const availablePanels: readonly ("assets" | "instructions" | "memory")[] = showLegacyMemory
    ? ["assets", "instructions", "memory"]
    : ["assets", "instructions"];
  const rightPanels = availablePanels.filter(
    (p) => p !== mainPanel,
  );

  const renderAssetsPanel = ({ isMain }: { isMain: boolean }) => (
    <section className="min-h-[300px] h-full rounded-2xl border overflow-hidden flex flex-col xl:min-h-0"
      style={{ borderColor: "var(--color-border)", background: "var(--color-bg-secondary)" }}>
      <div className="flex flex-col gap-3 px-4 py-3 border-b"
        style={{ borderColor: "var(--color-border)" }}>
        <div className="flex flex-wrap items-start gap-3">
          <div
            className={`flex items-center gap-3 min-w-0 flex-1 rounded-lg transition-colors ${!isMain ? "cursor-pointer px-1 -mx-1" : ""}`}
            onClick={!isMain ? () => setMainPanel("assets") : undefined}
            onMouseEnter={e => { if (!isMain) e.currentTarget.style.background = "color-mix(in srgb, var(--color-highlight) 8%, transparent)"; }}
            onMouseLeave={e => { if (!isMain) e.currentTarget.style.background = "transparent"; }}
          >
            <div className="w-8 h-8 rounded-xl flex items-center justify-center"
              style={{ background: "color-mix(in srgb, var(--color-highlight) 12%, transparent)" }}>
              <FolderOpen className="w-4 h-4" style={{ color: "var(--color-highlight)" }} />
            </div>
            <div className="min-w-0 overflow-hidden">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm font-semibold truncate">Shared Assets</span>
                <span className="text-[11px] tabular-nums px-2 py-0.5 rounded-full shrink-0"
                  style={{
                    color: "var(--color-text-muted)",
                    background: "var(--color-bg)",
                  }}>
                  {mergedItems.length}
                </span>
              </div>
              {isMain && (
                <p className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>
                  Reusable files and linked folders available to all tasks through <span className="font-mono">resource/</span>
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button onClick={() => { loadFiles(); loadWorkdirs(); }}
              className="p-2 rounded-lg transition-colors"
              style={{ color: "var(--color-text-muted)" }}
              onMouseEnter={e => { e.currentTarget.style.background = "var(--color-bg-tertiary)"; e.currentTarget.style.color = "var(--color-text)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--color-text-muted)"; }}
              title="Refresh">
              <RefreshCw className="w-4 h-4" />
            </button>
            <button
              onClick={() => { setIsCreatingFolder(true); setNewFolderName(""); }}
              className="p-2 rounded-lg transition-colors"
              style={{ color: "var(--color-text-muted)" }}
              onMouseEnter={e => { e.currentTarget.style.background = "var(--color-bg-tertiary)"; e.currentTarget.style.color = "var(--color-text)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--color-text-muted)"; }}
              title="New folder">
              <FolderPlus className="w-4 h-4" />
            </button>
            <button
              onClick={() => setAddLinkOpen(true)}
              className="p-2 rounded-lg transition-colors"
              style={{ color: "var(--color-text-muted)" }}
              onMouseEnter={e => { e.currentTarget.style.background = "var(--color-bg-tertiary)"; e.currentTarget.style.color = "var(--color-text)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--color-text-muted)"; }}
              title="Add Link">
              <LinkIcon className="w-4 h-4" />
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
              style={{ color: "var(--color-highlight)", background: "color-mix(in srgb, var(--color-highlight) 10%, transparent)" }}
              onMouseEnter={e => e.currentTarget.style.background = "color-mix(in srgb, var(--color-highlight) 18%, transparent)"}
              onMouseLeave={e => e.currentTarget.style.background = "color-mix(in srgb, var(--color-highlight) 10%, transparent)"}>
              {isUploading
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <Upload className="w-4 h-4" />}
              Upload
            </button>
            <button
              onClick={handleAddWorkdir}
              disabled={isAddingWorkdir}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
              style={{ color: "var(--color-text-muted)", background: "var(--color-bg)" }}
              onMouseEnter={e => { e.currentTarget.style.background = "var(--color-bg-tertiary)"; e.currentTarget.style.color = "var(--color-text)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "var(--color-bg)"; e.currentTarget.style.color = "var(--color-text-muted)"; }}>
              {isAddingWorkdir
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <FolderOpen className="w-4 h-4" />}
              Add Folder
            </button>
          </div>
        </div>

        <BreadcrumbNav
          currentPath={currentPath}
          breadcrumbSegments={breadcrumbSegments}
          onNavigate={navigateTo}
          onDropToPath={handleMoveFile}
        />

        <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto]">
          <label
            className="flex items-center gap-2 rounded-xl border px-3 py-2"
            style={{ borderColor: "var(--color-border)", background: "color-mix(in srgb, var(--color-bg) 46%, transparent)" }}
          >
            <Search className="w-4 h-4 shrink-0" style={{ color: "var(--color-text-muted)" }} />
            <input
              ref={searchRef}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search files"
              className="w-full bg-transparent text-sm outline-none"
              style={{ color: "var(--color-text)" }}
            />
          </label>
          <div className="flex items-center gap-2 text-xs" style={{ color: "var(--color-text-muted)" }}>
            <span className="rounded-full px-2.5 py-1" style={{ background: "var(--color-bg)" }}>
              {mergedItems.length} items
            </span>
            <span className="rounded-full px-2.5 py-1" style={{ background: "var(--color-bg)" }}>
              Shared across studio
            </span>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 p-3">
        {isLoadingFiles || isLoadingWorkdirs ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-5 h-5 animate-spin" style={{ color: "var(--color-text-muted)" }} />
          </div>
        ) : fileError || workdirError ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed py-14 text-center"
            style={{ borderColor: "var(--color-border)" }}>
            {fileError && <p className="text-sm" style={{ color: "var(--color-error)" }}>{fileError}</p>}
            {workdirError && <p className="text-sm" style={{ color: "var(--color-error)" }}>{workdirError}</p>}
            {fileError && <button onClick={loadFiles} className="text-sm hover:underline" style={{ color: "var(--color-highlight)" }}>Retry files</button>}
            {workdirError && <button onClick={loadWorkdirs} className="text-sm hover:underline" style={{ color: "var(--color-highlight)" }}>Retry folders</button>}
          </div>
        ) : mergedItems.length === 0 && !isCreatingFolder ? (
          <button onClick={() => fileInputRef.current?.click()}
            className="w-full h-full min-h-[200px] rounded-2xl cursor-pointer transition-all flex flex-col items-center justify-center gap-3 px-6 text-center"
            style={{
              border: "1px dashed color-mix(in srgb, var(--color-highlight) 26%, var(--color-border))",
              background: "linear-gradient(180deg, color-mix(in srgb, var(--color-highlight) 5%, transparent), transparent)",
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--color-highlight)"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "color-mix(in srgb, var(--color-highlight) 26%, var(--color-border))"; }}>
            <div className="w-12 h-12 rounded-xl flex items-center justify-center"
              style={{ background: "color-mix(in srgb, var(--color-highlight) 12%, transparent)" }}>
              <Upload className="w-6 h-6" style={{ color: "var(--color-highlight)" }} />
            </div>
            <div>
              <p className="text-base font-semibold">Build a shared resource library</p>
              <p className="mt-2 text-sm max-w-md" style={{ color: "var(--color-text-muted)" }}>
                Drag files here or browse from disk. Upload assets or link local folders — both become instantly available to every task in this Studio.
              </p>
            </div>
            <div className="inline-flex items-center gap-1.5 text-sm font-medium"
              style={{ color: "var(--color-highlight)" }}>
              Browse files <ArrowRight className="w-4 h-4" />
            </div>
          </button>
        ) : mergedItems.length === 0 && !isCreatingFolder && searchQuery ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-[22px] border py-14 text-center"
            style={{ borderColor: "var(--color-border)", background: "color-mix(in srgb, var(--color-bg) 40%, transparent)" }}>
            <Search className="w-5 h-5" style={{ color: "var(--color-text-muted)" }} />
            <p className="text-sm font-medium">No files match "{searchQuery}"</p>
            <button
              onClick={() => setSearchQuery("")}
              className="text-sm hover:underline"
              style={{ color: "var(--color-highlight)" }}
            >
              Clear search
            </button>
          </div>
        ) : (
          <div className="h-full overflow-y-auto pr-1 [scrollbar-width:none] hover:[scrollbar-width:thin] [&::-webkit-scrollbar]:w-0 hover:[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[var(--color-border)]">
            <div className="space-y-2">
              {isCreatingFolder && (
                <div className="flex items-center gap-2 rounded-2xl border px-3 py-2.5"
                  style={{ borderColor: "var(--color-highlight)", background: "color-mix(in srgb, var(--color-highlight) 6%, var(--color-bg))" }}>
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                    style={{ background: "color-mix(in srgb, var(--color-highlight) 14%, transparent)" }}>
                    <FolderOpen className="w-4 h-4" style={{ color: "var(--color-highlight)" }} />
                  </div>
                  <input
                    ref={newFolderInputRef}
                    value={newFolderName}
                    onChange={e => setNewFolderName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter") handleCreateFolder();
                      if (e.key === "Escape") { setIsCreatingFolder(false); setNewFolderName(""); }
                    }}
                    placeholder="Folder name"
                    className="flex-1 bg-transparent text-sm outline-none font-medium"
                    style={{ color: "var(--color-text)" }}
                  />
                  <button onClick={handleCreateFolder}
                    className="p-1.5 rounded-md transition-colors"
                    style={{ color: "var(--color-highlight)" }}
                    onMouseEnter={e => e.currentTarget.style.background = "var(--color-bg-tertiary)"}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <Check className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => { setIsCreatingFolder(false); setNewFolderName(""); }}
                    className="p-1.5 rounded-md transition-colors"
                    style={{ color: "var(--color-text-muted)" }}
                    onMouseEnter={e => e.currentTarget.style.background = "var(--color-bg-tertiary)"}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
              {mergedItems.map(item =>
                item.type === "workdir" ? (
                  <WorkDirectoryRow
                    key={`wd-${item.data.name}`}
                    entry={item.data}
                    onOpen={handleOpenWorkdir}
                    onDelete={handleDeleteWorkdir}
                  />
                ) : item.data.is_dir ? (
                  <ResourceFolderRow
                    key={item.data.path}
                    file={item.data}
                    isRenaming={renamingPath === item.data.path}
                    renameValue={renameValue}
                    renameInputRef={renamingPath === item.data.path ? renameInputRef : undefined}
                    onEnter={() => navigateTo(item.data.path)}
                    onStartRename={() => { setRenamingPath(item.data.path); setRenameValue(item.data.name); }}
                    onRenameChange={setRenameValue}
                    onRenameConfirm={() => handleRenameFile(item.data.path, renameValue)}
                    onRenameCancel={() => setRenamingPath(null)}
                    onDelete={() => handleDelete(item.data)}
                    onDragStart={(e) => { e.dataTransfer.setData(DRAG_TYPE, item.data.path); e.dataTransfer.effectAllowed = "move"; }}
                    onMoveToParent={currentPath ? () => handleMoveFile(item.data.path, currentPath.split("/").slice(0, -1).join("/")) : undefined}
                    onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const fromPath = e.dataTransfer.getData(DRAG_TYPE);
                      if (fromPath && fromPath !== item.data.path && !fromPath.startsWith(item.data.path + "/")) {
                        handleMoveFile(fromPath, item.data.path);
                      }
                    }}
                  />
                ) : (
                  <ResourceFileRow
                    key={item.data.path}
                    file={item.data}
                    isRenaming={renamingPath === item.data.path}
                    renameValue={renameValue}
                    renameInputRef={renamingPath === item.data.path ? renameInputRef : undefined}
                    onPreview={handlePreview}
                    onDownload={handleDownload}
                    onDelete={handleDelete}
                    onOpenInApp={handleOpenInApp}
                    onRevealInFileManager={handleRevealInFileManager}
                    onOpenLink={handleOpenLink}
                    onEditLink={handleEditLink}
                    onStartRename={() => { setRenamingPath(item.data.path); setRenameValue(item.data.name); }}
                    onRenameChange={setRenameValue}
                    onRenameConfirm={() => handleRenameFile(item.data.path, renameValue)}
                    onRenameCancel={() => setRenamingPath(null)}
                    onDragStart={(e) => { e.dataTransfer.setData(DRAG_TYPE, item.data.path); e.dataTransfer.effectAllowed = "move"; }}
                    onMoveToParent={currentPath ? () => handleMoveFile(item.data.path, currentPath.split("/").slice(0, -1).join("/")) : undefined}
                  />
                )
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );

  const renderInstructionsPanel = ({ isMain }: { isMain: boolean }) => (
    <section className={`min-h-[240px] rounded-2xl border overflow-hidden flex flex-col xl:min-h-0${!isMain ? " xl:flex-1 xl:min-w-[420px] 2xl:min-w-[480px]" : " h-full"}`}
      style={{ borderColor: "var(--color-border)", background: "var(--color-bg-secondary)" }}>
      <div className="px-4 py-3 border-b"
        style={{ borderColor: "var(--color-border)" }}>
        <div className="flex flex-wrap items-start gap-3">
          <div
            className={`flex items-center gap-3 min-w-0 flex-1 rounded-lg transition-colors ${!isMain ? "cursor-pointer px-1 -mx-1" : ""}`}
            onClick={!isMain ? () => setMainPanel("instructions") : undefined}
            onMouseEnter={e => { if (!isMain) e.currentTarget.style.background = "color-mix(in srgb, var(--color-highlight) 8%, transparent)"; }}
            onMouseLeave={e => { if (!isMain) e.currentTarget.style.background = "transparent"; }}
          >
            <div className="w-8 h-8 rounded-xl flex items-center justify-center"
              style={{ background: "color-mix(in srgb, var(--color-accent) 12%, transparent)" }}>
              <FileText className="w-4 h-4" style={{ color: "var(--color-accent)" }} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold">Workspace Instructions</span>
                {isEditingInstructions && hasUnsaved && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                    style={{ background: "color-mix(in srgb, var(--color-warning) 15%, transparent)", color: "var(--color-warning)" }}>
                    Unsaved
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs" style={{ color: "var(--color-text-muted)" }}>
                Available to every task as <span className="font-mono">instructions.md</span>.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {isEditingInstructions ? (
              <>
                <button
                  onClick={() => { setInstructions(savedInstructions); setIsEditingInstructions(false); }}
                  disabled={isSaving}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all disabled:opacity-30 border"
                  style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)", background: "var(--color-bg)" }}
                >
                  <X className="w-4 h-4" />
                  Cancel
                </button>
                <button
                  onClick={handleSaveInstructions}
                  disabled={isSaving || !hasUnsaved}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all disabled:opacity-30"
                  style={{ color: hasUnsaved ? "white" : "var(--color-text-muted)", background: hasUnsaved ? "var(--color-highlight)" : "var(--color-bg)" }}
                >
                  {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  {hasUnsaved ? "Save" : "Saved"}
                </button>
              </>
            ) : (
              <button
                onClick={() => setIsEditingInstructions(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all border"
                style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)", background: "var(--color-bg)" }}
                onMouseEnter={e => { e.currentTarget.style.color = "var(--color-text)"; e.currentTarget.style.background = "var(--color-bg-tertiary)"; }}
                onMouseLeave={e => { e.currentTarget.style.color = "var(--color-text-muted)"; e.currentTarget.style.background = "var(--color-bg)"; }}
              >
                <Edit3 className="w-4 h-4" />
                Edit
              </button>
            )}
          </div>
        </div>

        {isEditingInstructions && (
          <div className="mt-3 flex flex-wrap gap-2">
            {INSTRUCTION_TEMPLATES.map((template) => (
              <button
                key={template.label}
                onClick={() => insertTemplate(template.content)}
                className="rounded-full border px-3 py-1.5 text-xs font-medium transition-colors"
                style={{
                  borderColor: "var(--color-border)",
                  color: "var(--color-text-muted)",
                  background: "color-mix(in srgb, var(--color-bg) 48%, transparent)",
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.borderColor = "var(--color-highlight)";
                  e.currentTarget.style.color = "var(--color-text)";
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.borderColor = "var(--color-border)";
                  e.currentTarget.style.color = "var(--color-text-muted)";
                }}
              >
                {template.label}
              </button>
            ))}
          </div>
        )}

        {saveMessage && (
          <p className="mt-3 text-xs font-medium" style={{ color: saveMessage === "Saved" ? "var(--color-success)" : "var(--color-error)" }}>
            {saveMessage}
          </p>
        )}
      </div>

      <div className="flex-1 min-h-0 p-3 overflow-y-auto">
        {isLoadingInstructions ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-5 h-5 animate-spin" style={{ color: "var(--color-text-muted)" }} />
          </div>
        ) : isEditingInstructions ? (
          <div className="flex h-full min-h-[120px] flex-col rounded-2xl border"
            style={{
              borderColor: "var(--color-border)",
              background: "linear-gradient(180deg, color-mix(in srgb, var(--color-bg) 56%, transparent), transparent)",
            }}>
            <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b"
              style={{ borderColor: "var(--color-border)" }}>
              <div>
                <p className="text-sm font-medium">Rules editor</p>
                <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                  Use sections and short bullets. Save with <span className="font-mono">Cmd/Ctrl + S</span>.
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs font-medium" style={{ color: "var(--color-text)" }}>
                  {instructionLineCount > 0 ? `${instructionLineCount} ${instructionLineCount === 1 ? "line" : "lines"}` : "No content"}
                </p>
                <p className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>Shared as instructions.md</p>
              </div>
            </div>
            <textarea
              id="resource-instructions-editor"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder={"# Workspace rules\n\nAdd shared expectations for every task in this Studio.\n\nExamples:\n- Always respond in Chinese\n- Use formal tone for reports\n- Output files in Markdown format\n- Reference data from resource/ when available"}
              className="w-full flex-1 resize-none outline-none px-4 py-3 text-[13px] font-mono leading-6"
              style={{ background: "transparent", color: "var(--color-text)", caretColor: "var(--color-highlight)" }}
              spellCheck={false}
            />
          </div>
        ) : instructions.trim() ? (
          <div className="rounded-2xl border p-4 min-h-full"
            style={{ borderColor: "var(--color-border)", background: "var(--color-bg)" }}>
            <MarkdownRenderer content={instructions} />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 h-full min-h-[120px] rounded-2xl border border-dashed"
            style={{ borderColor: "var(--color-border)" }}>
            <FileText className="w-8 h-8" style={{ color: "var(--color-text-muted)" }} />
            <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>No instructions yet</p>
            <button
              onClick={() => setIsEditingInstructions(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border"
              style={{ borderColor: "var(--color-border)", color: "var(--color-highlight)", background: "color-mix(in srgb, var(--color-highlight) 10%, transparent)" }}
            >
              <Edit3 className="w-4 h-4" />
              Add Instructions
            </button>
          </div>
        )}
      </div>
    </section>
  );

  const renderMemoryPanel = ({ isMain }: { isMain: boolean }) => (
    <section className={`min-h-[240px] rounded-2xl border overflow-hidden flex flex-col xl:min-h-0${!isMain ? " xl:flex-1 xl:min-w-[420px] 2xl:min-w-[480px]" : " h-full"}`}
      style={{ borderColor: "var(--color-border)", background: "var(--color-bg-secondary)" }}>
      <div className="px-4 py-3 border-b" style={{ borderColor: "var(--color-border)" }}>
        <div className="flex flex-wrap items-start gap-3">
          <div
            className={`flex items-center gap-3 min-w-0 flex-1 rounded-lg transition-colors ${!isMain ? "cursor-pointer px-1 -mx-1" : ""}`}
            onClick={!isMain ? () => setMainPanel("memory") : undefined}
            onMouseEnter={e => { if (!isMain) e.currentTarget.style.background = "color-mix(in srgb, var(--color-highlight) 8%, transparent)"; }}
            onMouseLeave={e => { if (!isMain) e.currentTarget.style.background = "transparent"; }}
          >
            <div className="w-8 h-8 rounded-xl flex items-center justify-center"
              style={{ background: "color-mix(in srgb, var(--color-highlight) 12%, transparent)" }}>
              <Brain className="w-4 h-4" style={{ color: "var(--color-highlight)" }} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold">Legacy Project Memory</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide"
                  style={{ background: "color-mix(in srgb, var(--color-warning) 15%, transparent)", color: "var(--color-warning)" }}>
                  Legacy
                </span>
              </div>
              <p className="mt-0.5 text-xs" style={{ color: "var(--color-text-muted)" }}>
                Move this older shared document into the current Memory lifecycle.
              </p>
            </div>
          </div>

          <button
            onClick={() => setMemoryMigrationOpen(true)}
            disabled={isLoadingMemory || isMigratingMemory || !memory.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all disabled:opacity-40"
            style={{ color: "white", background: "var(--color-highlight)" }}
          >
            {isMigratingMemory
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <ArrowRight className="w-4 h-4" />}
            Migrate
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 p-3 overflow-y-auto">
        {isLoadingMemory ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-5 h-5 animate-spin" style={{ color: "var(--color-text-muted)" }} />
          </div>
        ) : memory.trim() ? (
          <div className="rounded-2xl border p-4 min-h-full"
            style={{ borderColor: "var(--color-border)", background: "var(--color-bg)" }}>
            <MarkdownRenderer content={memory} />
          </div>
        ) : null}
      </div>
    </section>
  );

  return (
    <>
    <motion.div
      className="h-full flex flex-col gap-4 overflow-y-auto select-none"
      style={{ color: "var(--color-text)" }}
      onDrop={handleDrop}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) {
          dragCountRef.current++;
          setIsDragOver(true);
        }
      }}
      onDragOver={(e) => {
        // Only show overlay for OS file drops, not internal drags
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) {
          e.preventDefault();
        }
      }}
      onDragLeave={() => {
        dragCountRef.current--;
        if (dragCountRef.current <= 0) { dragCountRef.current = 0; setIsDragOver(false); }
      }}
    >
      {/* Hidden file input */}
      <input ref={fileInputRef} type="file" multiple className="hidden" disabled={isUploading}
        onChange={(e) => { if (e.target.files) handleUpload(e.target.files); e.target.value = ""; }} />

      {/* Drag overlay */}
      {isDragOver && (
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none"
          style={{ background: "color-mix(in srgb, var(--color-highlight) 10%, transparent)", border: "2px dashed var(--color-highlight)" }}>
          <div className="flex flex-col items-center gap-2">
            <Upload className="w-8 h-8" style={{ color: "var(--color-highlight)" }} />
            <p className="text-sm font-medium" style={{ color: "var(--color-highlight)" }}>
              Drop files to upload
            </p>
          </div>
        </div>
      )}

      {moveConflict && (
        <FileConflictDialog
          fileName={moveConflict.fromPath.split("/").pop()!}
          newName={moveConflict.newName}
          existingNames={moveConflict.existingNames}
          onNewNameChange={(v) => setMoveConflict({ ...moveConflict, newName: v })}
          onCancel={() => setMoveConflict(null)}
          onOverwrite={overwriteConflict}
          onRename={renameConflict}
        />
      )}

      <AnimatePresence>
        {previewFile && (
          <FilePreviewDrawer
            fileName={previewFile.file.name}
            content={previewFile.content}
            downloadUrl={previewFile.downloadUrl}
            loading={previewLoading}
            onClose={() => setPreviewFile(null)}
            onDownload={() => handleDownload(previewFile.file)}
            fileSize={previewFile.file.size}
            onOpenFile={hostFileActionsAvailable() ? () => handleOpenInApp(previewFile.file) : undefined}
            location={projectId ? {
              projectId,
              root: { kind: "resource" },
              path: previewFile.file.path,
            } : undefined}
          />
        )}
      </AnimatePresence>

      <AddLinkDialog
        open={addLinkOpen}
        title="Add Link to Shared Assets"
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

      <ConfirmDialog
        isOpen={memoryMigrationOpen}
        title="Migrate Legacy Project Memory?"
        message={(
          <div className="space-y-2">
            <p>
              Grove will preserve the current <span className="font-mono">memory.md</span> content as one Memory Log,
              then remove the legacy shared file from this Studio.
            </p>
            <p>
              Existing Studio tasks will remove their legacy <span className="font-mono">memory.md</span> entry and refresh
              <span className="font-mono"> AGENTS.md</span>, <span className="font-mono">CLAUDE.md</span>, and
              <span className="font-mono"> GEMINI.md</span> to the current task contract.
            </p>
          </div>
        )}
        confirmLabel={isMigratingMemory ? "Migrating..." : "Migrate"}
        variant="warning"
        actionsDisabled={isMigratingMemory}
        onConfirm={() => void handleMigrateMemory()}
        onCancel={() => {
          if (!isMigratingMemory) setMemoryMigrationOpen(false);
        }}
      />

      {/* Page header */}
      <section
        className="rounded-2xl border px-4 py-3 sm:px-5"
        style={{
          borderColor: "color-mix(in srgb, var(--color-highlight) 20%, var(--color-border))",
          background: "linear-gradient(135deg, color-mix(in srgb, var(--color-highlight) 10%, var(--color-bg-secondary)), var(--color-bg-secondary) 44%, color-mix(in srgb, var(--color-accent) 12%, var(--color-bg-secondary)))",
          boxShadow: "0 18px 40px color-mix(in srgb, var(--color-bg) 45%, transparent)",
        }}
      >
        <div className="flex flex-col gap-3">
          <div className="min-w-0">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-xl flex items-center justify-center border shrink-0"
                style={{
                  borderColor: "color-mix(in srgb, var(--color-highlight) 24%, var(--color-border))",
                  background: "color-mix(in srgb, var(--color-highlight) 12%, transparent)",
                }}>
                <Sparkles className="w-4 h-4" style={{ color: "var(--color-highlight)" }} />
              </div>
              <div className="min-w-0">
                <div className="inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em]"
                  style={{
                    color: "var(--color-highlight)",
                    background: "color-mix(in srgb, var(--color-highlight) 12%, transparent)",
                  }}>
                  Studio Resource Hub
                </div>
                <h1 className="mt-1.5 text-lg font-semibold tracking-tight">Shared context for every task</h1>
                <p className="mt-0.5 max-w-3xl text-xs" style={{ color: "var(--color-text-muted)" }}>
                  Upload reusable files, define workspace-wide instructions, and keep agent context visible instead of buried in a form.
                </p>
              </div>
            </div>

            <div className="mt-3 grid gap-2 md:grid-cols-3">
              <HeroStat
                icon={Files}
                label="Uploads"
                value={String(fileOnlyCount)}
                subtext={fileOnlyCount > 0 ? formatSize(totalBytes) : "No files yet"}
              />
              <HeroStat
                icon={Clock3}
                label="Last updated"
                value={latestUpdate ? formatTime(latestUpdate) : "Never"}
                subtext={latestUpdate ? "Most recent resource change" : "Upload a file to start"}
              />
              <HeroStat
                icon={ShieldCheck}
                label="Linked Folders"
                value={String(workdirs.length)}
                subtext={workdirs.length > 0 ? "Read-only linked folders" : "No linked folders"}
              />
            </div>
          </div>
        </div>
      </section>

      <div className="grid flex-1 min-h-0 gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(420px,1fr)] 2xl:grid-cols-[minmax(0,1.65fr)_minmax(480px,1fr)]">
        {/* Main panel (animated) */}
        <AnimatePresence mode="wait">
          <motion.div
            key={mainPanel}
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.2 }}
            className="min-h-[300px] xl:min-h-0 flex flex-col h-full"
          >
            {mainPanel === "assets" && renderAssetsPanel({ isMain: true })}
            {mainPanel === "instructions" && renderInstructionsPanel({ isMain: true })}
            {mainPanel === "memory" && renderMemoryPanel({ isMain: true })}
          </motion.div>
        </AnimatePresence>

        {/* Right sidebar: remaining two panels */}
        <div className="flex min-h-0 flex-col gap-4">
          {rightPanels.map((p) => (
            <div key={p} className="min-h-[240px] xl:min-h-0 xl:flex-1 flex flex-col">
              {p === "assets" && renderAssetsPanel({ isMain: false })}
              {p === "instructions" && renderInstructionsPanel({ isMain: false })}
              {p === "memory" && renderMemoryPanel({ isMain: false })}
            </div>
          ))}
        </div>
      </div>
    </motion.div>
    {folderPicker}
    </>
  );
}

/* ─── Breadcrumb Nav (with drop targets) ─── */

function BreadcrumbNav({
  currentPath,
  breadcrumbSegments,
  onNavigate,
  onDropToPath,
}: {
  currentPath: string;
  breadcrumbSegments: string[];
  onNavigate: (path: string) => void;
  onDropToPath: (fromPath: string, toFolderPath: string) => void;
}) {
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const makeDragProps = (targetPath: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes(DRAG_TYPE)) {
        e.preventDefault();
        e.stopPropagation();
        setDropTarget(targetPath);
      }
    },
    onDragLeave: () => setDropTarget(null),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(null);
      const fromPath = e.dataTransfer.getData(DRAG_TYPE);
      if (fromPath) onDropToPath(fromPath, targetPath);
    },
  });

  const isDropActive = (path: string) => dropTarget === path;

  return (
    <div className="flex items-center gap-1 text-[12px] flex-wrap" style={{ color: "var(--color-text-muted)" }}>
      <button
        type="button"
        onClick={() => onNavigate("")}
        className="px-1.5 py-0.5 rounded transition-colors"
        style={{
          ...(currentPath === "" ? { color: "var(--color-text)", fontWeight: 500 } : {}),
          ...(isDropActive("") ? { background: "color-mix(in srgb, var(--color-highlight) 18%, transparent)", color: "var(--color-highlight)", outline: "1px dashed var(--color-highlight)" } : {}),
        }}
        {...makeDragProps("")}
      >
        resource
      </button>
      {breadcrumbSegments.map((segment, index) => {
        const segPath = breadcrumbSegments.slice(0, index + 1).join("/");
        return (
          <div key={segPath} className="flex items-center gap-1">
            <ChevronRight className="w-3 h-3 shrink-0" style={{ opacity: 0.5 }} />
            <button
              type="button"
              onClick={() => onNavigate(segPath)}
              className="px-1.5 py-0.5 rounded transition-colors"
              style={{
                ...(index === breadcrumbSegments.length - 1 ? { color: "var(--color-text)", fontWeight: 500 } : {}),
                ...(isDropActive(segPath) ? { background: "color-mix(in srgb, var(--color-highlight) 18%, transparent)", color: "var(--color-highlight)", outline: "1px dashed var(--color-highlight)" } : {}),
              }}
              {...makeDragProps(segPath)}
            >
              {segment}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function HeroStat({
  icon: Icon,
  label,
  value,
  subtext,
}: {
  icon: typeof Files;
  label: string;
  value: string;
  subtext: string;
}) {
  return (
    <div
      className="rounded-xl border px-3 py-2"
      style={{
        borderColor: "color-mix(in srgb, var(--color-border) 78%, transparent)",
        background: "color-mix(in srgb, var(--color-bg) 58%, transparent)",
      }}
    >
      <div className="flex items-center gap-2">
        <Icon className="w-4 h-4" style={{ color: "var(--color-highlight)" }} />
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--color-text-muted)" }}>
          {label}
        </span>
      </div>
      <div className="mt-1.5 text-sm font-semibold">{value}</div>
      <div className="mt-0.5 text-xs" style={{ color: "var(--color-text-muted)" }}>{subtext}</div>
    </div>
  );
}

/* ─── Resource Folder Row ─── */

function ResourceFolderRow({
  file, isRenaming, renameValue, renameInputRef,
  onEnter, onStartRename, onRenameChange, onRenameConfirm, onRenameCancel,
  onDelete, onDragStart, onMoveToParent, onDragOver, onDrop,
}: {
  file: ResourceFile;
  isRenaming: boolean;
  renameValue: string;
  renameInputRef?: React.RefObject<HTMLInputElement | null>;
  onEnter: () => void;
  onStartRename: () => void;
  onRenameChange: (v: string) => void;
  onRenameConfirm: () => void;
  onRenameCancel: () => void;
  onDelete: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onMoveToParent?: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const [isDragTarget, setIsDragTarget] = useState(false);
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

  return (
    <div
      className="group flex items-center gap-3 rounded-2xl border px-3 py-3 transition-all cursor-grab"
      draggable={!isRenaming}
      style={{
        borderColor: isDragTarget
          ? "var(--color-highlight)"
          : "color-mix(in srgb, var(--color-border) 75%, transparent)",
        background: isDragTarget
          ? "color-mix(in srgb, var(--color-highlight) 8%, var(--color-bg))"
          : "color-mix(in srgb, var(--color-bg) 44%, transparent)",
      }}
      onClick={() => { if (!isRenaming) onEnter(); }}
      onDragStart={onDragStart}
      onMouseEnter={e => {
        if (!isDragTarget) {
          e.currentTarget.style.background = "var(--color-bg-tertiary)";
          e.currentTarget.style.borderColor = "color-mix(in srgb, var(--color-highlight) 26%, var(--color-border))";
        }
      }}
      onMouseLeave={e => {
        if (!isDragTarget) {
          e.currentTarget.style.background = "color-mix(in srgb, var(--color-bg) 44%, transparent)";
          e.currentTarget.style.borderColor = "color-mix(in srgb, var(--color-border) 75%, transparent)";
        }
      }}
      onDragOver={(e) => { onDragOver(e); setIsDragTarget(true); }}
      onDragLeave={() => setIsDragTarget(false)}
      onDrop={(e) => { onDrop(e); setIsDragTarget(false); }}
    >
      <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
        style={{ background: "var(--color-bg)" }}>
        <FolderOpen className="w-4 h-4" style={{ color: "var(--color-highlight)" }} />
      </div>
      <div className="flex-1 min-w-0" onClick={e => { if (isRenaming) e.stopPropagation(); }}>
        {isRenaming ? (
          <div className="flex items-center gap-1.5">
            <input
              ref={renameInputRef as React.RefObject<HTMLInputElement>}
              value={renameValue}
              onChange={e => onRenameChange(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") { e.stopPropagation(); onRenameConfirm(); }
                if (e.key === "Escape") { e.stopPropagation(); onRenameCancel(); }
              }}
              className="flex-1 bg-transparent text-[13px] font-medium outline-none border-b"
              style={{ borderColor: "var(--color-highlight)", color: "var(--color-text)" }}
              onClick={e => e.stopPropagation()}
            />
            <button onClick={(e) => { e.stopPropagation(); onRenameConfirm(); }}
              className="p-1 rounded shrink-0" style={{ color: "var(--color-highlight)" }}>
              <Check className="w-3.5 h-3.5" />
            </button>
            <button onClick={(e) => { e.stopPropagation(); onRenameCancel(); }}
              className="p-1 rounded shrink-0" style={{ color: "var(--color-text-muted)" }}>
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium truncate block">{file.name}</span>
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>Folder</span>
              <span className="text-[11px] opacity-50" style={{ color: "var(--color-text-muted)" }}>· Drop files here to move</span>
            </div>
          </>
        )}
      </div>
      {!isRenaming && (
        <button ref={btnRef}
          onClick={(e) => {
            e.stopPropagation();
            if (btnRef.current) {
              const rect = btnRef.current.getBoundingClientRect();
              setMenuPos({ top: rect.bottom + 4, left: rect.right - 140 });
            }
            setShowMenu(!showMenu);
          }}
          className="p-1.5 rounded-md opacity-0 group-hover:opacity-100 transition-all shrink-0"
          style={{ color: "var(--color-text-muted)" }}
          onMouseEnter={e => e.currentTarget.style.background = "var(--color-bg)"}
          onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
          <MoreHorizontal className="w-4 h-4" />
        </button>
      )}
      {showMenu && menuPos && createPortal(
        <div ref={menuRef} className="fixed z-[9999] min-w-[140px] rounded-lg shadow-lg py-1"
          style={{ top: menuPos.top, left: menuPos.left, background: "var(--color-bg)", border: "1px solid var(--color-border)" }}>
          <button
            onClick={(e) => { e.stopPropagation(); setShowMenu(false); onEnter(); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors"
            onMouseEnter={e => e.currentTarget.style.background = "var(--color-bg-secondary)"}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <FolderOpen className="w-3.5 h-3.5" /> Open
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setShowMenu(false); onStartRename(); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors"
            onMouseEnter={e => e.currentTarget.style.background = "var(--color-bg-secondary)"}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <Pencil className="w-3.5 h-3.5" /> Rename
          </button>
          {onMoveToParent && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowMenu(false); onMoveToParent(); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors"
              onMouseEnter={e => e.currentTarget.style.background = "var(--color-bg-secondary)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <CornerLeftUp className="w-3.5 h-3.5" /> Move to parent
            </button>
          )}
          <div className="my-1" style={{ borderTop: "1px solid var(--color-border)" }} />
          <button
            onClick={(e) => { e.stopPropagation(); setShowMenu(false); onDelete(); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors"
            style={{ color: "var(--color-error)" }}
            onMouseEnter={e => e.currentTarget.style.background = "color-mix(in srgb, var(--color-error) 10%, transparent)"}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </button>
        </div>,
        document.body
      )}
    </div>
  );
}

/* ─── Resource File Row ─── */

function ResourceFileRow({
  file, isRenaming, renameValue, renameInputRef,
  onPreview, onDownload, onDelete, onOpenInApp, onRevealInFileManager, onOpenLink, onEditLink,
  onStartRename, onRenameChange, onRenameConfirm, onRenameCancel,
  onDragStart, onMoveToParent,
}: {
  file: ResourceFile;
  isRenaming: boolean;
  renameValue: string;
  renameInputRef?: React.RefObject<HTMLInputElement | null>;
  onPreview: (f: ResourceFile) => void;
  onDownload: (f: ResourceFile) => void;
  onDelete: (f: ResourceFile) => void;
  onOpenInApp?: (f: ResourceFile) => void;
  onRevealInFileManager?: (f: ResourceFile) => void;
  onOpenLink?: (f: ResourceFile) => void;
  onEditLink?: (f: ResourceFile) => void;
  onStartRename: () => void;
  onRenameChange: (v: string) => void;
  onRenameConfirm: () => void;
  onRenameCancel: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onMoveToParent?: () => void;
}) {
  const canUseHostFileActions =
    typeof window !== "undefined" &&
    (window as unknown as Record<string, unknown>).__GROVE_REMOTE__ !== true;
  const revealLabel =
    typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent)
      ? "Show in Finder"
      : "Show in File Manager";
  const isLink = isLinkFile(file.name);
  const canPreview = !isLink && canPreviewFile(file.name);
  const ext = getExtBadge(file.name);
  const displayLabel = isLink ? linkDisplayName(file.name) : file.name;
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

  return (
    <div
      className="group flex items-center gap-3 rounded-2xl border px-3 py-3 transition-all"
      draggable={!isRenaming}
      style={{
        borderColor: "color-mix(in srgb, var(--color-border) 75%, transparent)",
        background: "color-mix(in srgb, var(--color-bg) 44%, transparent)",
        cursor: isRenaming ? "default" : "grab",
      }}
      onClick={() => {
        if (isRenaming) return;
        if (isLink) { onOpenLink?.(file); return; }
        if (canPreview) onPreview(file); else onDownload(file);
      }}
      onDragStart={onDragStart}
      onMouseEnter={e => {
        e.currentTarget.style.background = "var(--color-bg-tertiary)";
        e.currentTarget.style.borderColor = "color-mix(in srgb, var(--color-highlight) 26%, var(--color-border))";
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = "color-mix(in srgb, var(--color-bg) 44%, transparent)";
        e.currentTarget.style.borderColor = "color-mix(in srgb, var(--color-border) 75%, transparent)";
      }}>
      <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 overflow-hidden bg-[var(--color-bg-secondary)] border border-[var(--color-border)]"
        style={{
          background: isLink ? "color-mix(in srgb, var(--color-highlight) 10%, transparent)" : "var(--color-bg)",
          border: isLink ? "1px solid color-mix(in srgb, var(--color-highlight) 25%, transparent)" : undefined,
        }}>
        {isLink
          ? (file.favicon ? (
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
            ))
          : <VSCodeIcon filename={file.name} size={16} />}
      </div>
      <div className="flex-1 min-w-0" onClick={e => { if (isRenaming) e.stopPropagation(); }}>
        {isRenaming ? (
          <div className="flex items-center gap-1.5">
            <input
              ref={renameInputRef as React.RefObject<HTMLInputElement>}
              value={renameValue}
              onChange={e => onRenameChange(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") { e.stopPropagation(); onRenameConfirm(); }
                if (e.key === "Escape") { e.stopPropagation(); onRenameCancel(); }
              }}
              className="flex-1 bg-transparent text-[13px] font-medium outline-none border-b"
              style={{ borderColor: "var(--color-highlight)", color: "var(--color-text)" }}
              onClick={e => e.stopPropagation()}
            />
            <button onClick={(e) => { e.stopPropagation(); onRenameConfirm(); }}
              className="p-1 rounded shrink-0" style={{ color: "var(--color-highlight)" }}>
              <Check className="w-3.5 h-3.5" />
            </button>
            <button onClick={(e) => { e.stopPropagation(); onRenameCancel(); }}
              className="p-1 rounded shrink-0" style={{ color: "var(--color-text-muted)" }}>
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium truncate block">{displayLabel}</span>
              {ext && (
                <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]"
                  style={{
                    color: "var(--color-text-muted)",
                    background: "var(--color-bg)",
                  }}>
                  {ext}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-1">
              {isLink ? (
                <span className="text-[11px] truncate" style={{ color: "var(--color-text-muted)" }}>external link</span>
              ) : (
                <>
                  <span className="text-[11px] tabular-nums" style={{ color: "var(--color-text-muted)" }}>{formatSize(file.size)}</span>
                  <span className="text-[11px] opacity-60" style={{ color: "var(--color-text-muted)" }}>•</span>
                  <span className="text-[11px] opacity-60" style={{ color: "var(--color-text-muted)" }}>{formatTime(file.modified_at)}</span>
                </>
              )}
            </div>
          </>
        )}
      </div>
      {!isRenaming && (
        <button ref={btnRef}
          onClick={(e) => {
            e.stopPropagation();
            if (btnRef.current) {
              const rect = btnRef.current.getBoundingClientRect();
              setMenuPos({ top: rect.bottom + 4, left: rect.right - 140 });
            }
            setShowMenu(!showMenu);
          }}
          className="p-1.5 rounded-md opacity-0 group-hover:opacity-100 transition-all shrink-0"
          style={{ color: "var(--color-text-muted)" }}
          onMouseEnter={e => e.currentTarget.style.background = "var(--color-bg)"}
          onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
          <MoreHorizontal className="w-4 h-4" />
        </button>
      )}
      {showMenu && menuPos && createPortal(
        <div ref={menuRef} className="fixed z-[9999] min-w-[140px] rounded-lg shadow-lg py-1"
          style={{ top: menuPos.top, left: menuPos.left, background: "var(--color-bg)", border: "1px solid var(--color-border)" }}>
          {isLink && onOpenLink && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowMenu(false); onOpenLink(file); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors"
              onMouseEnter={e => e.currentTarget.style.background = "var(--color-bg-secondary)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <LinkIcon className="w-3.5 h-3.5" /> Open in browser
            </button>
          )}
          {isLink && onEditLink && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowMenu(false); onEditLink(file); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors"
              onMouseEnter={e => e.currentTarget.style.background = "var(--color-bg-secondary)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <Edit3 className="w-3.5 h-3.5" /> Edit
            </button>
          )}
          {canPreview && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowMenu(false); onPreview(file); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors"
              onMouseEnter={e => e.currentTarget.style.background = "var(--color-bg-secondary)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <Eye className="w-3.5 h-3.5" /> Preview
            </button>
          )}
          {!isLink && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowMenu(false); onDownload(file); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors"
              onMouseEnter={e => e.currentTarget.style.background = "var(--color-bg-secondary)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <Download className="w-3.5 h-3.5" /> Download
            </button>
          )}
          {!isLink && canUseHostFileActions && onOpenInApp && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowMenu(false); onOpenInApp(file); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors"
              onMouseEnter={e => e.currentTarget.style.background = "var(--color-bg-secondary)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <SquareArrowOutUpRight className="w-3.5 h-3.5" /> Open
            </button>
          )}
          {!isLink && canUseHostFileActions && onRevealInFileManager && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowMenu(false); onRevealInFileManager(file); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors"
              onMouseEnter={e => e.currentTarget.style.background = "var(--color-bg-secondary)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <FolderSearch className="w-3.5 h-3.5" /> {revealLabel}
            </button>
          )}
          {!isLink && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowMenu(false); onStartRename(); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors"
              onMouseEnter={e => e.currentTarget.style.background = "var(--color-bg-secondary)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <Pencil className="w-3.5 h-3.5" /> Rename
            </button>
          )}
          {onMoveToParent && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowMenu(false); onMoveToParent(); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors"
              onMouseEnter={e => e.currentTarget.style.background = "var(--color-bg-secondary)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <CornerLeftUp className="w-3.5 h-3.5" /> Move to parent
            </button>
          )}
          <div className="my-1" style={{ borderTop: "1px solid var(--color-border)" }} />
          <button onClick={(e) => { e.stopPropagation(); setShowMenu(false); onDelete(file); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors"
            style={{ color: "var(--color-error)" }}
            onMouseEnter={e => e.currentTarget.style.background = "color-mix(in srgb, var(--color-error) 10%, transparent)"}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </button>
        </div>,
        document.body
      )}
    </div>
  );
}

function WorkDirectoryRow({
  entry,
  onOpen,
  onDelete,
}: {
  entry: WorkDirectoryEntry;
  onOpen: (entry: WorkDirectoryEntry) => void;
  onDelete: (entry: WorkDirectoryEntry) => void;
}) {
  return (
    <div
      className="group flex items-center gap-3 rounded-2xl border px-3 py-3 transition-all"
      style={{
        borderColor: "color-mix(in srgb, var(--color-border) 75%, transparent)",
        background: "color-mix(in srgb, var(--color-bg) 44%, transparent)",
      }}
    >
      <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
        style={{ background: "var(--color-bg)" }}>
        <FolderOpen className="w-4 h-4" style={{ color: "var(--color-highlight)" }} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm truncate font-medium">{entry.name}</span>
          <span className="text-[10px] px-2 py-0.5 rounded-full"
            style={{
              color: entry.exists ? "var(--color-success)" : "var(--color-warning)",
              background: "var(--color-bg)",
            }}>
            {entry.exists ? "Read-only" : "Missing"}
          </span>
        </div>
        <div className="mt-0.5 text-xs truncate" style={{ color: "var(--color-text-muted)" }}>
          {entry.target_path}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={() => onOpen(entry)}
          className="p-2 rounded-lg transition-colors"
          title="Open folder"
          style={{ color: "var(--color-text-muted)" }}
        >
          <Eye className="w-4 h-4" />
        </button>
        <button
          onClick={() => onDelete(entry)}
          className="p-2 rounded-lg transition-colors"
          title="Remove link"
          style={{ color: "var(--color-text-muted)" }}
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
