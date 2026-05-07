import { useEffect, useRef, useState, useLayoutEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { FileText, FolderPlus, Trash2, Copy } from "lucide-react";

export interface ContextMenuPosition {
  x: number;
  y: number;
}

export interface ContextMenuTarget {
  path: string;
  isDirectory: boolean;
}

interface FileContextMenuProps {
  isOpen: boolean;
  position: ContextMenuPosition;
  target: ContextMenuTarget | null;
  taskPath?: string | null;
  onClose: () => void;
  onNewFile: (parentPath?: string) => void;
  onNewDirectory: (parentPath?: string) => void;
  onDelete: (path: string) => void;
  onCopyRelativePath: (path: string) => void;
  onCopyFullPath: (path: string) => void;
}

export function FileContextMenu({
  isOpen,
  position,
  target,
  taskPath,
  onClose,
  onNewFile,
  onNewDirectory,
  onDelete,
  onCopyRelativePath,
  onCopyFullPath,
}: FileContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  // Measure menu size for overflow adjustment
  useLayoutEffect(() => {
    if (!isOpen || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    setDimensions({ width: rect.width, height: rect.height });
  }, [isOpen, position]);

  // Close menu on escape or click outside (backdrop handles click outside)
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen, onClose]);

  const adjustedPosition = useMemo(() => {
    const pos = { ...position };
    if (dimensions.width > 0 && position.x + dimensions.width > window.innerWidth) {
      pos.x = Math.max(10, window.innerWidth - dimensions.width - 10);
    }
    if (dimensions.height > 0 && position.y + dimensions.height > window.innerHeight) {
      pos.y = Math.max(10, window.innerHeight - dimensions.height - 10);
    }
    return pos;
  }, [position, dimensions]);

  const handleAction = (action: () => void) => {
    action();
    onClose();
  };

  const isDirectory = target?.isDirectory ?? false;
  const targetPath = target?.path ?? "";

  // Get parent directory path for "New File" / "New Folder" actions
  const parentPath = isDirectory ? targetPath : targetPath.split("/").slice(0, -1).join("/");

  if (!isOpen || !target) return null;

  return createPortal(
    <>
      {/* Backdrop — portaled to body so position: fixed isn't trapped by transformed ancestors */}
      <div
        className="fixed inset-0 z-[9998]"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={menuRef}
        className="fixed z-[9999] min-w-[200px] bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg shadow-xl overflow-hidden"
        style={{
          left: `${adjustedPosition.x}px`,
          top: `${adjustedPosition.y}px`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="py-1">
          {/* New File */}
          <button
            onClick={() => handleAction(() => onNewFile(isDirectory ? targetPath : parentPath))}
            className="w-full flex items-center gap-3 px-4 py-2 hover:bg-[var(--color-bg-tertiary)] text-left transition-colors"
          >
            <FileText className="w-4 h-4 text-[var(--color-text-muted)]" />
            <span className="text-sm text-[var(--color-text)]">New File</span>
          </button>

          {/* New Folder */}
          <button
            onClick={() => handleAction(() => onNewDirectory(isDirectory ? targetPath : parentPath))}
            className="w-full flex items-center gap-3 px-4 py-2 hover:bg-[var(--color-bg-tertiary)] text-left transition-colors"
          >
            <FolderPlus className="w-4 h-4 text-[var(--color-text-muted)]" />
            <span className="text-sm text-[var(--color-text)]">New Folder</span>
          </button>

          {/* Divider */}
          <div className="my-1 h-px bg-[var(--color-border)]" />

          {/* Copy Relative Path */}
          <button
            onClick={() => handleAction(() => onCopyRelativePath(targetPath))}
            className="w-full flex items-center gap-3 px-4 py-2 hover:bg-[var(--color-bg-tertiary)] text-left transition-colors"
          >
            <Copy className="w-4 h-4 text-[var(--color-text-muted)]" />
            <span className="text-sm text-[var(--color-text)]">Copy Relative Path</span>
          </button>

          {/* Copy Full Path */}
          <button
            onClick={() => handleAction(() => onCopyFullPath(targetPath))}
            disabled={!taskPath}
            className="w-full flex items-center gap-3 px-4 py-2 hover:bg-[var(--color-bg-tertiary)] text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <FileText className="w-4 h-4 text-[var(--color-text-muted)]" />
            <span className="text-sm text-[var(--color-text)]">Copy Full Path</span>
          </button>

          {/* Divider */}
          <div className="my-1 h-px bg-[var(--color-border)]" />

          {/* Delete */}
          <button
            onClick={() => handleAction(() => onDelete(targetPath))}
            className="w-full flex items-center gap-3 px-4 py-2 hover:bg-[var(--color-error)]/10 text-left transition-colors"
          >
            <Trash2 className="w-4 h-4 text-[var(--color-error)]" />
            <span className="text-sm text-[var(--color-error)]">Delete</span>
          </button>
        </div>
      </div>
    </>,
    document.body
  );
}
