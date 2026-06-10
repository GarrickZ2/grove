import { useState, useCallback, useRef, useEffect } from "react";
import { ChevronRight, ChevronDown, Loader2, ShieldOff } from "lucide-react";
import type { FileTreeNode } from "../../../utils/fileTree";
import type { DirEntry } from "../../../api";
import { VSCodeIcon } from "../../ui";

interface FileTreeProps {
  nodes: FileTreeNode[];
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
  onContextMenu?: (e: React.MouseEvent, path: string, isDir: boolean) => void;
  creatingPath?: { type: 'file' | 'directory'; parentPath: string; depth: number } | null;
  onSubmitPath?: (name: string) => void;
  onCancelPath?: () => void;
  onExpandDir?: (path: string) => Promise<DirEntry[]>;
  onMoveFile?: (source: string, destination: string) => void;
  onUploadFile?: (parentPath: string, file: File) => void;
  /** Bumped to re-fetch expanded directories in place (preserves expansion). */
  refreshSignal?: number;
}

export function FileTree({
  nodes,
  selectedFile,
  onSelectFile,
  onContextMenu,
  creatingPath,
  onSubmitPath,
  onCancelPath,
  onExpandDir,
  onMoveFile,
  onUploadFile,
  refreshSignal,
}: FileTreeProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isTreeDragOver, setIsTreeDragOver] = useState(false);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsTreeDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsTreeDragOver(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsTreeDragOver(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      if (onUploadFile) {
        for (let i = 0; i < e.dataTransfer.files.length; i++) {
          const file = e.dataTransfer.files[i];
          onUploadFile("", file);
        }
      }
    } else {
      const sourcePath = e.dataTransfer.getData('application/x-grove-file-path');
      if (!sourcePath) return;

      const fileName = sourcePath.split('/').pop() || sourcePath;
      const destPath = fileName; // Move to root

      if (sourcePath === destPath) return;

      if (onMoveFile) {
        onMoveFile(sourcePath, destPath);
      }
    }
  }, [onMoveFile, onUploadFile]);

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className={`flex flex-col text-sm overflow-y-auto h-full py-1 transition-all duration-200 relative
        ${isTreeDragOver ? "bg-[var(--color-highlight)]/5 border-2 border-dashed border-[var(--color-highlight)]/30 rounded-lg m-1" : ""}
      `}
    >
      {creatingPath && creatingPath.parentPath === '' && (
        <InlinePathInput
          type={creatingPath.type}
          depth={0}
          onSubmit={onSubmitPath!}
          onCancel={onCancelPath!}
          inputRef={inputRef}
        />
      )}

      {nodes.map((node) => (
        <FileTreeItem
          key={node.path}
          node={node}
          depth={0}
          selectedFile={selectedFile}
          onSelectFile={onSelectFile}
          onContextMenu={onContextMenu}
          creatingPath={creatingPath}
          onSubmitPath={onSubmitPath}
          onCancelPath={onCancelPath}
          inputRef={inputRef}
          onExpandDir={onExpandDir}
          onMoveFile={onMoveFile}
          onUploadFile={onUploadFile}
          refreshSignal={refreshSignal}
        />
      ))}
    </div>
  );
}

function InlinePathInput({
  type,
  depth,
  onSubmit,
  onCancel,
  inputRef,
}: {
  type: 'file' | 'directory';
  depth: number;
  onSubmit: (name: string) => void;
  onCancel: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const Icon = VSCodeIcon;

  useEffect(() => {
    inputRef.current?.focus();
  }, [inputRef]);

  return (
    <div
      className="flex items-center gap-1 w-full px-2 py-0.5 bg-[var(--color-bg-tertiary)]/50"
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
    >
      <span className="w-4 h-4 flex-shrink-0" />
      <Icon
        filename={type === 'file' ? 'new.txt' : 'folder'}
        isFolder={type === 'directory'}
        isOpen={false}
        size={16}
      />
      <input
        ref={inputRef}
        type="text"
        className="flex-1 bg-transparent border-none outline-none text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] placeholder:italic"
        placeholder={`${type === 'file' ? 'filename' : 'dirname'}...`}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const value = (e.target as HTMLInputElement).value.trim();
            if (value) onSubmit(value);
          } else if (e.key === 'Escape') {
            onCancel();
          }
        }}
        onBlur={onCancel}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

interface FileTreeItemProps {
  node: FileTreeNode;
  depth: number;
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
  onContextMenu?: (e: React.MouseEvent, path: string, isDir: boolean) => void;
  creatingPath?: { type: 'file' | 'directory'; parentPath: string; depth: number } | null;
  onSubmitPath?: (name: string) => void;
  onCancelPath?: () => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  onExpandDir?: (path: string) => Promise<DirEntry[]>;
  onMoveFile?: (source: string, destination: string) => void;
  onUploadFile?: (parentPath: string, file: File) => void;
  refreshSignal?: number;
}

function FileTreeItem({
  node,
  depth,
  selectedFile,
  onSelectFile,
  onContextMenu,
  creatingPath,
  onSubmitPath,
  onCancelPath,
  inputRef,
  onExpandDir,
  onMoveFile,
  onUploadFile,
  refreshSignal,
}: FileTreeItemProps) {
  // Lazy mode: always start collapsed (load on first click).
  // Static mode: auto-expand root level (depth < 1).
  const [expanded, setExpanded] = useState(onExpandDir ? false : depth < 1);
  const [children, setChildren] = useState<FileTreeNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandError, setExpandError] = useState<string | null>(null);
  const loadedRef = useRef(false);
  const isSelected = !node.isDir && selectedFile === node.path;
  const [isDragOver, setIsDragOver] = useState(false);


  // Fetch (or re-fetch) this directory's children. Returns false on failure.
  const loadChildren = useCallback(async (): Promise<boolean> => {
    if (!onExpandDir) return false;
    setLoading(true);
    try {
      const entries = await onExpandDir(node.path);
      loadedRef.current = true;
      const childNodes: FileTreeNode[] = entries
        .sort((a, b) => {
          if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
          const aName = a.path.split('/').pop() || a.path;
          const bName = b.path.split('/').pop() || b.path;
          return aName.localeCompare(bName);
        })
        .map(e => {
          const name = e.path.split('/').pop() || e.path;
          return {
            name,
            path: e.path,
            isDir: e.is_dir,
            children: e.is_dir ? [] : undefined,
          };
        });
      setChildren(childNodes);
      setExpandError(null);
      setLoading(false);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isForbidden = msg.includes('403') || msg.toLowerCase().includes('forbidden');
      setExpandError(isForbidden ? 'Symlink folders cannot be expanded' : 'Failed to load folder');
      setLoading(false);
      return false;
    }
  }, [node.path, onExpandDir]);

  const handleClick = useCallback(async () => {
    if (node.isDir) {
      // Once a symlink/forbidden error is set, treat the folder as non-expandable
      if (expandError) return;
      if (!expanded && onExpandDir && !loadedRef.current) {
        const ok = await loadChildren();
        if (!ok) return;
      }
      setExpanded((prev) => !prev);
    } else {
      onSelectFile(node.path);
    }
  }, [node, onSelectFile, onExpandDir, expanded, expandError, loadChildren]);

  // On a refresh signal, re-fetch children for directories that are currently
  // expanded and already loaded — keeps the tree's expansion state intact
  // instead of remounting and collapsing everything.
  const prevRefreshSignal = useRef(refreshSignal);
  useEffect(() => {
    if (prevRefreshSignal.current === refreshSignal) return;
    prevRefreshSignal.current = refreshSignal;
    if (expanded && loadedRef.current && onExpandDir && !expandError) {
      void loadChildren();
    }
  }, [refreshSignal, expanded, onExpandDir, expandError, loadChildren]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (onContextMenu) {
      onContextMenu(e, node.path, node.isDir);
    }
  }, [node, onContextMenu]);

  // Lazy mode: use loaded children state; static mode: use node.children from props.
  const displayChildren = onExpandDir ? (children ?? []) : (node.children ?? []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      // Determine folder target path
      let parentPath = "";
      if (node.isDir) {
        parentPath = node.path;
      } else {
        const parts = node.path.split('/');
        parts.pop();
        parentPath = parts.join('/');
      }

      if (onUploadFile) {
        for (let i = 0; i < e.dataTransfer.files.length; i++) {
          const file = e.dataTransfer.files[i];
          onUploadFile(parentPath, file);
        }
      }
    } else {
      const sourcePath = e.dataTransfer.getData('application/x-grove-file-path');
      if (!sourcePath) return;

      // Determine parent path
      let parentPath = "";
      if (node.isDir) {
        parentPath = node.path;
      } else {
        const parts = node.path.split('/');
        parts.pop();
        parentPath = parts.join('/');
      }

      const fileName = sourcePath.split('/').pop() || sourcePath;
      const destPath = parentPath ? `${parentPath}/${fileName}` : fileName;

      if (sourcePath === destPath) return;

      // Prevent dragging a directory into its own descendant
      if (destPath === sourcePath || destPath.startsWith(sourcePath + '/')) {
        console.warn("Cannot move a directory into itself or its subdirectories");
        return;
      }

      if (onMoveFile) {
        onMoveFile(sourcePath, destPath);
      }
    }
  }, [node, onMoveFile, onUploadFile]);

  return (
    <>
      <button
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        title={expandError ?? undefined}
        className={`
          flex items-center gap-1 w-full text-left px-2 py-0.5 hover:bg-[var(--color-bg-tertiary)] transition-all duration-150 relative
          ${isSelected ? "bg-[var(--color-highlight)]/15 text-[var(--color-highlight)]" : "text-[var(--color-text)] opacity-80 hover:opacity-100"}
          ${isDragOver ? "bg-[var(--color-highlight)]/10 border-l-2 border-[var(--color-highlight)] text-[var(--color-highlight)] pl-3" : ""}
        `}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        draggable={true}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('application/x-grove-file-path', node.path);
          e.dataTransfer.setData('application/x-grove-file-is-dir', node.isDir ? 'true' : 'false');
          e.dataTransfer.setData('text/plain', node.path);
        }}
      >
        {node.isDir ? (
          <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">
            {loading ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : expandError ? (
              <ShieldOff className="w-3 h-3 opacity-40" />
            ) : expanded ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
          </span>
        ) : (
          <span className="w-4 h-4 flex-shrink-0" />
        )}

        <VSCodeIcon
          filename={node.name}
          isFolder={node.isDir}
          isOpen={expanded && !expandError}
          size={16}
        />

        <span className={`truncate text-xs ${expandError ? "opacity-50" : ""}`}>{node.name}</span>
      </button>

      {node.isDir && expanded && (
        <>
          {creatingPath && creatingPath.parentPath === node.path && (
            <InlinePathInput
              type={creatingPath.type}
              depth={depth + 1}
              onSubmit={onSubmitPath!}
              onCancel={onCancelPath!}
              inputRef={inputRef!}
            />
          )}

          {displayChildren.map((child) => (
            <FileTreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedFile={selectedFile}
              onSelectFile={onSelectFile}
              onContextMenu={onContextMenu}
              creatingPath={creatingPath}
              onSubmitPath={onSubmitPath}
              onCancelPath={onCancelPath}
              inputRef={inputRef}
              onExpandDir={onExpandDir}
              onMoveFile={onMoveFile}
              onUploadFile={onUploadFile}
              refreshSignal={refreshSignal}
            />
          ))}
        </>
      )}
    </>
  );
}
