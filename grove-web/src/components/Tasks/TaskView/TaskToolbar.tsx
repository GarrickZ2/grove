import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  GitCommit,
  Code,
  FileCode,
  GitBranchPlus,
  RefreshCw,
  GitMerge,
  Archive,
  Trash2,
  RotateCcw,
  MoreHorizontal,
  ChevronDown,
  ChevronUp,
  Terminal,
  MessageSquare,
  ChevronLeft,
} from "lucide-react";
import type { Task } from "../../../data/types";
import { useConfig } from "../../../context";

interface TaskToolbarProps {
  task: Task;
  headerCollapsed?: boolean;
  onToggleHeaderCollapse?: () => void;
  onAddTerminal: () => void;
  onAddChat: () => void;
  onAddReview: () => void;
  onAddEditor: () => void;
  onCommit: () => void;
  onRebase: () => void;
  onSync: () => void;
  onMerge: () => void;
  onArchive: () => void;
  onClean: () => void;
  onReset: () => void;
  /** Mobile close callback */
  onClose?: () => void;
}

interface ToolbarButtonProps {
  icon: typeof GitCommit;
  label: string;
  onClick: () => void;
  active?: boolean;
  variant?: "default" | "warning" | "danger";
  disabled?: boolean;
  shortcut?: string;
  title?: string;
}

function ToolbarButton({
  icon: Icon,
  label,
  onClick,
  active = false,
  variant = "default",
  disabled = false,
  shortcut,
  title,
}: ToolbarButtonProps) {
  const baseClass = "flex items-center gap-1 md:gap-1.5 px-2 md:px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors";

  const getVariantClass = () => {
    if (active) {
      return "bg-[var(--color-highlight)] text-white";
    }
    switch (variant) {
      case "danger":
        return "text-[var(--color-error)] hover:bg-[var(--color-error)]/10";
      case "warning":
        return "text-[var(--color-warning)] hover:bg-[var(--color-warning)]/10";
      default:
        return "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]";
    }
  };

  return (
    <motion.button
      whileHover={{ scale: disabled ? 1 : 1.02 }}
      whileTap={{ scale: disabled ? 1 : 0.98 }}
      onClick={onClick}
      disabled={disabled}
      title={title || label}
      className={`${baseClass} ${getVariantClass()} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      <Icon className="w-3.5 h-3.5" />
      <span className="hidden md:inline">{label}</span>
      {shortcut && (
        <span className="hidden md:inline ml-0.5 px-1 py-0 text-[10px] font-mono rounded border bg-[var(--color-bg)] border-[var(--color-border)] text-[var(--color-text-muted)] opacity-60 leading-tight">
          {shortcut}
        </span>
      )}
    </motion.button>
  );
}

// Inline dropdown menu for dangerous actions
interface DropdownItem {
  id: string;
  label: string;
  icon: typeof GitCommit;
  onClick: () => void;
  variant?: "default" | "warning" | "danger";
  disabled?: boolean;
}

function ActionsDropdown({ items }: { items: DropdownItem[] }) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const getVariantClass = (variant: DropdownItem["variant"]) => {
    switch (variant) {
      case "warning":
        return "text-[var(--color-warning)] hover:bg-[var(--color-warning)]/10";
      case "danger":
        return "text-[var(--color-error)] hover:bg-[var(--color-error)]/10";
      default:
        return "text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]";
    }
  };

  return (
    <div ref={menuRef} className="relative">
      <motion.button
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
      >
        <MoreHorizontal className="w-3.5 h-3.5" />
      </motion.button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 z-50 mt-1 min-w-[120px] py-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg"
          >
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  onClick={() => {
                    if (!item.disabled) {
                      item.onClick();
                      setIsOpen(false);
                    }
                  }}
                  disabled={item.disabled}
                  className={`
                    w-full flex items-center gap-2 px-3 py-1.5 text-xs font-medium transition-colors
                    ${getVariantClass(item.variant)}
                    ${item.disabled ? "opacity-50 cursor-not-allowed" : ""}
                  `}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function TaskToolbar({
  task,
  headerCollapsed,
  onToggleHeaderCollapse,
  onAddTerminal,
  onAddChat,
  onAddReview,
  onAddEditor,
  onCommit,
  onRebase,
  onSync,
  onMerge,
  onArchive,
  onClean,
  onReset,
  onClose,
}: TaskToolbarProps) {
  const { config, terminalAvailable, chatAvailable } = useConfig();
  const isArchived = task.status === "archived";
  const isBroken = task.status === "broken";
  const canOperate = !isArchived && !isBroken;

  // Dangerous actions for dropdown
  const dangerousActions: DropdownItem[] = [
    {
      id: "archive",
      label: "Archive",
      icon: Archive,
      onClick: onArchive,
      variant: "warning",
      disabled: isBroken || isArchived,
    },
    {
      id: "reset",
      label: "Reset",
      icon: RotateCcw,
      onClick: onReset,
      variant: "warning",
      disabled: isArchived,
    },
    {
      id: "clean",
      label: "Clean",
      icon: Trash2,
      onClick: onClean,
      variant: "danger",
    },
  ];

  return (
    <div className="flex items-center justify-between px-2 md:px-4 py-2 border-b border-[var(--color-border)]">
      {/* Mobile back button */}
      {onClose && (
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={onClose}
          className="flex items-center gap-1 mr-2 px-2 py-1.5 text-xs font-medium rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors md:hidden"
        >
          <ChevronLeft className="w-4 h-4" />
          <span>Back</span>
        </motion.button>
      )}

      {/* Primary Actions */}
      <div className="flex items-center gap-0.5 md:gap-1 min-w-0 overflow-x-auto">
        {/* Chat Button - 放在 Terminal 前面 */}
        {config?.enable_chat && (
          <ToolbarButton
            icon={MessageSquare}
            label="Chat"
            onClick={onAddChat}
            disabled={isArchived || !chatAvailable}
            title={!chatAvailable ? "No ACP agent available" : undefined}
            shortcut="c"
          />
        )}
        {/* Terminal Button */}
        {config?.enable_terminal && (
          <ToolbarButton
            icon={Terminal}
            label="Terminal"
            onClick={onAddTerminal}
            disabled={isArchived || !terminalAvailable}
            title={!terminalAvailable ? "Requires tmux or zellij" : undefined}
            shortcut="t"
          />
        )}
        {(config?.enable_terminal || config?.enable_chat) && (
          <div className="w-px h-6 bg-[var(--color-border)] mx-1 md:mx-1.5 hidden md:block" />
        )}
        <ToolbarButton
          icon={Code}
          label="Review"
          onClick={onAddReview}
          disabled={isArchived}
          shortcut="r"
        />
        <ToolbarButton
          icon={FileCode}
          label="Editor"
          onClick={onAddEditor}
          disabled={isArchived}
          shortcut="e"
        />
        {/* Vertical separator */}
        <div className="w-px h-6 bg-[var(--color-border)] mx-1 md:mx-1.5 hidden md:block" />
        <ToolbarButton
          icon={GitCommit}
          label="Commit"
          onClick={onCommit}
          disabled={isArchived}
          shortcut="c"
        />
        <ToolbarButton
          icon={GitBranchPlus}
          label="Rebase"
          onClick={onRebase}
          disabled={!canOperate}
          shortcut="b"
        />
        <ToolbarButton
          icon={RefreshCw}
          label="Sync"
          onClick={onSync}
          disabled={!canOperate}
          shortcut="s"
        />
        <ToolbarButton
          icon={GitMerge}
          label="Merge"
          onClick={onMerge}
          disabled={!canOperate}
          shortcut="m"
        />
      </div>

      <div className="flex items-center gap-1">
        {/* Header collapse/expand toggle */}
        {onToggleHeaderCollapse && (
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={onToggleHeaderCollapse}
            className="flex items-center justify-center w-7 h-7 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
            title={headerCollapsed ? "Expand header" : "Collapse header"}
          >
            {headerCollapsed ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronUp className="w-3.5 h-3.5" />
            )}
          </motion.button>
        )}
        {/* Dangerous Actions in Dropdown */}
        <ActionsDropdown items={dangerousActions} />
      </div>
    </div>
  );
}
