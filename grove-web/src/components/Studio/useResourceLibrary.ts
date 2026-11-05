import { useCallback, useEffect, useRef, useState } from "react";
import {
  listResources, uploadResourceWithProgress, deleteResource,
  previewResource, resourceDownloadUrl, openResourceFile, revealResourceFile,
  createResourceFolder, moveResource, createResourceLink, updateResourceLink,
  listResourceWorkdirs, addResourceWorkdir, deleteResourceWorkdir, openResourceWorkdir,
  type ResourceFile, type WorkDirectoryEntry,
} from "../../api";
import {
  downloadViaIframe,
  getPreviewType,
  parseLinkFile,
  type FileConflictState,
} from "../ui";
import { openExternalUrl } from "../../utils/openExternal";
import { isAbort, startTransfer } from "../../transfers/store";
import { DRAG_TYPE, dropContainsDirectory, errorMessage, joinPath } from "./resourceModel";

export interface LinkDraft {
  name: string;
  url: string;
  description?: string;
  favicon?: string;
}

export interface PreviewState {
  file: ResourceFile;
  content: string;
  downloadUrl?: string;
}

/**
 * Studio shared-files manager: the `resource/` listing at the current folder,
 * linked folders, and every file operation (upload, folders, move/rename,
 * links, preview, open). Shared by the Workbench and Orbit Studio pages.
 *
 * `browseFolder` picks a host folder to link (from `useBrowseFolder`).
 */
export function useResourceLibrary(projectId: string | undefined, browseFolder: () => Promise<string | null>) {
  const [files, setFiles] = useState<ResourceFile[]>([]);
  const [isLoadingFiles, setIsLoadingFiles] = useState(true);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  /** Names in the upload batch in flight (shown as placeholders). */
  const [pendingUploads, setPendingUploads] = useState<string[]>([]);
  const isMoveInProgressRef = useRef(false);
  const [workdirs, setWorkdirs] = useState<WorkDirectoryEntry[]>([]);
  const [isLoadingWorkdirs, setIsLoadingWorkdirs] = useState(true);
  const [workdirError, setWorkdirError] = useState<string | null>(null);
  const [addLinkOpen, setAddLinkOpen] = useState(false);
  const [isAddingWorkdir, setIsAddingWorkdir] = useState(false);
  const [editLink, setEditLink] = useState<{ file: ResourceFile; initial: LinkDraft } | null>(null);

  const [currentPath, setCurrentPath] = useState("");
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [moveConflict, setMoveConflict] = useState<FileConflictState | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [previewFile, setPreviewFile] = useState<PreviewState | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const loadFiles = useCallback(async () => {
    if (!projectId) return;
    setIsLoadingFiles(true);
    setFileError(null);
    const pathArg = currentPath || undefined;
    let caught: unknown = null;
    try {
      const data = await listResources(projectId, pathArg);
      setFiles(data.files);
    } catch (err) {
      caught = err;
    }
    if (caught !== null) {
      setFileError(errorMessage(caught, "Failed to load"));
    }
    setIsLoadingFiles(false);
  }, [projectId, currentPath]);

  const loadWorkdirs = useCallback(async () => {
    if (!projectId) return;
    setIsLoadingWorkdirs(true);
    setWorkdirError(null);
    let caught: unknown = null;
    try {
      const data = await listResourceWorkdirs(projectId);
      setWorkdirs(data.entries);
    } catch (err) {
      caught = err;
    }
    if (caught !== null) {
      setWorkdirError(errorMessage(caught, "Failed to load"));
    }
    setIsLoadingWorkdirs(false);
  }, [projectId]);

  useEffect(() => { void Promise.resolve().then(loadFiles); }, [loadFiles]);
  useEffect(() => { void Promise.resolve().then(loadWorkdirs); }, [loadWorkdirs]);

  const refresh = useCallback(() => {
    void loadFiles();
    void loadWorkdirs();
  }, [loadFiles, loadWorkdirs]);

  const handleUpload = useCallback(async (fileList: FileList | File[]) => {
    if (!projectId || fileList.length === 0) return;
    const batch = Array.from(fileList);
    setIsUploading(true);
    setPendingUploads(batch.map((file) => file.name));
    setFileError(null);
    const pathArg = currentPath || undefined;
    let caught: unknown = null;
    const transfers = batch.map((file) => startTransfer("upload", file.name, file.size));
    for (const [index, file] of batch.entries()) {
      const transfer = transfers[index];
      try {
        await uploadResourceWithProgress(projectId, file, pathArg, (fraction) => transfer.progress(fraction * file.size), transfer.signal);
        transfer.finish();
      } catch (err) {
        if (isAbort(err)) {
          transfer.cancelled();
          continue;
        }
        caught ??= err;
        transfer.fail(errorMessage(err, "Upload failed"));
      }
    }
    try {
      await loadFiles();
    } catch (err) {
      caught ??= err;
    }
    if (caught !== null) {
      setFileError(errorMessage(caught, "Upload failed"));
    }
    setPendingUploads([]);
    setIsUploading(false);
  }, [projectId, currentPath, loadFiles]);

  /** OS file drop: uploads files; internal move drags and folders are ignored / refused. */
  const uploadFromDrop = useCallback((dataTransfer: DataTransfer) => {
    if (dataTransfer.types.includes(DRAG_TYPE)) return;
    if (dropContainsDirectory(dataTransfer)) {
      setFileError("Folders are not supported in drag-and-drop upload. Use Add Folder to link a directory.");
      return;
    }
    if (dataTransfer.files.length > 0) void handleUpload(dataTransfer.files);
  }, [handleUpload]);

  const handleCreateFolder = useCallback(async () => {
    if (!projectId || !newFolderName.trim()) return;
    const folderPath = joinPath(currentPath, newFolderName.trim());
    let caught: unknown = null;
    try {
      await createResourceFolder(projectId, folderPath);
      setNewFolderName("");
      setIsCreatingFolder(false);
      await loadFiles();
    } catch (err) {
      caught = err;
    }
    if (caught !== null) {
      setFileError(errorMessage(caught, "Failed to create folder"));
    }
  }, [projectId, currentPath, newFolderName, loadFiles]);

  const startCreateFolder = useCallback(() => { setIsCreatingFolder(true); setNewFolderName(""); }, []);
  const cancelCreateFolder = useCallback(() => { setIsCreatingFolder(false); setNewFolderName(""); }, []);

  const handleMoveFile = useCallback(async (
    fromPath: string,
    toFolderPath: string,
    options?: { force?: boolean; renameTo?: string },
    cachedExistingNames?: Set<string>,
  ) => {
    if (!projectId || isMoveInProgressRef.current) return;
    isMoveInProgressRef.current = true;
    const filename = fromPath.split("/").pop()!;
    const toPath = joinPath(toFolderPath, filename);
    const newName = options?.renameTo ?? filename;
    let err: unknown = null;
    try {
      await moveResource(projectId, fromPath, toPath, options);
      await loadFiles();
    } catch (e) {
      err = e;
    }
    if (!err) {
      isMoveInProgressRef.current = false;
      return;
    }
    const apiErr = err as { status?: number };
    if (apiErr.status === 409) {
      // Fetch destination folder contents to know which names are taken
      let existingNames: Set<string>;
      if (cachedExistingNames) {
        existingNames = cachedExistingNames;
      } else {
        let data: Awaited<ReturnType<typeof listResources>> | null = null;
        try {
          data = await listResources(projectId, toFolderPath || undefined);
        } catch {
          data = null;
        }
        existingNames = data ? new Set(data.files.map(f => f.name)) : new Set<string>();
      }
      setMoveConflict({ fromPath, toFolderPath, newName, existingNames });
      isMoveInProgressRef.current = false;
      return;
    }
    setFileError(err instanceof Error ? err.message : "Failed to move");
    isMoveInProgressRef.current = false;
  }, [projectId, loadFiles]);

  /** Conflict dialog: replace the existing file. */
  const overwriteConflict = useCallback(() => {
    if (!moveConflict) return;
    const { fromPath, toFolderPath, existingNames } = moveConflict;
    setMoveConflict(null);
    void handleMoveFile(fromPath, toFolderPath, { force: true }, existingNames);
  }, [moveConflict, handleMoveFile]);

  /** Conflict dialog: keep both under the new name. */
  const renameConflict = useCallback(() => {
    if (!moveConflict) return;
    const { fromPath, toFolderPath, newName, existingNames } = moveConflict;
    if (!newName.trim()) return;
    setMoveConflict(null);
    void handleMoveFile(fromPath, toFolderPath, { renameTo: newName.trim() }, existingNames);
  }, [moveConflict, handleMoveFile]);

  const handleRenameFile = useCallback(async (oldPath: string, newName: string) => {
    if (!projectId || !newName.trim()) { setRenamingPath(null); return; }
    const parts = oldPath.split("/");
    parts[parts.length - 1] = newName.trim();
    const newPath = parts.join("/");
    if (newPath === oldPath) { setRenamingPath(null); return; }
    let caught: unknown = null;
    try {
      await moveResource(projectId, oldPath, newPath);
      setRenamingPath(null);
      await loadFiles();
    } catch (err) {
      caught = err;
    }
    if (caught !== null) {
      setFileError(errorMessage(caught, "Failed to rename"));
    }
  }, [projectId, loadFiles]);

  const startRename = useCallback((file: ResourceFile) => { setRenamingPath(file.path); setRenameValue(file.name); }, []);

  const handleAddWorkdir = useCallback(async () => {
    if (!projectId) return;
    setIsAddingWorkdir(true);
    setWorkdirError(null);
    let caught: unknown = null;
    try {
      const path = await browseFolder();
      if (path) {
        await addResourceWorkdir(projectId, path);
        await loadWorkdirs();
      }
    } catch (err) {
      caught = err;
    }
    if (caught !== null) {
      setWorkdirError(errorMessage(caught, "Failed to add folder"));
    }
    setIsAddingWorkdir(false);
  }, [projectId, loadWorkdirs, browseFolder]);

  const handleDeleteWorkdir = useCallback(async (entry: WorkDirectoryEntry) => {
    if (!projectId) return;
    let caught: unknown = null;
    try {
      await deleteResourceWorkdir(projectId, entry.name);
      await loadWorkdirs();
    } catch (err) {
      caught = err;
    }
    if (caught !== null) {
      setWorkdirError(errorMessage(caught, "Failed to remove folder"));
    }
  }, [projectId, loadWorkdirs]);

  const handleOpenWorkdir = useCallback(async (entry: WorkDirectoryEntry) => {
    if (!projectId) return;
    let caught: unknown = null;
    try {
      await openResourceWorkdir(projectId, entry.name);
    } catch (err) {
      caught = err;
    }
    if (caught !== null) {
      setWorkdirError(errorMessage(caught, "Failed to open folder"));
    }
  }, [projectId]);

  const handleDelete = useCallback(async (file: ResourceFile) => {
    if (!projectId) return;
    let caught: unknown = null;
    try {
      await deleteResource(projectId, file.path);
      await loadFiles();
    } catch (err) {
      caught = err;
    }
    if (caught !== null) {
      setFileError(errorMessage(caught, "Failed to delete"));
    }
  }, [projectId, loadFiles]);

  const handlePreview = useCallback(async (file: ResourceFile) => {
    if (!projectId || file.is_dir) return;
    const previewType = getPreviewType(file.name);
    if (previewType === "image") {
      setPreviewFile({ file, content: resourceDownloadUrl(projectId, file.path) });
      return;
    }
    if (previewType === "binary") {
      // Renderer (e.g. xlsx) fetches the URL itself.
      setPreviewFile({ file, content: "", downloadUrl: resourceDownloadUrl(projectId, file.path) });
      return;
    }
    setPreviewLoading(true);
    try {
      const content = await previewResource(projectId, file.path);
      setPreviewFile({ file, content });
    } catch {
      setPreviewFile({ file, content: "(Failed to load preview)" });
    }
    setPreviewLoading(false);
  }, [projectId]);

  const handleDownload = useCallback((file: ResourceFile) => {
    if (!projectId || file.is_dir) return;
    downloadViaIframe(resourceDownloadUrl(projectId, file.path), file.name);
  }, [projectId]);

  const handleOpenInApp = useCallback((file: ResourceFile) => {
    if (!projectId || file.is_dir) return;
    void openResourceFile(projectId, file.path);
  }, [projectId]);

  const handleRevealInFileManager = useCallback((file: ResourceFile) => {
    if (!projectId || file.is_dir) return;
    void revealResourceFile(projectId, file.path);
  }, [projectId]);

  const readLink = useCallback(async (file: ResourceFile, failure: string) => {
    if (!projectId) return null;
    let raw: string | null = null;
    let caught: unknown = null;
    try {
      raw = await previewResource(projectId, file.path);
    } catch (err) {
      caught = err;
    }
    if (caught !== null) {
      setFileError(errorMessage(caught, failure));
      return null;
    }
    const parsed = raw !== null ? parseLinkFile(raw) : null;
    if (!parsed) {
      setFileError("Malformed link file");
      return null;
    }
    return parsed;
  }, [projectId]);

  const handleOpenLink = useCallback(async (file: ResourceFile) => {
    const parsed = await readLink(file, "Failed to open link");
    if (parsed) openExternalUrl(parsed.url);
  }, [readLink]);

  const handleEditLink = useCallback(async (file: ResourceFile) => {
    const parsed = await readLink(file, "Failed to load link");
    if (!parsed) return;
    setEditLink({
      file,
      initial: { name: parsed.name, url: parsed.url, description: parsed.description, favicon: parsed.favicon },
    });
  }, [readLink]);

  const submitAddLink = useCallback(async (payload: { name: string; url: string; description?: string }) => {
    if (!projectId) return;
    await createResourceLink(projectId, { ...payload, path: currentPath || undefined });
    await loadFiles();
  }, [projectId, currentPath, loadFiles]);

  const submitEditLink = useCallback(async (payload: { name: string; url: string; description?: string }) => {
    if (!projectId || !editLink) return;
    await updateResourceLink(projectId, editLink.file.path, payload);
    await loadFiles();
  }, [projectId, editLink, loadFiles]);

  const navigateTo = useCallback((path: string) => {
    setCurrentPath(path);
    setSearchQuery("");
    setIsCreatingFolder(false);
    setNewFolderName("");
    setRenamingPath(null);
  }, []);

  return {
    projectId,
    files, workdirs,
    isLoadingFiles, isLoadingWorkdirs,
    fileError, setFileError, workdirError, setWorkdirError,
    isUploading, pendingUploads, isAddingWorkdir,
    loadFiles, loadWorkdirs, refresh,
    currentPath, navigateTo,
    searchQuery, setSearchQuery,
    isCreatingFolder, setIsCreatingFolder, newFolderName, setNewFolderName, startCreateFolder, cancelCreateFolder, handleCreateFolder,
    renamingPath, setRenamingPath, renameValue, setRenameValue, startRename, handleRenameFile,
    moveConflict, setMoveConflict, handleMoveFile, overwriteConflict, renameConflict,
    handleUpload, uploadFromDrop,
    handleAddWorkdir, handleDeleteWorkdir, handleOpenWorkdir,
    handleDelete, handlePreview, handleDownload, handleOpenInApp, handleRevealInFileManager,
    handleOpenLink, handleEditLink,
    addLinkOpen, setAddLinkOpen, submitAddLink,
    editLink, setEditLink, submitEditLink,
    previewFile, setPreviewFile, previewLoading,
  };
}

export type ResourceLibrary = ReturnType<typeof useResourceLibrary>;
