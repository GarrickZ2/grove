import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { DiffFile } from '../../api/review';
import type { DirEntry } from '../../api/tasks';
import { FolderOpen, Folder, Search, MessageSquare, FilePlus, FolderPlus, Copy, FileText } from 'lucide-react';
import { VSCodeIcon } from '../ui';

interface FileCommentCount {
  total: number;
  unresolved: number;
}

interface FileTreeSidebarProps {
  files: DiffFile[];
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
  fileCommentCounts?: Map<string, FileCommentCount>;
  collapsed?: boolean;
  getFileViewedStatus?: (path: string) => 'none' | 'viewed' | 'updated';
  onCreateVirtualPath?: (path: string) => void;
  viewMode?: 'diff' | 'full';
  onExpandDir?: (dirPath: string) => Promise<DirEntry[]>;
  onLoadFileDiff?: (filePath: string, fromRef?: string, toRef?: string) => Promise<void>;
  /** Absolute worktree path — used to compute "Copy Full Path" */
  taskPath?: string | null;
}

interface DirNode {
  name: string;
  path: string;
  children: (DirNode | FileNode)[];
}

interface FileNode {
  name: string;
  path: string;
  file: DiffFile;
}

function isDirNode(n: DirNode | FileNode): n is DirNode {
  return 'children' in n;
}

export function FileTreeSidebar({
  files,
  selectedFile,
  onSelectFile,
  searchQuery = '',
  onSearchChange,
  fileCommentCounts,
  collapsed = false,
  getFileViewedStatus,
  onCreateVirtualPath,
  viewMode = 'diff',
  onExpandDir,
  onLoadFileDiff,
  taskPath,
}: FileTreeSidebarProps) {
  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    targetPath: string;
    isDirectory: boolean;
  } | null>(null);

  // Inline input state for creating virtual files
  const [creatingVirtual, setCreatingVirtual] = useState<{
    type: 'file' | 'directory';
    parentPath: string;
    depth: number;
  } | null>(null);
  const virtualInputRef = useRef<HTMLInputElement>(null);

  // Filter files by search query
  const filteredFiles = searchQuery
    ? files.filter((f) => f.new_path.toLowerCase().includes(searchQuery.toLowerCase()))
    : files;

  const tree = buildTree(filteredFiles);

  // Close context menu on click outside
  const handleCloseContextMenu = () => {
    setContextMenu(null);
  };

  const handleContextMenu = (e: React.MouseEvent, path: string, isDirectory: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      targetPath: path,
      isDirectory,
    });
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  };

  const handleCopyRelativePath = () => {
    if (!contextMenu) return;
    void copyToClipboard(contextMenu.targetPath);
    setContextMenu(null);
  };

  const handleCopyFullPath = () => {
    if (!contextMenu) return;
    const rel = contextMenu.targetPath;
    const full = taskPath
      ? `${taskPath.replace(/\/$/, '')}/${rel}`
      : rel;
    void copyToClipboard(full);
    setContextMenu(null);
  };

  const handleCreateVirtual = (type: 'file' | 'directory') => {
    if (!contextMenu) return;
    const parentPath = contextMenu.isDirectory ? contextMenu.targetPath : contextMenu.targetPath.split('/').slice(0, -1).join('/');
    const depth = parentPath ? parentPath.split('/').length : 0;

    setCreatingVirtual({
      type,
      parentPath,
      depth: depth + 1,
    });
    setContextMenu(null);
  };

  const handleSubmitVirtualPath = (name: string) => {
    if (!creatingVirtual || !onCreateVirtualPath) return;
    const fullPath = creatingVirtual.parentPath ? `${creatingVirtual.parentPath}/${name}` : name;
    onCreateVirtualPath(fullPath);
    setCreatingVirtual(null);
  };

  const handleCancelVirtualPath = () => {
    setCreatingVirtual(null);
  };

  return (
    <div className={`diff-sidebar ${collapsed ? 'collapsed' : ''}`} onClick={handleCloseContextMenu}>
      {/* Search box */}
      {onSearchChange && (
        <div className="diff-sidebar-search">
          <Search style={{ width: 13, height: 13, color: 'var(--color-text-muted)', flexShrink: 0 }} />
          <input
            className="diff-sidebar-search-input"
            type="text"
            placeholder="Filter files..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
      )}

      <div className="diff-sidebar-list">
        {/* Root level virtual path input */}
        {creatingVirtual && creatingVirtual.parentPath === '' && (
          <VirtualPathInput
            type={creatingVirtual.type}
            depth={0}
            onSubmit={handleSubmitVirtualPath}
            onCancel={handleCancelVirtualPath}
            inputRef={virtualInputRef}
          />
        )}

        {tree.map((node) => (
          <TreeNode
            key={isDirNode(node) ? node.path : node.path}
            node={node}
            depth={0}
            selectedFile={selectedFile}
            onSelectFile={onSelectFile}
            fileCommentCounts={fileCommentCounts}
            getFileViewedStatus={getFileViewedStatus}
            onContextMenu={handleContextMenu}
            creatingVirtual={creatingVirtual}
            onSubmitVirtualPath={handleSubmitVirtualPath}
            onCancelVirtualPath={handleCancelVirtualPath}
            virtualInputRef={virtualInputRef}
            viewMode={viewMode}
            onExpandDir={onExpandDir}
            onLoadFileDiff={onLoadFileDiff}
          />
        ))}
      </div>

      {/* Context Menu (portaled to body to escape transformed ancestors) */}
      {contextMenu && createPortal(
        <>
          <div
            className="file-tree-context-menu-backdrop"
            onClick={handleCloseContextMenu}
            onContextMenu={(e) => { e.preventDefault(); handleCloseContextMenu(); }}
          />
          <div
            className="file-tree-context-menu"
            style={{
              left: contextMenu.x,
              top: contextMenu.y,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button onClick={handleCopyRelativePath}>
              <Copy style={{ width: 14, height: 14 }} />
              Copy Relative Path
            </button>
            <button onClick={handleCopyFullPath} disabled={!taskPath}>
              <FileText style={{ width: 14, height: 14 }} />
              Copy Full Path
            </button>
            {viewMode === 'full' && onCreateVirtualPath && (
              <>
                <div className="file-tree-context-menu-separator" />
                <button onClick={() => handleCreateVirtual('file')}>
                  <FilePlus style={{ width: 14, height: 14 }} />
                  Create Virtual File
                </button>
              </>
            )}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

// Inline input for creating virtual files/directories
function VirtualPathInput({
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
  const Icon = type === 'file' ? FilePlus : FolderPlus;

  return (
    <div
      className="diff-sidebar-item virtual-input"
      style={{ paddingLeft: depth * 12 + 12 }}
    >
      <Icon style={{ width: 14, height: 14, color: 'var(--color-warning)', flexShrink: 0 }} />
      <input
        ref={inputRef}
        type="text"
        className="virtual-path-input"
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

function TreeNode({
  node,
  depth,
  selectedFile,
  onSelectFile,
  fileCommentCounts,
  getFileViewedStatus,
  onContextMenu,
  creatingVirtual,
  onSubmitVirtualPath,
  onCancelVirtualPath,
  virtualInputRef,
  viewMode,
  onExpandDir,
  onLoadFileDiff,
}: {
  node: DirNode | FileNode;
  depth: number;
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
  fileCommentCounts?: Map<string, FileCommentCount>;
  getFileViewedStatus?: (path: string) => 'none' | 'viewed' | 'updated';
  onContextMenu?: (e: React.MouseEvent, path: string, isDirectory: boolean) => void;
  creatingVirtual?: { type: 'file' | 'directory'; parentPath: string; depth: number } | null;
  onSubmitVirtualPath?: (name: string) => void;
  onCancelVirtualPath?: () => void;
  virtualInputRef?: React.RefObject<HTMLInputElement | null>;
  viewMode?: 'diff' | 'full';
  onExpandDir?: (dirPath: string) => Promise<DirEntry[]>;
  onLoadFileDiff?: (filePath: string, fromRef?: string, toRef?: string) => Promise<void>;
}) {
  // In lazy dir mode (onExpandDir provided) start collapsed, UNLESS the selected file is
  // a descendant of this directory — in which case start expanded so the file is visible.
  const isAncestorOfSelected = isDirNode(node) && !!selectedFile?.startsWith(node.path + '/');
  const [expanded, setExpanded] = useState(() => !onExpandDir || isAncestorOfSelected);
  // Track which selectedFile we last auto-expanded for, to avoid re-expanding after user collapses.
  const autoExpandedForRef = useRef<string | null>(isAncestorOfSelected ? selectedFile : null);

  // Auto-expand when selectedFile changes to a descendant of this directory.
  useEffect(() => {
    if (!isDirNode(node)) return;
    if (!selectedFile || !selectedFile.startsWith(node.path + '/')) return;
    if (autoExpandedForRef.current === selectedFile) return;
    autoExpandedForRef.current = selectedFile;
    setExpanded(true);
    // In lazy-load mode, also trigger dir load so children become available.
    if (onExpandDir) onExpandDir(node.path).catch(console.error);
  }, [selectedFile]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (creatingVirtual && virtualInputRef?.current) {
      virtualInputRef.current.focus();
    }
  }, [creatingVirtual, virtualInputRef]);

  if (isDirNode(node)) {
    // Check if we should show inline input after this directory
    const shouldShowInput = creatingVirtual && creatingVirtual.parentPath === node.path && expanded;

    return (
      <>
        <button
          className="diff-sidebar-item"
          style={{ paddingLeft: depth * 12 + 12 }}
          onClick={() => {
            if (!expanded && onExpandDir) {
              // After the dir expands, preload diffs for the newly-revealed files
              onExpandDir(node.path).then((entries) => {
                if (onLoadFileDiff) {
                  entries.forEach((entry) => {
                    if (!entry.is_dir) {
                      onLoadFileDiff(entry.path).catch(console.error);
                    }
                  });
                }
              }).catch(console.error);
            }
            setExpanded(!expanded);
          }}
          onContextMenu={(e) => onContextMenu?.(e, node.path, true)}
        >
          {viewMode === 'full' ? (
            <VSCodeIcon filename={node.name.split('/').pop() || node.name} isFolder isOpen={expanded} size={14} />
          ) : expanded ? (
            <FolderOpen style={{ width: 14, height: 14, color: 'var(--color-text-muted)', flexShrink: 0 }} />
          ) : (
            <Folder style={{ width: 14, height: 14, color: 'var(--color-text-muted)', flexShrink: 0 }} />
          )}
          <span style={{ opacity: 0.85, fontWeight: 500 }}>{node.name}</span>
        </button>
        {expanded && (
          <>
            {shouldShowInput && (
              <VirtualPathInput
                type={creatingVirtual.type}
                depth={creatingVirtual.depth}
                onSubmit={onSubmitVirtualPath!}
                onCancel={onCancelVirtualPath!}
                inputRef={virtualInputRef!}
              />
            )}
            {node.children.map((child) => (
              <TreeNode
                key={isDirNode(child) ? child.path : child.path}
                node={child}
                depth={depth + 1}
                selectedFile={selectedFile}
                onSelectFile={onSelectFile}
                fileCommentCounts={fileCommentCounts}
                getFileViewedStatus={getFileViewedStatus}
                onContextMenu={onContextMenu}
                creatingVirtual={creatingVirtual}
                onSubmitVirtualPath={onSubmitVirtualPath}
                onCancelVirtualPath={onCancelVirtualPath}
                virtualInputRef={virtualInputRef}
                viewMode={viewMode}
                onExpandDir={onExpandDir}
                onLoadFileDiff={onLoadFileDiff}
              />
            ))}
          </>
        )}
      </>
    );
  }

  const file = node.file;
  const isActive = selectedFile === file.new_path;
  const commentInfo = fileCommentCounts?.get(file.new_path);
  const viewedStatus = getFileViewedStatus?.(file.new_path) ?? 'none';

  return (
    <button
      className={`diff-sidebar-item ${isActive ? 'active' : ''} ${file.is_virtual ? 'virtual' : ''}`}
      style={{ paddingLeft: depth * 12 + 12 }}
      onClick={() => onSelectFile(file.new_path)}
      onContextMenu={(e) => onContextMenu?.(e, file.new_path, false)}
      title={file.is_virtual ? 'Planned file (not yet created)' : undefined}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('application/x-grove-file-path', file.new_path);
        e.dataTransfer.setData('text/plain', file.new_path);
      }}
    >
      {viewMode === 'full' ? (
        <VSCodeIcon filename={node.name} size={14} />
      ) : (
        <StatusIcon changeType={file.change_type} isVirtual={file.is_virtual} isUntracked={file.is_untracked} />
      )}
      <span
        className={`truncate ${viewedStatus === 'viewed' ? 'diff-sidebar-file-viewed' : ''}`}
        style={file.is_virtual ? { opacity: 0.7, fontStyle: 'italic' } : undefined}
      >
        {node.name}
      </span>
      {viewedStatus === 'viewed' && (
        <span className="diff-sidebar-viewed-badge">Viewed</span>
      )}
      {viewedStatus === 'updated' && (
        <span className="diff-sidebar-updated-badge">Updated</span>
      )}
      <span className="diff-sidebar-item-right">
        {commentInfo && commentInfo.unresolved > 0 && (
          <span className="diff-sidebar-comment-badge">
            <MessageSquare style={{ width: 10, height: 10 }} />
            {commentInfo.unresolved}
          </span>
        )}
        <span className="diff-sidebar-item-stats">
          {file.is_binary ? (
            <span style={{ fontSize: 9, color: 'var(--color-text-muted)', fontStyle: 'italic' }}>Binary</span>
          ) : (
            <>
              {file.additions > 0 && <span className="stat-add">+{file.additions}</span>}
              {file.deletions > 0 && <span className="stat-del">-{file.deletions}</span>}
            </>
          )}
        </span>
      </span>
    </button>
  );
}

function StatusIcon({ changeType, isVirtual, isUntracked }: { changeType: string; isVirtual?: boolean; isUntracked?: boolean }) {
  const color =
    changeType === 'added'
      ? 'var(--color-success)'
      : changeType === 'deleted'
        ? 'var(--color-error)'
        : changeType === 'renamed'
          ? 'var(--color-warning)'
          : 'var(--color-info)';
  const letter = isUntracked ? 'U' : changeType === 'added' ? 'A' : changeType === 'deleted' ? 'D' : changeType === 'renamed' ? 'R' : 'M';

  return (
    <span
      style={{
        color: isVirtual ? 'var(--color-warning)' : color,
        fontWeight: 600,
        fontSize: 10,
        width: 14,
        textAlign: 'center',
        flexShrink: 0,
        opacity: isVirtual ? 0.7 : 1,
      }}
      title={isVirtual ? 'Planned file (not yet created)' : undefined}
    >
      {letter}
    </span>
  );
}

/** Build a tree of directories and files from flat DiffFile list */
function buildTree(files: DiffFile[]): (DirNode | FileNode)[] {
  const root: DirNode = { name: '', path: '', children: [] };

  for (const file of files) {
    const rawPath = file.new_path;
    const isDirPlaceholder = rawPath.endsWith('/');
    const parts = rawPath.replace(/\/$/, '').split('/');
    let current = root;

    for (let i = 0; i < parts.length - 1; i++) {
      const dirName = parts[i];
      const dirPath = parts.slice(0, i + 1).join('/');
      let existing = current.children.find((c) => isDirNode(c) && c.name === dirName) as
        | DirNode
        | undefined;
      if (!existing) {
        existing = { name: dirName, path: dirPath, children: [] };
        current.children.push(existing);
      }
      current = existing;
    }

    if (isDirPlaceholder) {
      const dirName = parts[parts.length - 1];
      const dirPath = parts.join('/');
      if (!current.children.find((c) => isDirNode(c) && c.name === dirName)) {
        current.children.push({ name: dirName, path: dirPath, children: [] });
      }
    } else {
      current.children.push({
        name: parts[parts.length - 1],
        path: file.new_path,
        file,
      });
    }
  }

  // Sort: dirs first, then files, alphabetically
  const sortNodes = (nodes: (DirNode | FileNode)[]) => {
    nodes.sort((a, b) => {
      const aIsDir = isDirNode(a) ? 0 : 1;
      const bIsDir = isDirNode(b) ? 0 : 1;
      if (aIsDir !== bIsDir) return aIsDir - bIsDir;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) {
      if (isDirNode(n)) sortNodes(n.children);
    }
  };
  sortNodes(root.children);

  // Collapse single-child directories
  const collapse = (nodes: (DirNode | FileNode)[]): (DirNode | FileNode)[] => {
    return nodes.map((n) => {
      if (!isDirNode(n)) return n;
      n.children = collapse(n.children);
      // If this dir has exactly one child which is also a dir, merge them
      if (n.children.length === 1 && isDirNode(n.children[0])) {
        const child = n.children[0];
        return { ...child, name: `${n.name}/${child.name}` };
      }
      return n;
    });
  };

  return collapse(root.children);
}
