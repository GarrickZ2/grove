import { useState, useEffect, useCallback, useRef } from "react";
import Editor from "@monaco-editor/react";
import { X, FileCode, Loader2, Save, Maximize2, Minimize2, PanelLeftOpen, PanelLeftClose, RefreshCw, AlertCircle } from "lucide-react";
import { Button } from "../../ui";
import { FileTree } from "./FileTree";
import type { FileTreeNode } from "../../../utils/fileTree";
import { useIsMobile } from "../../../hooks";
import {
  getTaskDirEntries,
  getFileContent,
  writeFileContent,
  createFile,
  createDirectory,
  deleteFileOrDir,
} from "../../../api";
import type { DirEntry } from "../../../api";
import { FileContextMenu, type ContextMenuPosition, type ContextMenuTarget } from "./FileContextMenu";
import { ConfirmDialog } from "../../Dialogs/ConfirmDialog";

interface TaskEditorProps {
  projectId: string;
  taskId: string;
  onClose: () => void;
  /** Whether this panel is in fullscreen mode */
  fullscreen?: boolean;
  /** Toggle fullscreen mode */
  onToggleFullscreen?: () => void;
  /** Hide the editor header (for FlexLayout tabs) */
  hideHeader?: boolean;
}

/** Map file extensions to Monaco language IDs */
function getLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    rs: 'rust',
    ts: 'typescript',
    tsx: 'typescriptreact',
    js: 'javascript',
    jsx: 'javascriptreact',
    json: 'json',
    toml: 'ini',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown',
    css: 'css',
    scss: 'scss',
    html: 'html',
    xml: 'xml',
    sql: 'sql',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    py: 'python',
    go: 'go',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    rb: 'ruby',
    php: 'php',
    lua: 'lua',
    r: 'r',
    dart: 'dart',
    dockerfile: 'dockerfile',
    graphql: 'graphql',
    svg: 'xml',
    kdl: 'plaintext',
    lock: 'plaintext',
  };
  // Handle special filenames
  const name = filePath.split('/').pop()?.toLowerCase() || '';
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile') return 'makefile';
  return map[ext] || 'plaintext';
}

/** Map a flat DirEntry list to FileTreeNode[] for the file tree */
function dirEntriesToNodes(entries: { path: string; is_dir: boolean }[]): FileTreeNode[] {
  return entries
    .sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return a.path.localeCompare(b.path);
    })
    .map(e => {
      const name = e.path.split('/').pop() || e.path;
      return { name, path: e.path, isDir: e.is_dir, children: e.is_dir ? [] : undefined };
    });
}

export function TaskEditor({ projectId, taskId, onClose, fullscreen = false, onToggleFullscreen, hideHeader = false }: TaskEditorProps) {
  const { isMobile } = useIsMobile();
  const [fileNodes, setFileNodes] = useState<FileTreeNode[]>([]);
  const [treeKey, setTreeKey] = useState(0);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileTreeVisible, setFileTreeVisible] = useState(true);
  const [fileContent, setFileContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [modified, setModified] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editorContentRef = useRef<string>('');

  // Context menu state
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState<ContextMenuPosition>({ x: 0, y: 0 });
  const [contextMenuTarget, setContextMenuTarget] = useState<ContextMenuTarget | null>(null);

  // Inline creation state
  const [creatingPath, setCreatingPath] = useState<{ type: 'file' | 'directory'; parentPath: string; depth: number } | null>(null);

  // Delete confirmation
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // Hide file tree by default on mobile
  useEffect(() => {
    if (isMobile) setFileTreeVisible(false);
  }, [isMobile]);

  // Load file list on mount
  useEffect(() => {
    getTaskDirEntries(projectId, taskId, '')
      .then((res) => setFileNodes(dirEntriesToNodes(res.entries)))
      .catch((err) => setError(err.message || 'Failed to load files'));
  }, [projectId, taskId]);

  const handleSelectFile = useCallback(async (path: string) => {
    if (path === selectedFile) return;

    setSelectedFile(path);
    setLoading(true);
    setModified(false);
    setError(null);

    // On mobile, close file tree after selecting
    if (isMobile) setFileTreeVisible(false);

    try {
      const res = await getFileContent(projectId, taskId, path);
      setFileContent(res.content);
      editorContentRef.current = res.content;
    } catch (err) {
      const msg = err instanceof Error ? err.message :
        (err as { message?: string })?.message || 'Failed to load file';
      setError(msg);
      setFileContent('');
    } finally {
      setLoading(false);
    }
  }, [projectId, taskId, selectedFile, isMobile]);

  // Handle editor content change
  const handleEditorChange = useCallback((value: string | undefined) => {
    if (value !== undefined) {
      editorContentRef.current = value;
      setModified(true);
    }
  }, []);

  // Save file
  const handleSave = useCallback(async () => {
    if (!selectedFile || saving || refreshing) return;

    setSaving(true);
    try {
      await writeFileContent(projectId, taskId, selectedFile, editorContentRef.current);
      setFileContent(editorContentRef.current);
      setModified(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message :
        (err as { message?: string })?.message || 'Failed to save file';
      setError(msg);
    } finally {
      setSaving(false);
    }
  }, [projectId, taskId, selectedFile, saving, refreshing]);

  // Keyboard shortcut: Cmd/Ctrl+S to save
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSave]);

  // Internal: used by create/delete handlers
  const reloadFiles = useCallback(async () => {
    try {
      const res = await getTaskDirEntries(projectId, taskId, '');
      setFileNodes(dirEntriesToNodes(res.entries));
      // Remount lazy tree items so expanded directories drop stale loaded children.
      setTreeKey(k => k + 1);
    } catch (err) {
      console.error('Failed to reload files:', err);
    }
  }, [projectId, taskId]);

  // Refresh button: reloads file tree + current file content
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await getTaskDirEntries(projectId, taskId, '');
      setFileNodes(dirEntriesToNodes(res.entries));
      // Increment treeKey to remount FileTree, resetting all expanded directory state
      setTreeKey(k => k + 1);

      if (selectedFile) {
        const fileRes = await getFileContent(projectId, taskId, selectedFile);
        setFileContent(fileRes.content);
        editorContentRef.current = fileRes.content;
        setModified(false);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setRefreshing(false);
    }
  }, [projectId, taskId, selectedFile]);

  const handleExpandDir = useCallback(async (dirPath: string): Promise<DirEntry[]> => {
    const result = await getTaskDirEntries(projectId, taskId, dirPath);
    return result.entries;
  }, [projectId, taskId]);

  const handleContextMenu = useCallback((e: React.MouseEvent, path: string, isDir: boolean) => {
    setContextMenuPosition({ x: e.clientX, y: e.clientY });
    setContextMenuTarget({ path, isDirectory: isDir });
    setContextMenuOpen(true);
  }, []);

  // Delete handler
  const handleDelete = useCallback((path: string) => {
    setDeleteTarget(path);
    setConfirmDialogOpen(true);
  }, []);

  // Copy path handler
  const handleCopyPath = useCallback((path: string) => {
    navigator.clipboard.writeText(path).catch((err) => {
      console.error('Failed to copy path:', err);
    });
  }, []);

  // Create file submit handler
  const handleCreateFile = useCallback(async (path: string) => {
    try {
      await createFile(projectId, taskId, path, "");
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create file');
      return;
    }
    await reloadFiles();
    // Optionally open the newly created file
    setSelectedFile(path);
    setLoading(true);
    setModified(false);
    setError(null);
    try {
      const res = await getFileContent(projectId, taskId, path);
      setFileContent(res.content);
      editorContentRef.current = res.content;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setFileContent('');
    } finally {
      setLoading(false);
    }
  }, [projectId, taskId, reloadFiles]);

  // Create directory submit handler
  const handleCreateDirectory = useCallback(async (path: string) => {
    try {
      await createDirectory(projectId, taskId, path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create directory');
      return;
    }
    await reloadFiles();
  }, [projectId, taskId, reloadFiles]);

  // New file handler
  const handleNewFile = useCallback((parentPath?: string) => {
    const basePath = parentPath || "";
    const depth = basePath ? basePath.split('/').length : 0;
    setCreatingPath({ type: 'file', parentPath: basePath, depth: depth + 1 });
    setContextMenuOpen(false);
  }, []);

  // New directory handler
  const handleNewDirectory = useCallback((parentPath?: string) => {
    const basePath = parentPath || "";
    const depth = basePath ? basePath.split('/').length : 0;
    setCreatingPath({ type: 'directory', parentPath: basePath, depth: depth + 1 });
    setContextMenuOpen(false);
  }, []);

  // Submit inline path creation
  const handleSubmitPath = useCallback(async (name: string) => {
    if (!creatingPath) return;

    const fullPath = creatingPath.parentPath ? `${creatingPath.parentPath}/${name}` : name;

    try {
      if (creatingPath.type === 'file') {
        await handleCreateFile(fullPath);
      } else {
        await handleCreateDirectory(fullPath);
      }
    } catch (err) {
      console.error('Failed to create path:', err);
    } finally {
      setCreatingPath(null);
    }
  }, [creatingPath, handleCreateFile, handleCreateDirectory]);

  // Cancel inline path creation
  const handleCancelPath = useCallback(() => {
    setCreatingPath(null);
  }, []);

  // Delete confirm handler
  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;

    try {
      await deleteFileOrDir(projectId, taskId, deleteTarget);
      await reloadFiles();
      // If deleted file was selected, clear selection
      if (selectedFile === deleteTarget) {
        setSelectedFile(null);
        setFileContent('');
        setModified(false);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setDeleteTarget(null);
      setConfirmDialogOpen(false);
    }
  }, [deleteTarget, projectId, taskId, reloadFiles, selectedFile]);

  // Breadcrumb from file path
  const breadcrumb = selectedFile ? selectedFile.split('/') : [];

  return (
    <div className={`h-full min-h-0 flex-1 flex flex-col bg-[var(--color-bg-secondary)] overflow-hidden ${fullscreen ? '' : 'rounded-lg border border-[var(--color-border)]'}`}>
      {/* Header - 只在非 hideHeader 模式下显示 */}
      {!hideHeader && (
      <div className="flex items-center justify-between px-4 py-2 bg-[var(--color-bg)] border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2 text-sm text-[var(--color-text)] min-w-0">
          <button
            onClick={() => setFileTreeVisible(v => !v)}
            className="p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] rounded transition-colors flex-shrink-0"
            title={fileTreeVisible ? 'Hide file tree' : 'Show file tree'}
          >
            {fileTreeVisible ? <PanelLeftClose className="w-3.5 h-3.5" /> : <PanelLeftOpen className="w-3.5 h-3.5" />}
          </button>
          <FileCode className="w-4 h-4 flex-shrink-0" />
          <span className="font-medium flex-shrink-0">Editor</span>
          {breadcrumb.length > 0 && (
            <>
              <span className="text-[var(--color-text-muted)] flex-shrink-0">/</span>
              <span className="text-[var(--color-text-muted)] text-xs truncate">
                {breadcrumb.join(' / ')}
              </span>
            </>
          )}
          {modified && (
            <span className="text-xs text-[var(--color-warning)] flex-shrink-0">Modified</span>
          )}
          {saving && (
            <span className="text-xs text-[var(--color-text-muted)] flex-shrink-0 flex items-center gap-1">
              <Save className="w-3 h-3" />
              Saving...
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {onToggleFullscreen && (
            <button
              onClick={onToggleFullscreen}
              className="p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] rounded transition-colors"
              title={fullscreen ? "Exit Fullscreen" : "Fullscreen"}
            >
              {fullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
          )}
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="w-4 h-4 mr-1" />
            Close
          </Button>
        </div>
      </div>
      )}

      {/* Main content: File tree + Editor */}
      <div className="flex-1 flex min-h-0 relative">
        {/* Mobile backdrop */}
        {isMobile && fileTreeVisible && (
          <div
            className="fixed inset-0 bg-black/40 z-[15]"
            onClick={() => setFileTreeVisible(false)}
          />
        )}

        {/* Collapsed sidebar strip — shown when file tree is hidden */}
        {!fileTreeVisible && (
          <div
            className="flex-shrink-0 flex flex-col items-center pt-2 gap-1 bg-[var(--color-bg)] border-r border-[var(--color-border)]"
            style={{ width: 36 }}
          >
            <button
              onClick={() => setFileTreeVisible(true)}
              className="flex items-center justify-center w-7 h-7 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
              title="Show file tree"
            >
              <PanelLeftOpen className="w-4 h-4" />
            </button>
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="flex items-center justify-center w-7 h-7 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title="Refresh files"
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
        )}

        {/* File tree sidebar */}
        {fileTreeVisible && (
          <div
            className="flex-shrink-0 border-r border-[var(--color-border)] bg-[var(--color-bg)] overflow-hidden flex flex-col"
            style={isMobile ? {
              position: 'fixed',
              top: 0,
              left: 0,
              height: '100%',
              width: 280,
              zIndex: 20,
              boxShadow: '4px 0 16px rgba(0,0,0,0.25)',
            } : {
              width: 250,
            }}
          >
            {/* Collapse button inside sidebar header */}
            <div className="flex items-center justify-between px-2 py-1.5 border-b border-[var(--color-border)]">
              <span className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider pl-1">Files</span>
              <div className="flex items-center gap-0.5">
                <button
                  onClick={handleRefresh}
                  disabled={refreshing}
                  className="flex items-center justify-center w-6 h-6 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Refresh files"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                </button>
                <button
                  onClick={() => setFileTreeVisible(false)}
                  className="flex items-center justify-center w-6 h-6 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
                  title="Hide file tree"
                >
                  <PanelLeftClose className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            <FileTree
              key={treeKey}
              nodes={fileNodes}
              selectedFile={selectedFile}
              onSelectFile={handleSelectFile}
              onContextMenu={handleContextMenu}
              creatingPath={creatingPath}
              onSubmitPath={handleSubmitPath}
              onCancelPath={handleCancelPath}
              onExpandDir={handleExpandDir}
            />
          </div>
        )}

        {/* Editor area */}
        <div className="flex-1 flex flex-col min-w-0">
          {loading ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="w-8 h-8 text-[var(--color-text-muted)] animate-spin" />
            </div>
          ) : error ? (
            <div className="flex-1 flex items-center justify-center p-6">
              <div className="flex flex-col items-center gap-3 max-w-xs text-center">
                <AlertCircle className="w-8 h-8" style={{ color: "var(--color-text-muted)" }} />
                <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
                  {(() => {
                    const e = error.toLowerCase();
                    return e.includes('utf-8') || e.includes('utf8') || e.includes('binary') || e.includes('not valid utf') || e.includes('invalid utf')
                      ? 'Binary file — preview not supported'
                      : 'Failed to open file';
                  })()}
                </p>
              </div>
            </div>
          ) : selectedFile ? (
            <Editor
              height="100%"
              language={getLanguage(selectedFile)}
              value={fileContent}
              onChange={handleEditorChange}
              theme="vs-dark"
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                lineNumbers: 'on',
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                automaticLayout: true,
                padding: { top: 8 },
                renderWhitespace: 'selection',
              }}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-sm text-[var(--color-text-muted)]">
                Select a file to edit
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Context Menu */}
      <FileContextMenu
        isOpen={contextMenuOpen}
        position={contextMenuPosition}
        target={contextMenuTarget}
        onClose={() => setContextMenuOpen(false)}
        onNewFile={handleNewFile}
        onNewDirectory={handleNewDirectory}
        onDelete={handleDelete}
        onCopyPath={handleCopyPath}
      />

      {/* Confirm Dialog for deletion */}
      <ConfirmDialog
        isOpen={confirmDialogOpen}
        title="Delete"
        message={`Are you sure you want to delete "${deleteTarget}"? This action cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={handleConfirmDelete}
        onCancel={() => {
          setConfirmDialogOpen(false);
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}
