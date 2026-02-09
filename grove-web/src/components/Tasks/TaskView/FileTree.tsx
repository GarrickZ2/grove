import { useState, useCallback } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import type { FileTreeNode } from "../../../utils/fileTree";
import { VSCodeIcon } from "../../ui";

interface FileTreeProps {
  nodes: FileTreeNode[];
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
}

export function FileTree({ nodes, selectedFile, onSelectFile }: FileTreeProps) {
  return (
    <div className="flex flex-col text-sm overflow-y-auto h-full py-1">
      {nodes.map((node) => (
        <FileTreeItem
          key={node.path}
          node={node}
          depth={0}
          selectedFile={selectedFile}
          onSelectFile={onSelectFile}
        />
      ))}
    </div>
  );
}

interface FileTreeItemProps {
  node: FileTreeNode;
  depth: number;
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
}

function FileTreeItem({ node, depth, selectedFile, onSelectFile }: FileTreeItemProps) {
  const [expanded, setExpanded] = useState(depth < 1);
  const isSelected = !node.isDir && selectedFile === node.path;

  const handleClick = useCallback(() => {
    if (node.isDir) {
      setExpanded((prev) => !prev);
    } else {
      onSelectFile(node.path);
    }
  }, [node, onSelectFile]);

  return (
    <>
      <button
        onClick={handleClick}
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
          {node.children.map((child) => (
            <FileTreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedFile={selectedFile}
              onSelectFile={onSelectFile}
            />
          ))}
        </>
      )}
    </>
  );
}
