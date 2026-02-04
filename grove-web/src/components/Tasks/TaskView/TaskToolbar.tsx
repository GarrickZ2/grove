import { motion } from "framer-motion";
import {
  GitCommit,
  Code,
  GitBranchPlus,
  RefreshCw,
  GitMerge,
  Archive,
  Trash2,
  RotateCcw,
} from "lucide-react";
import type { Task } from "../../../data/types";

interface TaskToolbarProps {
  task: Task;
  reviewOpen: boolean;
  onCommit: () => void;
  onToggleReview: () => void;
  onRebase: () => void;
  onSync: () => void;
  onMerge: () => void;
  onArchive: () => void;
  onClean: () => void;
  onReset: () => void;
}

interface ToolbarButtonProps {
  icon: typeof GitCommit;
  label: string;
  onClick: () => void;
  active?: boolean;
  variant?: "default" | "danger";
  disabled?: boolean;
}

function ToolbarButton({
  icon: Icon,
  label,
  onClick,
  active = false,
  variant = "default",
  disabled = false,
}: ToolbarButtonProps) {
  const baseClass = "flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors";

  const variantClass = variant === "danger"
    ? "text-[var(--color-error)] hover:bg-[var(--color-error)]/10"
    : active
      ? "bg-[var(--color-highlight)] text-white"
      : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]";

  return (
    <motion.button
      whileHover={{ scale: disabled ? 1 : 1.02 }}
      whileTap={{ scale: disabled ? 1 : 0.98 }}
      onClick={onClick}
      disabled={disabled}
      className={`${baseClass} ${variantClass} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      <Icon className="w-3.5 h-3.5" />
      <span>{label}</span>
    </motion.button>
  );
}

export function TaskToolbar({
  task,
  reviewOpen,
  onCommit,
  onToggleReview,
  onRebase,
  onSync,
  onMerge,
  onArchive,
  onClean,
  onReset,
}: TaskToolbarProps) {
  const isArchived = task.status === "archived";
  const isBroken = task.status === "broken";
  const canOperate = !isArchived && !isBroken;

  return (
    <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg)]">
      {/* Primary Actions */}
      <div className="flex items-center gap-1">
        <ToolbarButton
          icon={GitCommit}
          label="Commit"
          onClick={onCommit}
          disabled={isArchived}
        />
        <ToolbarButton
          icon={Code}
          label="Review"
          onClick={onToggleReview}
          active={reviewOpen}
          disabled={isArchived}
        />
        <ToolbarButton
          icon={GitBranchPlus}
          label="Rebase"
          onClick={onRebase}
          disabled={!canOperate}
        />
        <ToolbarButton
          icon={RefreshCw}
          label="Sync"
          onClick={onSync}
          disabled={!canOperate}
        />
        <ToolbarButton
          icon={GitMerge}
          label="Merge"
          onClick={onMerge}
          disabled={!canOperate}
        />
      </div>

      {/* Secondary Actions */}
      <div className="flex items-center gap-1">
        <ToolbarButton
          icon={Archive}
          label="Archive"
          onClick={onArchive}
          disabled={isBroken || isArchived}
        />
        <ToolbarButton
          icon={RotateCcw}
          label="Reset"
          onClick={onReset}
          disabled={isArchived}
        />
        <ToolbarButton
          icon={Trash2}
          label="Clean"
          onClick={onClean}
          variant="danger"
        />
      </div>
    </div>
  );
}
