import { motion } from "framer-motion";
import {
  GitBranch,
  ArrowDown,
  ArrowUp,
  GitCommit,
  Archive,
  RefreshCw,
  ChevronRight,
  FileEdit,
  ArrowUpDown,
} from "lucide-react";
import type { RepoStatus } from "../../data/types";

interface GitStatusBarProps {
  status: RepoStatus;
  onSwitchBranch: () => void;
  onPull: () => void;
  onPush: () => void;
  onCommit: () => void;
  onStash: () => void;
  onFetch: () => void;
}

export function GitStatusBar({
  status,
  onSwitchBranch,
  onPull,
  onPush,
  onCommit,
  onStash,
  onFetch,
}: GitStatusBarProps) {
  const hasChanges = status.staged + status.unstaged + status.untracked > 0;
  const hasStagedChanges = status.staged > 0 || status.unstaged > 0;
  const totalChanges = status.staged + status.unstaged + status.untracked;

  // Determine sync status
  const getSyncColor = () => {
    if (status.hasConflicts) return "var(--color-error)";
    if (status.behind > 0) return "var(--color-warning)";
    if (status.ahead > 0) return "var(--color-info)";
    return "var(--color-success)";
  };

  const getSyncLabel = () => {
    if (status.hasConflicts) return "Conflicts";
    if (status.ahead === 0 && status.behind === 0) return "In sync";
    return "Sync";
  };

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4">
      <div className="flex items-center justify-between gap-4">
        {/* Left: Status Cards */}
        <div className="flex items-center gap-3">
          {/* Branch Card */}
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={onSwitchBranch}
            className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] hover:border-[var(--color-highlight)] transition-colors group"
          >
            <div className="w-8 h-8 rounded-lg bg-[var(--color-highlight)]/15 flex items-center justify-center">
              <GitBranch className="w-4 h-4 text-[var(--color-highlight)]" />
            </div>
            <div className="text-left">
              <div className="text-sm font-semibold text-[var(--color-highlight)]">
                {status.currentBranch}
              </div>
              <div className="text-xs text-[var(--color-text-muted)]">Current</div>
            </div>
            <ChevronRight className="w-4 h-4 text-[var(--color-text-muted)] group-hover:text-[var(--color-highlight)] transition-colors" />
          </motion.button>

          {/* Sync Status Card */}
          <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)]">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ backgroundColor: `color-mix(in srgb, ${getSyncColor()} 15%, transparent)` }}
            >
              <ArrowUpDown className="w-4 h-4" style={{ color: getSyncColor() }} />
            </div>
            <div>
              <div className="text-sm font-semibold flex items-center gap-1.5" style={{ color: getSyncColor() }}>
                <span>↑{status.ahead}</span>
                <span>↓{status.behind}</span>
              </div>
              <div className="text-xs text-[var(--color-text-muted)]">{getSyncLabel()}</div>
            </div>
          </div>

          {/* Changes Card */}
          <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)]">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ backgroundColor: hasChanges ? "color-mix(in srgb, var(--color-warning) 15%, transparent)" : "color-mix(in srgb, var(--color-success) 15%, transparent)" }}
            >
              <FileEdit className="w-4 h-4" style={{ color: hasChanges ? "var(--color-warning)" : "var(--color-success)" }} />
            </div>
            <div>
              <div className="text-sm font-semibold" style={{ color: hasChanges ? "var(--color-warning)" : "var(--color-success)" }}>
                {hasChanges ? `+${status.staged + status.unstaged} (${totalChanges})` : "Clean"}
              </div>
              <div className="text-xs text-[var(--color-text-muted)]">
                {hasChanges ? "Uncommitted" : "Working tree"}
              </div>
            </div>
          </div>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-1.5">
          <ActionButton
            icon={ArrowDown}
            label="Pull"
            onClick={onPull}
          />
          <ActionButton
            icon={ArrowUp}
            label="Push"
            onClick={onPush}
            disabled={status.ahead === 0}
            highlight={status.ahead > 0}
          />
          <ActionButton
            icon={GitCommit}
            label="Commit"
            onClick={onCommit}
            disabled={!hasStagedChanges}
            highlight={hasStagedChanges}
          />
          <ActionButton
            icon={Archive}
            label="Stash"
            onClick={onStash}
            disabled={!hasChanges}
          />
          <ActionButton
            icon={RefreshCw}
            label="Fetch"
            onClick={onFetch}
          />
        </div>
      </div>
    </div>
  );
}

interface ActionButtonProps {
  icon: React.ElementType;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  highlight?: boolean;
}

function ActionButton({ icon: Icon, label, onClick, disabled = false, highlight = false }: ActionButtonProps) {
  return (
    <motion.button
      whileHover={{ scale: disabled ? 1 : 1.05 }}
      whileTap={{ scale: disabled ? 1 : 0.95 }}
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors
        ${disabled
          ? "text-[var(--color-text-muted)] opacity-40 cursor-not-allowed"
          : highlight
            ? "bg-[var(--color-highlight)] text-white hover:opacity-90"
            : "bg-[var(--color-bg)] hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text)] border border-[var(--color-border)]"
        }`}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </motion.button>
  );
}
