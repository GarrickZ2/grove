import { useState, useEffect, useCallback, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Trash2, Upload, Loader2, MoreHorizontal, Download, Eye,
  FolderOpen, Save, FileText, RefreshCw, Sparkles,
  Search, ArrowRight, Files, ShieldCheck, Clock3, Plus, X, Brain,
} from "lucide-react";
import { useProject } from "../../context";
import {
  listResources, uploadResource, deleteResource,
  previewResource, resourceDownloadUrl,
  getInstructions, updateInstructions,
  getMemory, updateMemory,
  listResourceWorkdirs, addResourceWorkdir, deleteResourceWorkdir, openResourceWorkdir,
  type ResourceFile, type WorkDirectoryEntry,
} from "../../api";
import {
  VSCodeIcon,
  FilePreviewDrawer,
  getPreviewType,
  canPreviewFile,
  getExtBadge,
  downloadViaIframe,
} from "../ui";

function formatSize(bytes: number): string {
  if (bytes === 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return d.toLocaleDateString();
}

function countInstructionLines(text: string): number {
  if (!text.trim()) return 0;
  return text.split("\n").filter((line) => line.trim().length > 0).length;
}

const INSTRUCTION_TEMPLATES = [
  {
    label: "Frontend Style Guide",
    content: `# Frontend style guide

- Keep layouts clean and high-signal
- Prefer consistent spacing and clear section hierarchy
- Preserve the established design language unless a page is explicitly being redesigned
- Avoid placeholder copy in final UI`,
  },
  {
    label: "Agent Behavior Rules",
    content: `# Agent behavior rules

- Be concise and execution-focused
- Prefer practical solutions over broad speculation
- Explain assumptions when they affect correctness
- Reference files in resource/ when they are relevant`,
  },
  {
    label: "Project Context",
    content: `# Project context

- This Studio shares files through resource/
- Instructions here are injected into every task's AGENTS.md
- Prefer using shared files before recreating context in each task`,
  },
];

function dropContainsDirectory(dataTransfer: DataTransfer): boolean {
  for (const item of Array.from(dataTransfer.items || [])) {
    const entry = (item as DataTransferItem & {
      webkitGetAsEntry?: () => { isDirectory?: boolean } | null;
    }).webkitGetAsEntry?.();
    if (entry?.isDirectory) return true;
  }
  return false;
}

export function ResourcePage() {
  const { selectedProject } = useProject();
  const projectId = selectedProject?.id;

  const [files, setFiles] = useState<ResourceFile[]>([]);
  const [isLoadingFiles, setIsLoadingFiles] = useState(true);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [activeTab, setActiveTab] = useState<"uploads" | "workdir">("uploads");
  const [workdirs, setWorkdirs] = useState<WorkDirectoryEntry[]>([]);
  const [isLoadingWorkdirs, setIsLoadingWorkdirs] = useState(true);
  const [workdirError, setWorkdirError] = useState<string | null>(null);
  const [isAddingWorkdir, setIsAddingWorkdir] = useState(false);

  const [instructions, setInstructions] = useState("");
  const [savedInstructions, setSavedInstructions] = useState("");
  const [isLoadingInstructions, setIsLoadingInstructions] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [previewFile, setPreviewFile] = useState<{ file: ResourceFile; content: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const hasUnsaved = instructions !== savedInstructions;
  const instructionLineCount = countInstructionLines(instructions);

  const [memory, setMemory] = useState("");
  const [savedMemory, setSavedMemory] = useState("");
  const [isLoadingMemory, setIsLoadingMemory] = useState(true);
  const [isSavingMemory, setIsSavingMemory] = useState(false);
  const [memorySaveMessage, setMemorySaveMessage] = useState<string | null>(null);

  const hasUnsavedMemory = memory !== savedMemory;
  const memoryLineCount = countInstructionLines(memory);

  const filteredFiles = files.filter((file) =>
    file.name.toLowerCase().includes(searchQuery.toLowerCase()),
  );
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const latestUpdate = files.reduce<string | null>((latest, file) => {
    if (!latest) return file.modified_at;
    return new Date(file.modified_at) > new Date(latest) ? file.modified_at : latest;
  }, null);

  const loadFiles = useCallback(async () => {
    if (!projectId) return;
    setIsLoadingFiles(true);
    setFileError(null);
    try {
      const data = await listResources(projectId);
      setFiles(data.files.filter(f => !f.is_dir));
    } catch (err) {
      setFileError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setIsLoadingFiles(false);
    }
  }, [projectId]);

  const loadWorkdirs = useCallback(async () => {
    if (!projectId) return;
    setIsLoadingWorkdirs(true);
    setWorkdirError(null);
    try {
      const data = await listResourceWorkdirs(projectId);
      setWorkdirs(data.entries);
    } catch (err) {
      setWorkdirError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setIsLoadingWorkdirs(false);
    }
  }, [projectId]);

  const loadInstructions = useCallback(async () => {
    if (!projectId) return;
    setIsLoadingInstructions(true);
    try {
      const data = await getInstructions(projectId);
      setInstructions(data.content);
      setSavedInstructions(data.content);
    } catch {
      setInstructions("");
      setSavedInstructions("");
    } finally {
      setIsLoadingInstructions(false);
    }
  }, [projectId]);

  const loadMemory = useCallback(async () => {
    if (!projectId) return;
    setIsLoadingMemory(true);
    try {
      const data = await getMemory(projectId);
      setMemory(data.content);
      setSavedMemory(data.content);
    } catch {
      setMemory("");
      setSavedMemory("");
    } finally {
      setIsLoadingMemory(false);
    }
  }, [projectId]);

  const handleSaveMemory = useCallback(async () => {
    if (!projectId) return;
    setIsSavingMemory(true);
    setMemorySaveMessage(null);
    try {
      await updateMemory(projectId, memory);
      setSavedMemory(memory);
      setMemorySaveMessage("Saved");
      setTimeout(() => setMemorySaveMessage(null), 2000);
    } catch {
      setMemorySaveMessage("Failed to save");
    } finally {
      setIsSavingMemory(false);
    }
  }, [projectId, memory]);

  useEffect(() => { loadFiles(); loadWorkdirs(); loadInstructions(); loadMemory(); }, [loadFiles, loadWorkdirs, loadInstructions, loadMemory]);

  const handleUpload = useCallback(async (fileList: FileList | File[]) => {
    if (!projectId || fileList.length === 0) return;
    setIsUploading(true);
    setFileError(null);
    try {
      await uploadResource(projectId, Array.from(fileList));
      await loadFiles();
    } catch (err) {
      setFileError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setIsUploading(false);
    }
  }, [projectId, loadFiles]);

  const handleAddWorkdir = useCallback(async () => {
    if (!projectId) return;
    setIsAddingWorkdir(true);
    setWorkdirError(null);
    try {
      const response = await fetch("/api/v1/browse-folder");
      const data = await response.json().catch(() => ({ path: null }));
      if (!data.path) return;
      await addResourceWorkdir(projectId, data.path);
      await loadWorkdirs();
      setActiveTab("workdir");
    } catch (err) {
      setWorkdirError(err instanceof Error ? err.message : "Failed to add folder");
    } finally {
      setIsAddingWorkdir(false);
    }
  }, [projectId, loadWorkdirs]);

  const handleDeleteWorkdir = useCallback(async (entry: WorkDirectoryEntry) => {
    if (!projectId) return;
    try {
      await deleteResourceWorkdir(projectId, entry.name);
      await loadWorkdirs();
    } catch (err) {
      setWorkdirError(err instanceof Error ? err.message : "Failed to remove folder");
    }
  }, [projectId, loadWorkdirs]);

  const handleOpenWorkdir = useCallback(async (entry: WorkDirectoryEntry) => {
    if (!projectId) return;
    try {
      await openResourceWorkdir(projectId, entry.name);
    } catch (err) {
      setWorkdirError(err instanceof Error ? err.message : "Failed to open folder");
    }
  }, [projectId]);

  const handleDelete = async (file: ResourceFile) => {
    if (!projectId) return;
    try {
      await deleteResource(projectId, file.path);
      await loadFiles();
    } catch (err) {
      setFileError(err instanceof Error ? err.message : "Failed to delete");
    }
  };

  const handleSaveInstructions = useCallback(async () => {
    if (!projectId) return;
    setIsSaving(true);
    try {
      await updateInstructions(projectId, instructions);
      setSavedInstructions(instructions);
      setSaveMessage("Saved");
      setTimeout(() => setSaveMessage(null), 2000);
    } catch (err) {
      setSaveMessage(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setIsSaving(false);
    }
  }, [projectId, instructions]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        const active = document.activeElement;
        if (active?.id === "resource-instructions-editor") {
          e.preventDefault();
          if (hasUnsaved) handleSaveInstructions();
        } else if (active?.id === "resource-memory-editor") {
          e.preventDefault();
          if (hasUnsavedMemory) handleSaveMemory();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hasUnsaved, handleSaveInstructions, hasUnsavedMemory, handleSaveMemory]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (activeTab === "workdir") {
      setWorkdirError("Drag-and-drop folders are not supported for Work Directory yet. Use Add Folder.");
      return;
    }
    if (dropContainsDirectory(e.dataTransfer)) {
      setFileError("Folders are not supported in Uploads. Use Work Directory and Add Folder.");
      return;
    }
    if (e.dataTransfer.files.length > 0) handleUpload(e.dataTransfer.files);
  }, [activeTab, handleUpload]);

  const insertTemplate = (content: string) => {
    setInstructions((current) => {
      if (!current.trim()) return content;
      return `${current.trim()}\n\n${content}`;
    });
  };

  const handlePreview = async (file: ResourceFile) => {
    if (!projectId || file.is_dir) return;
    if (getPreviewType(file.name) === "image") {
      setPreviewFile({ file, content: resourceDownloadUrl(projectId, file.path) });
      return;
    }
    setPreviewLoading(true);
    try {
      const content = await previewResource(projectId, file.path);
      setPreviewFile({ file, content });
    } catch {
      setPreviewFile({ file, content: "(Failed to load preview)" });
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleDownload = (file: ResourceFile) => {
    if (!projectId || file.is_dir) return;
    downloadViaIframe(resourceDownloadUrl(projectId, file.path));
  };

  if (!selectedProject || selectedProject.projectType !== "studio") {
    return (
      <div className="flex items-center justify-center h-full">
        <p style={{ color: "var(--color-text-muted)" }}>Resource is only available for Studio projects.</p>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="h-full flex flex-col gap-4 p-4 overflow-y-auto select-none"
      style={{ color: "var(--color-text)" }}
      onDrop={handleDrop}
      onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
      onDragLeave={(e) => { e.preventDefault(); setIsDragOver(false); }}
    >
      {/* Hidden file input */}
      <input ref={fileInputRef} type="file" multiple className="hidden"
        onChange={(e) => { if (e.target.files) handleUpload(e.target.files); e.target.value = ""; }} />

      {/* Drag overlay */}
      {isDragOver && (
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none"
          style={{ background: "color-mix(in srgb, var(--color-highlight) 10%, transparent)", border: "2px dashed var(--color-highlight)" }}>
          <div className="flex flex-col items-center gap-2">
            {activeTab === "uploads"
              ? <Upload className="w-8 h-8" style={{ color: "var(--color-highlight)" }} />
              : <FolderOpen className="w-8 h-8" style={{ color: "var(--color-highlight)" }} />}
            <p className="text-sm font-medium" style={{ color: "var(--color-highlight)" }}>
              {activeTab === "uploads" ? "Drop files to upload" : "Use Add Folder for Work Directory"}
            </p>
          </div>
        </div>
      )}

      <AnimatePresence>
        {previewFile && (
          <FilePreviewDrawer
            fileName={previewFile.file.name}
            content={previewFile.content}
            loading={previewLoading}
            onClose={() => setPreviewFile(null)}
            onDownload={() => handleDownload(previewFile.file)}
          />
        )}
      </AnimatePresence>

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
                value={String(files.length)}
                subtext={files.length > 0 ? formatSize(totalBytes) : "No files yet"}
              />
              <HeroStat
                icon={Clock3}
                label="Last updated"
                value={latestUpdate ? formatTime(latestUpdate) : "Never"}
                subtext={latestUpdate ? "Most recent resource change" : "Upload a file to start"}
              />
              <HeroStat
                icon={ShieldCheck}
                label="Work Directory"
                value={String(workdirs.length)}
                subtext={workdirs.length > 0 ? "Read-only linked folders" : "No linked folders"}
              />
            </div>
          </div>
        </div>
      </section>

      <div className="grid flex-1 min-h-0 gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(420px,1fr)] 2xl:grid-cols-[minmax(0,1.65fr)_minmax(480px,1fr)]">
        <section className="min-h-[300px] rounded-2xl border overflow-hidden flex flex-col xl:min-h-0"
          style={{ borderColor: "var(--color-border)", background: "var(--color-bg-secondary)" }}>
          <div className="flex flex-col gap-3 px-4 py-3 border-b"
            style={{ borderColor: "var(--color-border)" }}>
            <div className="flex flex-wrap items-start gap-3">
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className="w-8 h-8 rounded-xl flex items-center justify-center"
                  style={{ background: "color-mix(in srgb, var(--color-highlight) 12%, transparent)" }}>
                  <FolderOpen className="w-4 h-4" style={{ color: "var(--color-highlight)" }} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">Shared Assets</span>
                    <span className="text-[11px] tabular-nums px-2 py-0.5 rounded-full"
                      style={{
                        color: "var(--color-text-muted)",
                        background: "var(--color-bg)",
                      }}>
                      {activeTab === "uploads" ? files.length : workdirs.length}
                    </span>
                  </div>
                  <p className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>
                    {activeTab === "uploads"
                      ? <>Reusable files available to all tasks through <span className="font-mono">resource/</span></>
                      : <>Read-only local folders linked into this Studio</>}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className="inline-flex rounded-xl border p-1"
                  style={{ borderColor: "var(--color-border)", background: "var(--color-bg)" }}>
                  {(["uploads", "workdir"] as const).map((tab) => (
                    <button
                      key={tab}
                      onClick={() => setActiveTab(tab)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                        activeTab === tab ? "text-white" : ""
                      }`}
                      style={activeTab === tab
                        ? { background: "var(--color-highlight)" }
                        : { color: "var(--color-text-muted)" }}
                    >
                      {tab === "uploads" ? "Uploads" : "Work Directory"}
                    </button>
                  ))}
                </div>
                <button onClick={loadFiles}
                  className="p-2 rounded-lg transition-colors"
                  style={{ color: "var(--color-text-muted)" }}
                  onMouseEnter={e => { e.currentTarget.style.background = "var(--color-bg-tertiary)"; e.currentTarget.style.color = "var(--color-text)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--color-text-muted)"; }}
                  title="Refresh">
                  <RefreshCw className="w-4 h-4" />
                </button>
                <button
                  onClick={() => activeTab === "uploads" ? fileInputRef.current?.click() : handleAddWorkdir()}
                  disabled={activeTab === "uploads" ? isUploading : isAddingWorkdir}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                  style={{ color: "var(--color-highlight)", background: "color-mix(in srgb, var(--color-highlight) 10%, transparent)" }}
                  onMouseEnter={e => e.currentTarget.style.background = "color-mix(in srgb, var(--color-highlight) 18%, transparent)"}
                  onMouseLeave={e => e.currentTarget.style.background = "color-mix(in srgb, var(--color-highlight) 10%, transparent)"}>
                  {(activeTab === "uploads" ? isUploading : isAddingWorkdir)
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : activeTab === "uploads" ? <Upload className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                  {activeTab === "uploads" ? "Upload" : "Add Folder"}
                </button>
              </div>
            </div>

            {activeTab === "uploads" ? (
              <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto]">
                <label
                  className="flex items-center gap-2 rounded-xl border px-3 py-2"
                  style={{ borderColor: "var(--color-border)", background: "color-mix(in srgb, var(--color-bg) 46%, transparent)" }}
                >
                  <Search className="w-4 h-4 shrink-0" style={{ color: "var(--color-text-muted)" }} />
                  <input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search files"
                    className="w-full bg-transparent text-sm outline-none"
                    style={{ color: "var(--color-text)" }}
                  />
                </label>
                <div className="flex items-center gap-2 text-xs" style={{ color: "var(--color-text-muted)" }}>
                  <span className="rounded-full px-2.5 py-1" style={{ background: "var(--color-bg)" }}>
                    {filteredFiles.length} visible
                  </span>
                  <span className="rounded-full px-2.5 py-1" style={{ background: "var(--color-bg)" }}>
                    Shared across studio
                  </span>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-xs" style={{ color: "var(--color-text-muted)" }}>
                <span className="rounded-full px-2.5 py-1" style={{ background: "var(--color-bg)" }}>
                  Read-only soft links
                </span>
                <span className="rounded-full px-2.5 py-1" style={{ background: "var(--color-bg)" }}>
                  Local folders stay in place
                </span>
              </div>
            )}
          </div>

          <div className="flex-1 min-h-0 p-3">
            {activeTab === "uploads" && isLoadingFiles ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="w-5 h-5 animate-spin" style={{ color: "var(--color-text-muted)" }} />
              </div>
            ) : activeTab === "workdir" && isLoadingWorkdirs ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="w-5 h-5 animate-spin" style={{ color: "var(--color-text-muted)" }} />
              </div>
            ) : activeTab === "uploads" && fileError ? (
              <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed py-14 text-center"
                style={{ borderColor: "var(--color-border)" }}>
                <p className="text-sm" style={{ color: "var(--color-error)" }}>{fileError}</p>
                <button onClick={loadFiles} className="text-sm hover:underline" style={{ color: "var(--color-highlight)" }}>Retry</button>
              </div>
            ) : activeTab === "workdir" && workdirError ? (
              <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed py-14 text-center"
                style={{ borderColor: "var(--color-border)" }}>
                <p className="text-sm" style={{ color: "var(--color-error)" }}>{workdirError}</p>
                <button onClick={loadWorkdirs} className="text-sm hover:underline" style={{ color: "var(--color-highlight)" }}>Retry</button>
              </div>
            ) : activeTab === "uploads" && files.length === 0 ? (
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
                    Drag files here or browse from disk. Uploaded assets become instantly available to every task in this Studio.
                  </p>
                </div>
                <div className="inline-flex items-center gap-1.5 text-sm font-medium"
                  style={{ color: "var(--color-highlight)" }}>
                  Browse files <ArrowRight className="w-4 h-4" />
                </div>
              </button>
            ) : activeTab === "workdir" && workdirs.length === 0 ? (
              <button onClick={handleAddWorkdir}
                className="w-full h-full min-h-[200px] rounded-2xl cursor-pointer transition-all flex flex-col items-center justify-center gap-3 px-6 text-center"
                style={{
                  border: "1px dashed color-mix(in srgb, var(--color-highlight) 26%, var(--color-border))",
                  background: "linear-gradient(180deg, color-mix(in srgb, var(--color-highlight) 5%, transparent), transparent)",
                }}
              >
                <div className="w-12 h-12 rounded-xl flex items-center justify-center"
                  style={{ background: "color-mix(in srgb, var(--color-highlight) 12%, transparent)" }}>
                  <FolderOpen className="w-6 h-6" style={{ color: "var(--color-highlight)" }} />
                </div>
                <div>
                  <p className="text-base font-semibold">Link a local Work Directory</p>
                  <p className="mt-2 text-sm max-w-md" style={{ color: "var(--color-text-muted)" }}>
                    Choose a local folder and expose it to this Studio as a read-only soft link without copying files.
                  </p>
                </div>
                <div className="inline-flex items-center gap-1.5 text-sm font-medium"
                  style={{ color: "var(--color-highlight)" }}>
                  Add Folder <ArrowRight className="w-4 h-4" />
                </div>
              </button>
            ) : activeTab === "uploads" && filteredFiles.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 rounded-[22px] border py-14 text-center"
                style={{ borderColor: "var(--color-border)", background: "color-mix(in srgb, var(--color-bg) 40%, transparent)" }}>
                <Search className="w-5 h-5" style={{ color: "var(--color-text-muted)" }} />
                <p className="text-sm font-medium">No files match “{searchQuery}”</p>
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
                {activeTab === "uploads" ? (
                  <div className="space-y-2">
                    {filteredFiles.map(file => (
                      <ResourceFileRow
                        key={file.path}
                        file={file}
                        onPreview={handlePreview}
                        onDownload={handleDownload}
                        onDelete={handleDelete}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {workdirs.map((entry) => (
                      <WorkDirectoryRow
                        key={entry.name}
                        entry={entry}
                        onOpen={handleOpenWorkdir}
                        onDelete={handleDeleteWorkdir}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        <div className="flex min-h-0 flex-col gap-4">
          <section className="min-h-[240px] rounded-2xl border overflow-hidden flex flex-col xl:min-h-0 xl:flex-1 xl:min-w-[420px] 2xl:min-w-[480px]"
            style={{ borderColor: "var(--color-border)", background: "var(--color-bg-secondary)" }}>
          <div className="px-4 py-3 border-b"
            style={{ borderColor: "var(--color-border)" }}>
            <div className="flex flex-wrap items-start gap-3">
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className="w-8 h-8 rounded-xl flex items-center justify-center"
                  style={{ background: "color-mix(in srgb, var(--color-accent) 12%, transparent)" }}>
                  <FileText className="w-4 h-4" style={{ color: "var(--color-accent)" }} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold">Workspace Instructions</span>
                    {hasUnsaved && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                        style={{ background: "color-mix(in srgb, var(--color-warning) 15%, transparent)", color: "var(--color-warning)" }}>
                        Unsaved
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs" style={{ color: "var(--color-text-muted)" }}>
                    Injected into every task. Define reusable guidance once.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button onClick={() => setInstructions(savedInstructions)} disabled={!hasUnsaved}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all disabled:opacity-30 border"
                  style={{
                    borderColor: "var(--color-border)",
                    color: "var(--color-text-muted)",
                    background: "var(--color-bg)",
                  }}>
                  <X className="w-4 h-4" />
                  Cancel
                </button>
                <button onClick={handleSaveInstructions} disabled={isSaving || !hasUnsaved}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all disabled:opacity-30"
                  style={{
                    color: hasUnsaved ? "white" : "var(--color-text-muted)",
                    background: hasUnsaved ? "var(--color-highlight)" : "var(--color-bg)",
                  }}>
                  {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  {hasUnsaved ? "Save Changes" : "Saved"}
                </button>
              </div>
            </div>

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

            {saveMessage && (
              <p className="mt-3 text-xs font-medium" style={{ color: saveMessage === "Saved" ? "var(--color-success)" : "var(--color-error)" }}>
                {saveMessage}
              </p>
            )}
          </div>

          <div className="flex-1 min-h-0 p-3">
            {isLoadingInstructions ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="w-5 h-5 animate-spin" style={{ color: "var(--color-text-muted)" }} />
              </div>
            ) : (
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
                    <p className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>
                      Synced to task bootstrap
                    </p>
                  </div>
                </div>
                <textarea
                  id="resource-instructions-editor"
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder={"# Workspace rules\n\nAdd shared expectations for every task in this Studio.\n\nExamples:\n- Always respond in Chinese\n- Use formal tone for reports\n- Output files in Markdown format\n- Reference data from resource/ when available"}
                  className="w-full flex-1 resize-none outline-none px-4 py-3 text-[13px] font-mono leading-6"
                  style={{
                    background: "transparent",
                    color: "var(--color-text)",
                    caretColor: "var(--color-highlight)",
                  }}
                  spellCheck={false}
                />
              </div>
            )}
          </div>
        </section>

          <section className="min-h-[240px] rounded-2xl border overflow-hidden flex flex-col xl:min-h-0 xl:flex-1 xl:min-w-[420px] 2xl:min-w-[480px]"
            style={{ borderColor: "var(--color-border)", background: "var(--color-bg-secondary)" }}>
          <div className="px-4 py-3 border-b"
            style={{ borderColor: "var(--color-border)" }}>
            <div className="flex flex-wrap items-start gap-3">
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className="w-8 h-8 rounded-xl flex items-center justify-center"
                  style={{ background: "color-mix(in srgb, var(--color-highlight) 12%, transparent)" }}>
                  <Brain className="w-4 h-4" style={{ color: "var(--color-highlight)" }} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold">Project Memory</span>
                    {hasUnsavedMemory && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                        style={{ background: "color-mix(in srgb, var(--color-warning) 15%, transparent)", color: "var(--color-warning)" }}>
                        Unsaved
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs" style={{ color: "var(--color-text-muted)" }}>
                    Accumulated by AI agents across tasks. Read on start, updated on finish.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button onClick={() => setMemory(savedMemory)} disabled={!hasUnsavedMemory}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all disabled:opacity-30 border"
                  style={{
                    borderColor: "var(--color-border)",
                    color: "var(--color-text-muted)",
                    background: "var(--color-bg)",
                  }}>
                  <X className="w-4 h-4" />
                  Cancel
                </button>
                <button onClick={handleSaveMemory} disabled={isSavingMemory || !hasUnsavedMemory}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all disabled:opacity-30"
                  style={{
                    color: hasUnsavedMemory ? "white" : "var(--color-text-muted)",
                    background: hasUnsavedMemory ? "var(--color-highlight)" : "var(--color-bg)",
                  }}>
                  {isSavingMemory ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  {hasUnsavedMemory ? "Save Changes" : "Saved"}
                </button>
              </div>
            </div>

            {memorySaveMessage && (
              <p className="mt-3 text-xs font-medium" style={{ color: memorySaveMessage === "Saved" ? "var(--color-success)" : "var(--color-error)" }}>
                {memorySaveMessage}
              </p>
            )}
          </div>

          <div className="flex-1 min-h-0 p-3">
            {isLoadingMemory ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="w-5 h-5 animate-spin" style={{ color: "var(--color-text-muted)" }} />
              </div>
            ) : (
              <div className="flex h-full min-h-[120px] flex-col rounded-2xl border"
                style={{
                  borderColor: "var(--color-border)",
                  background: "linear-gradient(180deg, color-mix(in srgb, var(--color-bg) 56%, transparent), transparent)",
                }}>
                <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b"
                  style={{ borderColor: "var(--color-border)" }}>
                  <div>
                    <p className="text-sm font-medium">Memory editor</p>
                    <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                      AI-maintained knowledge base. Save with <span className="font-mono">Cmd/Ctrl + S</span>.
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs font-medium" style={{ color: "var(--color-text)" }}>
                      {memoryLineCount > 0 ? `${memoryLineCount} ${memoryLineCount === 1 ? "line" : "lines"}` : "No content"}
                    </p>
                    <p className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>
                      Shared across tasks
                    </p>
                  </div>
                </div>
                <textarea
                  id="resource-memory-editor"
                  value={memory}
                  onChange={(e) => setMemory(e.target.value)}
                  placeholder={"# Project Memory\n\nThis file is maintained by AI agents.\n\n## Conventions\n\n## Known Issues\n\n## Decisions"}
                  className="w-full flex-1 resize-none outline-none px-4 py-3 text-[13px] font-mono leading-6"
                  style={{
                    background: "transparent",
                    color: "var(--color-text)",
                    caretColor: "var(--color-highlight)",
                  }}
                  spellCheck={false}
                />
              </div>
            )}
          </div>
          </section>
        </div>
      </div>
    </motion.div>
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

/* ─── Resource File Row ─── */

function ResourceFileRow({
  file, onPreview, onDownload, onDelete,
}: {
  file: ResourceFile;
  onPreview: (f: ResourceFile) => void;
  onDownload: (f: ResourceFile) => void;
  onDelete: (f: ResourceFile) => void;
}) {
  const canPreview = canPreviewFile(file.name);
  const ext = getExtBadge(file.name);
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
    <div className="group flex items-center gap-3 rounded-2xl border px-3 py-3 transition-all"
      style={{
        borderColor: "color-mix(in srgb, var(--color-border) 75%, transparent)",
        background: "color-mix(in srgb, var(--color-bg) 44%, transparent)",
      }}
      onClick={() => canPreview ? onPreview(file) : onDownload(file)}
      onMouseEnter={e => {
        e.currentTarget.style.background = "var(--color-bg-tertiary)";
        e.currentTarget.style.borderColor = "color-mix(in srgb, var(--color-highlight) 26%, var(--color-border))";
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = "color-mix(in srgb, var(--color-bg) 44%, transparent)";
        e.currentTarget.style.borderColor = "color-mix(in srgb, var(--color-border) 75%, transparent)";
      }}>
      <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
        style={{ background: "var(--color-bg)" }}>
        <VSCodeIcon filename={file.name} size={16} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium truncate block">{file.name}</span>
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
          <span className="text-[11px] tabular-nums" style={{ color: "var(--color-text-muted)" }}>{formatSize(file.size)}</span>
          <span className="text-[11px] opacity-60" style={{ color: "var(--color-text-muted)" }}>•</span>
          <span className="text-[11px] opacity-60" style={{ color: "var(--color-text-muted)" }}>{formatTime(file.modified_at)}</span>
        </div>
      </div>
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
      {showMenu && menuPos && (
        <div ref={menuRef} className="fixed z-50 min-w-[140px] rounded-lg shadow-lg py-1"
          style={{ top: menuPos.top, left: menuPos.left, background: "var(--color-bg)", border: "1px solid var(--color-border)" }}>
          {canPreview && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowMenu(false); onPreview(file); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors"
              onMouseEnter={e => e.currentTarget.style.background = "var(--color-bg-secondary)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <Eye className="w-3.5 h-3.5" /> Preview
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); setShowMenu(false); onDownload(file); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors"
            onMouseEnter={e => e.currentTarget.style.background = "var(--color-bg-secondary)"}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <Download className="w-3.5 h-3.5" /> Download
          </button>
          <div className="my-1" style={{ borderTop: "1px solid var(--color-border)" }} />
          <button onClick={() => { setShowMenu(false); onDelete(file); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors"
            style={{ color: "var(--color-error)" }}
            onMouseEnter={e => e.currentTarget.style.background = "color-mix(in srgb, var(--color-error) 10%, transparent)"}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </button>
        </div>
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
