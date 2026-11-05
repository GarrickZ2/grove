import { isAbort, startTransfer } from "../../../../transfers/store";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { Task } from "../../../../data/types";
import {
  listArtifacts, previewArtifact, artifactDownloadUrl, deleteArtifact,
  uploadArtifactWithProgress, artifactsZipUrl, createArtifactLink, updateArtifactLink, syncArtifactToResource, listArtifactWorkdirs, addArtifactWorkdir, deleteArtifactWorkdir, openArtifactWorkdir, openArtifactFile, revealArtifactFile,
  listResources,
  type ArtifactFile, type ArtifactWorkDirectoryEntry,
} from "../../../../api";
import { apiClient } from "../../../../api/client";
import { useBrowseFolder } from "../../../Projects/useBrowseFolder";
import { filesystemBasename } from "../../../../utils/filesystemPath";
import {
  getPreviewType,
  downloadViaIframe,
  parseLinkFile,
} from "../../../ui";
import { openExternalUrl } from "../../../../utils/openExternal";
import { previewCommentMarkerData, previewCommentTaskLabel, usePreviewComments, type PreviewCommentLocator } from "../../../../context";
import { getPreviewRenderer, type PreviewCommentMarker } from "../../../Review/previewRenderers";
import { resolvePreviewTarget } from "./artifactsModel";

export interface ArtifactPreviewRequest {
  file: string;
  seq: number;
}

export interface ArtifactsPanelOptions {
  projectId?: string;
  task: Task;
  previewRequest?: ArtifactPreviewRequest | null;
  lastChatIdleAt?: number;
  isChatBusy?: boolean;
  /** Called when an external preview request resolves to a file, before it
   *  opens, so the layout can bring that file's section / folder into view. */
  onRevealTarget?: (file: ArtifactFile) => void;
  /** Upload files one request each with per-file progress (`pendingUploadItems`).
   *  Off by default so the Workbench keeps its single batch upload. */
}

/** One file in the upload batch in flight. `progress` is 0..1, or null before it starts. */
export interface PendingUpload {
  id: string;
  name: string;
  progress: number | null;
  /** Waiting for an upload slot. */
  queued?: boolean;
  failed?: boolean;
}

/** Concurrent per-file uploads. */
const UPLOAD_CONCURRENCY = 3;

interface LoadFilesOptions {
  silent?: boolean;
}

export interface ArtifactLinkDraft {
  name: string;
  url: string;
  description?: string;
  favicon?: string;
}

export interface ArtifactPreviewState {
  file: ArtifactFile;
  content: string;
  downloadUrl?: string;
  /** Too large or not readable as text. */
  unpreviewable?: boolean;
}

export interface ArtifactSyncConflict {
  file: ArtifactFile;
  newName: string;
  existingNames: Set<string>;
}

/**
 * Everything behind the task Artifacts panel: the input (uploads) / output
 * (agent downloads) listings, linked work directories, uploads, links,
 * preview (with live refresh while the agent works), preview comments and
 * the open / reveal / sync / delete actions. Shared by the Workbench tab and
 * the Orbit body; each renders its own layout.
 */
export function useArtifactsPanel({ projectId, task, previewRequest, lastChatIdleAt, isChatBusy, onRevealTarget }: ArtifactsPanelOptions) {
  const { browseFolder, folderPicker } = useBrowseFolder("Select Artifact Folder");
  const { drafts: previewCommentDrafts, addDraft, updateDraft, removeDraft } = usePreviewComments();
  const [inputFiles, setInputFiles] = useState<ArtifactFile[]>([]);
  const [outputFiles, setOutputFiles] = useState<ArtifactFile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [syncConflict, setSyncConflict] = useState<ArtifactSyncConflict | null>(null);

  const [previewFile, setPreviewFile] = useState<ArtifactPreviewState | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [isUploading, setIsUploading] = useState(false);
  /** Names in the upload batch in flight. */
  const [pendingUploads, setPendingUploads] = useState<string[]>([]);
  /** The same batch with per-file progress . */
  const [pendingUploadItems, setPendingUploadItems] = useState<PendingUpload[]>([]);
  const isUploadingRef = useRef(false);
  const [addLinkOpen, setAddLinkOpen] = useState(false);
  const [editLink, setEditLink] = useState<{
    file: ArtifactFile;
    initial: ArtifactLinkDraft;
  } | null>(null);
  const [workdirs, setWorkdirs] = useState<ArtifactWorkDirectoryEntry[]>([]);
  const [isLoadingWorkdirs, setIsLoadingWorkdirs] = useState(true);
  const [isAddingWorkdir, setIsAddingWorkdir] = useState(false);

  const lastPreviewSeqRef = useRef(0);
  const lastGoodContentRef = useRef<string | null>(null);
  const liveRefreshSeqRef = useRef(0);
  const previousChatBusyRef = useRef(!!isChatBusy);
  const previewFileRef = useRef(previewFile);
  useEffect(() => { previewFileRef.current = previewFile; }, [previewFile]);
  const onRevealTargetRef = useRef(onRevealTarget);
  useEffect(() => { onRevealTargetRef.current = onRevealTarget; }, [onRevealTarget]);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const refreshPreviewContent = useCallback((file: ArtifactFile, seq: number) => {
    if (!projectId) return;
    const t = getPreviewType(file.name);
    // Image and binary previews load their own bytes; neither can be
    // re-polled via the text endpoint.
    if (t === "image" || t === "binary") return;
    previewArtifact(projectId, task.id, file.directory, file.path)
      .then((content) => {
        if (seq !== liveRefreshSeqRef.current) return;
        lastGoodContentRef.current = content;
        // Short-circuit when content is unchanged: skipping setState keeps
        // the preview DOM stable, which preserves the user's scroll
        // position across Live Preview polls. A real content change still
        // re-renders (and may shift scroll), which is acceptable.
        const prev = previewFileRef.current;
        if (prev && prev.content === content) {
          setPreviewError(null);
          return;
        }
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
    }
    if (!silent) setIsLoading(false);
  }, [projectId, task.id]);

  const loadWorkdirs = useCallback(async () => {
    if (!projectId) return;
    setIsLoadingWorkdirs(true);
    try {
      const data = await listArtifactWorkdirs(projectId, task.id);
      setWorkdirs(data.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load work directories");
    }
    setIsLoadingWorkdirs(false);
  }, [projectId, task.id]);

  useEffect(() => {
    Promise.resolve().then(() => { void loadFiles(); void loadWorkdirs(); });
  }, [loadFiles, loadWorkdirs]);

  // Refresh when ACP chat finishes work.
  // Use isUploadingRef (not isUploading state) to avoid stale closure:
  // the ref always reflects the current upload state when this effect fires.
  useEffect(() => {
    if (lastChatIdleAt === undefined) return;
    // loadFiles is async and any setState inside happens after `await`, so the
    // setState is not synchronous within this effect body.
    if (!isUploadingRef.current) void loadFiles({ silent: true });
  }, [lastChatIdleAt, loadFiles]);

  const handleUpload = useCallback(async (files: FileList | File[]) => {
    if (!projectId || files.length === 0) return;
    const list = Array.from(files);
    isUploadingRef.current = true;
    setIsUploading(true);
    setPendingUploads(list.map((file) => file.name));
    setError(null);
    const batch = Date.now().toString(36);
    const items: PendingUpload[] = list.map((file, i) => ({ id: `${batch}-${i}`, name: file.name, progress: null, queued: true }));
    setPendingUploadItems(items);
    const update = (id: string, patch: Partial<PendingUpload>) =>
      setPendingUploadItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    const failures: string[] = [];
    const transfers = list.map((file) => startTransfer("upload", file.name, file.size));
    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        const at = next++;
        const { id } = items[at];
        const transfer = transfers[at];
        update(id, { progress: 0, queued: false });
        try {
          await uploadArtifactWithProgress(projectId, task.id, list[at], (fraction) => {
            update(id, { progress: fraction });
            transfer.progress(fraction * list[at].size);
          }, transfer.signal);
          update(id, { progress: 1 });
          transfer.finish();
        } catch (err) {
          if (isAbort(err)) {
            transfer.cancelled();
            continue;
          }
          update(id, { failed: true });
          const apiErr = err as { message?: string };
          transfer.fail(apiErr?.message || "Upload failed");
          failures.push(`${list[at].name}${apiErr?.message ? ` (${apiErr.message})` : ""}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, list.length) }, worker));
    await loadFiles({ silent: true });
    if (failures.length) {
      setError(failures.length === 1 ? `Couldn’t upload ${failures[0]}` : `Couldn’t upload ${failures.length} files: ${failures.join(", ")}`);
    }
    setPendingUploadItems([]);
    isUploadingRef.current = false;
    setIsUploading(false);
    setPendingUploads([]);
  }, [projectId, task.id, loadFiles]);

  const handleAddWorkdir = useCallback(async () => {
    if (!projectId) return;
    setIsAddingWorkdir(true);
    let data: { path: string | null } | null = null;
    let err: unknown = null;
    try {
      const path = await browseFolder();
      data = { path };
      if (path) {
        await addArtifactWorkdir(projectId, task.id, path);
        await loadWorkdirs();
      }
    } catch (e) {
      err = e;
    }
    if (err) {
      setError(err instanceof Error ? err.message : "Failed to add folder");
    } else if (data && data.path) {
      const folderPath = data.path;
      const folderName = filesystemBasename(folderPath);
      setToastMessage(`Added folder "${folderName}"`);
    }
    setIsAddingWorkdir(false);
  }, [projectId, task.id, loadWorkdirs, browseFolder]);

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
    const previewType = getPreviewType(file.name);
    if (previewType === "image") {
      const url = artifactDownloadUrl(projectId, task.id, file.directory, file.path);
      setPreviewFile({ file, content: url });
      lastGoodContentRef.current = url;
      setPreviewError(null);
      return;
    }
    if (previewType === "binary") {
      // Renderer fetches the URL itself (e.g. xlsx via SheetJS). We just
      // hand it the download URL; content is unused.
      const url = artifactDownloadUrl(projectId, task.id, file.directory, file.path);
      setPreviewFile({ file, content: "", downloadUrl: url });
      lastGoodContentRef.current = "";
      setPreviewError(null);
      return;
    }
    setPreviewLoading(true);
    setPreviewError(null);
    let content: string | null = null;
    let err: unknown = null;
    let succeeded = false;
    try {
      content = await previewArtifact(projectId, task.id, file.directory, file.path);
      succeeded = true;
    } catch (e) {
      err = e;
    }
    if (succeeded) {
      // Treat a literal `null` from the API as a valid empty preview, not
      // an error. The previous `err === null && content !== null` form
      // misclassified empty/missing files as failures.
      const safeContent = content ?? "";
      lastGoodContentRef.current = safeContent;
      // Skip setState when the previewed file and its content are unchanged.
      // This covers the busy→idle final refresh where the agent
      // didn't actually touch this file — unconditional setState would
      // re-render FilePreviewDrawer and reset the user's scroll position.
      const prev = previewFileRef.current;
      if (!prev || prev.file.path !== file.path || prev.content !== safeContent) {
        setPreviewFile({ file, content: safeContent });
      }
    } else {
      const renderer = getPreviewRenderer(file.name, 'full');
      if (renderer && renderer.id === 'source') {
        setPreviewFile({ file, content: "", unpreviewable: true });
        lastGoodContentRef.current = "";
        setPreviewLoading(false);
        return;
      }
      const hasMessage = err && typeof err === 'object' && 'message' in err;
      const message = hasMessage ? (err as { message: string }).message : 'Failed to load preview';
      const lastGood = lastGoodContentRef.current;
      const currentPreview = previewFileRef.current;
      const sameFile = currentPreview !== null && currentPreview.file.path === file.path;
      if (force || !lastGood) {
        setPreviewFile({ file, content: `Error: ${message}` });
        setPreviewError(message);
      } else if (lastGood && sameFile) {
        setPreviewFile({ file, content: lastGood });
      }
    }
    setPreviewLoading(false);
  }, [projectId, task.id]);

  const closePreview = useCallback(() => {
    setPreviewFile(null);
    lastGoodContentRef.current = null;
    setPreviewError(null);
  }, []);

  useEffect(() => {
    const wasBusy = previousChatBusyRef.current;
    const busy = !!isChatBusy;
    previousChatBusyRef.current = busy;
    if (!wasBusy || busy || !previewFile) return;
    // Use the silent refresher (no loading toggle, no setState when content
    // is unchanged) so the busy→idle final refresh doesn't unmount the
    // preview DOM and reset the user's scroll position. handlePreview is
    // still used for the manual Refresh button where a spinner is expected.
    const seq = ++liveRefreshSeqRef.current;
    refreshPreviewContent(previewFile.file, seq);
  }, [isChatBusy, previewFile, refreshPreviewContent]);

  const [pendingPreview, setPendingPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!previewRequest || previewRequest.seq === lastPreviewSeqRef.current) return;
    lastPreviewSeqRef.current = previewRequest.seq;
    // previewRequest is a seq-bumped external prop; we have no event handler
    // to consume it, so the queued path is staged here for the next effect to drain.
    setPendingPreview(previewRequest.file);
  }, [previewRequest]);

  useEffect(() => {
    if (isLoading || !pendingPreview) return;
    const requestedPath = pendingPreview;
    // Defer the consume-queued-action setState so the rule can see this as
    // a callback (microtask) rather than a synchronous setState in render.
    Promise.resolve().then(() => setPendingPreview(null));

    const trimmedPath = requestedPath.trim().replace(/^\.?\//, "");
    if (!trimmedPath) return;

    const target = resolvePreviewTarget(requestedPath, inputFiles, outputFiles);
    if (!target) {
      const msg = `"${trimmedPath.split("/").pop() || trimmedPath}" is outside scope`;
      Promise.resolve().then(() => setToastMessage(msg));
      return;
    }

    Promise.resolve().then(() => {
      onRevealTargetRef.current?.(target);
      void handlePreview(target);
    });
  }, [isLoading, pendingPreview, inputFiles, outputFiles, handlePreview]);

  const handleDownload = useCallback((file: ArtifactFile) => {
    if (!projectId || file.is_dir) return;
    downloadViaIframe(
      artifactDownloadUrl(projectId, task.id, file.directory, file.path),
      file.name,
    );
  }, [projectId, task.id]);

  /** Download a .zip of `paths` (relative to `dir`; none = the whole root). */
  const handleDownloadZip = useCallback((dir: string, paths: string[], name?: string) => {
    if (!projectId) return;
    const fallback = paths.length === 1 ? paths[0].split("/").pop() || dir : paths.length === 0 ? dir : `${dir}-${paths.length}-items`;
    const archive = `${name || fallback}.zip`;
    downloadViaIframe(artifactsZipUrl(projectId, task.id, dir, paths, name), archive);
  }, [projectId, task.id]);

  const handleOpenInApp = useCallback((file: ArtifactFile) => {
    if (!projectId || file.is_dir) return;
    void openArtifactFile(projectId, task.id, file.directory, file.path);
  }, [projectId, task.id]);

  const handleRevealInFileManager = useCallback((file: ArtifactFile) => {
    if (!projectId || file.is_dir) return;
    void revealArtifactFile(projectId, task.id, file.directory, file.path);
  }, [projectId, task.id]);

  const handleCreatePreviewComment = useCallback((file: ArtifactFile, locator: PreviewCommentLocator, comment: string, rendererId: string) => {
    if (!projectId) return;
    addDraft({
      source: "artifact",
      projectId,
      taskId: task.id,
      filePath: `${file.directory}/${file.path}`,
      fileName: file.name,
      rendererId,
      locator,
      comment,
    });
    setToastMessage("Preview comment added to chat");
  }, [addDraft, projectId, task.id]);

  const previewFilePath = useMemo(
    () => (previewFile ? `${previewFile.file.directory}/${previewFile.file.path}` : null),
    [previewFile],
  );
  const currentFilePreviewDrafts = useMemo(() => {
    if (!projectId || !previewFilePath) return [];
    return previewCommentDrafts.filter(
      (d) => d.projectId === projectId && d.taskId === task.id && d.filePath === previewFilePath,
    );
  }, [previewCommentDrafts, projectId, task.id, previewFilePath]);
  const currentFilePreviewMarkers = useMemo<PreviewCommentMarker[]>(
    () => currentFilePreviewDrafts.map((draft) =>
      previewCommentMarkerData(
        draft,
        previewCommentTaskLabel(previewCommentDrafts, draft),
      ),
    ),
    [currentFilePreviewDrafts, previewCommentDrafts],
  );

  const handleUpdatePreviewComment = useCallback(
    (id: string, comment: string) => updateDraft(id, { comment }),
    [updateDraft],
  );
  const handleOpenLink = useCallback(async (file: ArtifactFile) => {
    if (!projectId) return;
    try {
      const raw = await previewArtifact(projectId, task.id, file.directory, file.path);
      const parsed = parseLinkFile(raw);
      if (!parsed) {
        setError("Malformed link file");
        return;
      }
      openExternalUrl(parsed.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open link");
    }
  }, [projectId, task.id]);

  const handleEditLink = useCallback(async (file: ArtifactFile) => {
    if (!projectId) return;
    try {
      const raw = await previewArtifact(projectId, task.id, file.directory, file.path);
      const parsed = parseLinkFile(raw);
      if (!parsed) {
        setError("Malformed link file");
        return;
      }
      setEditLink({
        file,
        initial: { name: parsed.name, url: parsed.url, description: parsed.description, favicon: parsed.favicon },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load link");
    }
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

  /** Delete several uploads (input/ only, like single delete), then reload once. */
  const handleDeleteMany = useCallback(async (files: ArtifactFile[]) => {
    if (!projectId) return { deleted: 0, failed: 0 };
    const targets = files.filter((file) => file.directory === "input");
    let deleted = 0;
    const failed: string[] = [];
    for (const file of targets) {
      try {
        await deleteArtifact(projectId, task.id, file.directory, file.path);
        deleted += 1;
      } catch {
        failed.push(file.name);
      }
    }
    await loadFiles({ silent: true });
    if (failed.length) setError(`Couldn’t delete ${failed.length === 1 ? failed[0] : `${failed.length} files`}`);
    else if (deleted) setToastMessage(deleted === 1 ? `Deleted "${targets[0].name}"` : `Deleted ${deleted} files`);
    return { deleted, failed: failed.length };
  }, [projectId, task.id, loadFiles]);

  const handleSyncToResource = useCallback(async (
    file: ArtifactFile,
    options?: { force?: boolean; renameTo?: string },
    cachedExistingNames?: Set<string>,
  ) => {
    if (!projectId) return;
    const renameTo = options?.renameTo;
    const newName = renameTo ?? file.name;
    let err: unknown = null;
    try {
      await syncArtifactToResource(projectId, task.id, file.directory, file.path, options);
    } catch (e) {
      err = e;
    }
    if (!err) {
      setToastMessage(`Synced "${newName}" to Shared Assets`);
      return;
    }
    const apiErr = err as { status?: number; data?: unknown };
    if (apiErr.status === 409) {
      // Fetch resource root filenames once and cache them for the dialog
      let existingNames: Set<string>;
      if (cachedExistingNames) {
        existingNames = cachedExistingNames;
      } else {
        let data: Awaited<ReturnType<typeof listResources>> | null = null;
        try {
          data = await listResources(projectId);
        } catch {
          data = null;
        }
        existingNames = data ? new Set(data.files.map(f => f.name)) : new Set<string>();
      }
      setSyncConflict({ file, newName, existingNames });
      return;
    }
    setError(err instanceof Error ? err.message : "Sync failed");
  }, [projectId, task.id]);

  /** Sync-conflict dialog actions. */
  const overwriteSyncConflict = useCallback(() => {
    if (!syncConflict) return;
    const { file, existingNames } = syncConflict;
    setSyncConflict(null);
    void handleSyncToResource(file, { force: true }, existingNames);
  }, [syncConflict, handleSyncToResource]);

  const renameSyncConflict = useCallback(() => {
    if (!syncConflict) return;
    const { file, newName, existingNames } = syncConflict;
    if (!newName.trim()) return;
    setSyncConflict(null);
    void handleSyncToResource(file, { renameTo: newName.trim() }, existingNames);
  }, [syncConflict, handleSyncToResource]);

  const handleOpenFolder = useCallback((dir: string, subpath?: string) => {
    if (!projectId) return;
    const pathQuery = subpath ? encodeURIComponent(subpath) : ".";
    apiClient.post(`/api/v1/projects/${projectId}/tasks/${task.id}/open-folder?dir=${encodeURIComponent(dir)}&path=${pathQuery}`).catch(() => {});
  }, [projectId, task.id]);

  const submitAddLink = useCallback(async (payload: ArtifactLinkDraft) => {
    if (!projectId) return;
    await createArtifactLink(projectId, task.id, payload);
    await loadFiles();
    setToastMessage(`Added link "${payload.name}"`);
  }, [projectId, task.id, loadFiles]);

  const submitEditLink = useCallback(async (payload: ArtifactLinkDraft) => {
    if (!projectId || !editLink) return;
    await updateArtifactLink(projectId, task.id, editLink.file.path, payload);
    await loadFiles();
    setToastMessage(`Updated link "${payload.name}"`);
  }, [projectId, task.id, editLink, loadFiles]);

  return {
    projectId,
    taskId: task.id,
    inputFiles,
    outputFiles,
    isLoading,
    error,
    setError,
    toastMessage,
    setToastMessage,
    syncConflict,
    setSyncConflict,
    overwriteSyncConflict,
    renameSyncConflict,
    previewFile,
    previewLoading,
    previewError,
    closePreview,
    isUploading,
    pendingUploads,
    pendingUploadItems,
    addLinkOpen,
    setAddLinkOpen,
    editLink,
    setEditLink,
    workdirs,
    isLoadingWorkdirs,
    isAddingWorkdir,
    loadFiles,
    loadWorkdirs,
    handleUpload,
    handleAddWorkdir,
    handleDeleteWorkdir,
    handleOpenWorkdir,
    handlePreview,
    handleDownload,
    handleDownloadZip,
    handleOpenInApp,
    handleRevealInFileManager,
    handleCreatePreviewComment,
    handleUpdatePreviewComment,
    removePreviewComment: removeDraft,
    currentFilePreviewDrafts,
    currentFilePreviewMarkers,
    handleOpenLink,
    handleEditLink,
    handleDelete,
    handleDeleteMany,
    handleSyncToResource,
    handleOpenFolder,
    submitAddLink,
    submitEditLink,
    folderPicker,
  };
}

export type ArtifactsPanel = ReturnType<typeof useArtifactsPanel>;
