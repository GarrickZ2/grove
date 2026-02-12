import { useState, useCallback, useRef, useEffect } from "react";
import { ChevronRight, ChevronDown, FileText, Folder } from "lucide-react";
import type { FileTreeNode } from "../../../utils/fileTree";
import { VSCodeIcon } from "../../ui";

interface FileTreeProps {
  nodes: FileTreeNode[];
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
  onContextMenu?: (e: React.MouseEvent, path: string, isDir: boolean) => void;
  creatingPath?: { type: 'file' | 'directory'; parentPath: string; depth: number } | null;
  onSubmitPath?: (name: string) => void;
  onCancelPath?: () => void;
}

export function FileTree({
  nodes,
  selectedFile,
  onSelectFile,
  onContextMenu,
  creatingPath,
  onSubmitPath,
  onCancelPath,
}: FileTreeProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex flex-col text-sm overflow-y-auto h-full py-1">
      {/* Root level inline input */}
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
        />
      ))}
    </div>
  );
}

// Inline input for creating files/directories
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
  const Icon = type === 'file' ? FileText : Folder;

  useEffect(() => {
    inputRef.current?.focus();
  }, [inputRef]);

  return (
    <div
      className="flex items-center gap-1 w-full px-2 py-0.5 bg-[var(--color-bg-tertiary)]/50"
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
    >
      <span className="w-4 h-4 flex-shrink-0" />
      <Icon className="w-4 h-4 text-[var(--color-warning)] flex-shrink-0" />
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
}: FileTreeItemProps) {
  const [expanded, setExpanded] = useState(depth < 1);
  const isSelected = !node.isDir && selectedFile === node.path;

  const handleClick = useCallback(() => {
    if (node.isDir) {
      setExpanded((prev) => !prev);
    } else {
      onSelectFile(node.path);
    }
  }, [node, onSelectFile]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (onContextMenu) {
      onContextMenu(e, node.path, node.isDir);
    }
  }, [node, onContextMenu]);

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
        {/* Expand/collapse icon for directories */}
        {node.isDir ? (
          <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">
            {expanded ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
          </span>
        ) : (
          <span className="w-4 h-4 flex-shrink-0" />
        )}

        {/* File/folder icon */}
        <VSCodeIcon
          filename={node.name}
          isFolder={node.isDir}
          isOpen={expanded}
          size={16}
        />

        {/* Name */}
        <span className="truncate text-xs">{node.name}</span>
      </button>

      {/* Children */}
      {node.isDir && expanded && node.children && (
        <>
          {/* Inline input for this directory */}
          {creatingPath && creatingPath.parentPath === node.path && (
            <InlinePathInput
              type={creatingPath.type}
              depth={depth + 1}
              onSubmit={onSubmitPath!}
              onCancel={onCancelPath!}
              inputRef={inputRef!}
            />
          )}

          {node.children.map((child) => (
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
            />
          ))}
        </>
      )}
    </>
  );
}
