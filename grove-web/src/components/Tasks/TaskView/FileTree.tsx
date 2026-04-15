import { useState, useCallback, useRef, useEffect } from "react";
import { ChevronRight, ChevronDown, Loader2 } from "lucide-react";
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
}: FileTreeProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex flex-col text-sm overflow-y-auto h-full py-1">
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
}: FileTreeItemProps) {
  // Lazy mode: always start collapsed (load on first click).
  // Static mode: auto-expand root level (depth < 1).
  const [expanded, setExpanded] = useState(onExpandDir ? false : depth < 1);
  const [children, setChildren] = useState<FileTreeNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const loadedRef = useRef(false);
  const isSelected = !node.isDir && selectedFile === node.path;

  const handleClick = useCallback(async () => {
    if (node.isDir) {
      if (!expanded && onExpandDir && !loadedRef.current) {
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
        } catch (err) {
          console.error('Failed to load directory:', err);
          // Do not expand if the load failed — leave the node collapsed
          return;
        } finally {
          setLoading(false);
        }
      }
      setExpanded((prev) => !prev);
    } else {
      onSelectFile(node.path);
    }
  }, [node, onSelectFile, onExpandDir, expanded]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (onContextMenu) {
      onContextMenu(e, node.path, node.isDir);
    }
  }, [node, onContextMenu]);

  // Lazy mode: use loaded children state; static mode: use node.children from props.
  const displayChildren = onExpandDir ? (children ?? []) : (node.children ?? []);

  return (
    <>
      <button
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        className={`
          flex items-center gap-1 w-full text-left px-2 py-0.5 hover:bg-[var(--color-bg-tertiary)] transition-colors
          ${isSelected ? "bg-[var(--color-highlight)]/15 text-[var(--color-highlight)]" : "text-[var(--color-text-muted)]"}
        `}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {node.isDir ? (
          <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">
            {loading ? (
              <Loader2 className="w-3 h-3 animate-spin" />
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
          isOpen={expanded}
          size={16}
        />

        <span className="truncate text-xs">{node.name}</span>
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
            />
          ))}
        </>
      )}
    </>
  );
}
