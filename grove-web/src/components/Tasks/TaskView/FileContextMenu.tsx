import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
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
  onClose: () => void;
  onNewFile: (parentPath?: string) => void;
  onNewDirectory: (parentPath?: string) => void;
  onDelete: (path: string) => void;
  onCopyPath: (path: string) => void;
}

export function FileContextMenu({
  isOpen,
  position,
  target,
  onClose,
  onNewFile,
  onNewDirectory,
  onDelete,
  onCopyPath,
}: FileContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [adjustedPosition, setAdjustedPosition] = useState(position);

  // Adjust position to prevent overflow
  useEffect(() => {
    if (!isOpen || !menuRef.current) return;

    const menu = menuRef.current;
    const rect = menu.getBoundingClientRect();
    const newPos = { ...position };

    // Adjust horizontal position
    if (position.x + rect.width > window.innerWidth) {
      newPos.x = Math.max(10, window.innerWidth - rect.width - 10);
    }

    // Adjust vertical position
    if (position.y + rect.height > window.innerHeight) {
      newPos.y = Math.max(10, window.innerHeight - rect.height - 10);
    }

    setAdjustedPosition(newPos);
  }, [isOpen, position]);

  // Close menu on escape or click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    document.addEventListener("keydown", handleEscape);
    document.addEventListener("mousedown", handleClickOutside);

    return () => {
      document.removeEventListener("keydown", handleEscape);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen, onClose]);

  const handleAction = (action: () => void) => {
    action();
    onClose();
  };

  const isDirectory = target?.isDirectory ?? false;
  const targetPath = target?.path ?? "";

  // Get parent directory path for "New File" / "New Folder" actions
  const parentPath = isDirectory ? targetPath : targetPath.split("/").slice(0, -1).join("/");

  return (
    <AnimatePresence>
      {isOpen && target && (
        <motion.div
          ref={menuRef}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.15 }}
          className="fixed z-[100] min-w-[200px] bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg shadow-xl overflow-hidden"
          style={{
            left: `${adjustedPosition.x}px`,
            top: `${adjustedPosition.y}px`,
          }}
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

            {/* Copy Path */}
            <button
              onClick={() => handleAction(() => onCopyPath(targetPath))}
              className="w-full flex items-center gap-3 px-4 py-2 hover:bg-[var(--color-bg-tertiary)] text-left transition-colors"
            >
              <Copy className="w-4 h-4 text-[var(--color-text-muted)]" />
              <span className="text-sm text-[var(--color-text)]">Copy Path</span>
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
        </motion.div>
      )}
    </AnimatePresence>
  );
}
