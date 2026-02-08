import { useState } from 'react';
import type { DiffFile } from '../../api/review';
import { FolderOpen, Folder, Search, MessageSquare } from 'lucide-react';

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
}: FileTreeSidebarProps) {
  // Filter files by search query
  const filteredFiles = searchQuery
    ? files.filter((f) => f.new_path.toLowerCase().includes(searchQuery.toLowerCase()))
    : files;

  const tree = buildTree(filteredFiles);

  return (
    <div className={`diff-sidebar ${collapsed ? 'collapsed' : ''}`}>
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
        {tree.map((node) => (
          <TreeNode
            key={isDirNode(node) ? node.path : node.path}
            node={node}
            depth={0}
            selectedFile={selectedFile}
            onSelectFile={onSelectFile}
            fileCommentCounts={fileCommentCounts}
            getFileViewedStatus={getFileViewedStatus}
          />
        ))}
      </div>
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
}: {
  node: DirNode | FileNode;
  depth: number;
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
  fileCommentCounts?: Map<string, FileCommentCount>;
  getFileViewedStatus?: (path: string) => 'none' | 'viewed' | 'updated';
}) {
  const [expanded, setExpanded] = useState(true);

  if (isDirNode(node)) {
    return (
      <>
        <button
          className="diff-sidebar-item"
          style={{ paddingLeft: depth * 12 + 12 }}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <FolderOpen style={{ width: 14, height: 14, color: 'var(--color-text-muted)', flexShrink: 0 }} />
          ) : (
            <Folder style={{ width: 14, height: 14, color: 'var(--color-text-muted)', flexShrink: 0 }} />
          )}
          <span style={{ opacity: 0.85, fontWeight: 500 }}>{node.name}</span>
        </button>
        {expanded &&
          node.children.map((child) => (
            <TreeNode
              key={isDirNode(child) ? child.path : child.path}
              node={child}
              depth={depth + 1}
              selectedFile={selectedFile}
              onSelectFile={onSelectFile}
              fileCommentCounts={fileCommentCounts}
              getFileViewedStatus={getFileViewedStatus}
            />
          ))}
      </>
    );
  }

  const file = node.file;
  const isActive = selectedFile === file.new_path;
  const commentInfo = fileCommentCounts?.get(file.new_path);
  const viewedStatus = getFileViewedStatus?.(file.new_path) ?? 'none';

  return (
    <button
      className={`diff-sidebar-item ${isActive ? 'active' : ''}`}
      style={{ paddingLeft: depth * 12 + 12 }}
      onClick={() => onSelectFile(file.new_path)}
    >
      <StatusIcon changeType={file.change_type} />
      <span className={`truncate ${viewedStatus === 'viewed' ? 'diff-sidebar-file-viewed' : ''}`}>
        {node.name}
      </span>
      {viewedStatus === 'viewed' && (
        <span className="diff-sidebar-viewed-badge">Viewed</span>
      )}
      {viewedStatus === 'updated' && (
        <span className="diff-sidebar-updated-badge">Updated</span>
      )}
      <span className="diff-sidebar-item-right">
        {commentInfo && commentInfo.total > 0 && (
          <span className="diff-sidebar-comment-badge">
            <MessageSquare style={{ width: 10, height: 10 }} />
            {commentInfo.total}
          </span>
        )}
        <span className="diff-sidebar-item-stats">
          {file.additions > 0 && <span className="stat-add">+{file.additions}</span>}
          {file.deletions > 0 && <span className="stat-del">-{file.deletions}</span>}
        </span>
      </span>
    </button>
  );
}

function StatusIcon({ changeType }: { changeType: string }) {
  const color =
    changeType === 'added'
      ? 'var(--color-success)'
      : changeType === 'deleted'
        ? 'var(--color-error)'
        : changeType === 'renamed'
          ? 'var(--color-warning)'
          : 'var(--color-info)';
  const letter = changeType === 'added' ? 'A' : changeType === 'deleted' ? 'D' : changeType === 'renamed' ? 'R' : 'M';

  return (
    <span
      style={{
        color,
        fontWeight: 600,
        fontSize: 10,
        width: 14,
        textAlign: 'center',
        flexShrink: 0,
      }}
    >
      {letter}
    </span>
  );
}

/** Build a tree of directories and files from flat DiffFile list */
function buildTree(files: DiffFile[]): (DirNode | FileNode)[] {
  const root: DirNode = { name: '', path: '', children: [] };

  for (const file of files) {
    const parts = file.new_path.split('/');
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

    current.children.push({
      name: parts[parts.length - 1],
      path: file.new_path,
      file,
    });
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
