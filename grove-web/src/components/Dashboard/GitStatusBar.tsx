import { motion } from "framer-motion";
import {
  GitBranch,
  ArrowDown,
  ArrowUp,
  GitCommit,
  RefreshCw,
  ChevronRight,
  FileEdit,
  ArrowUpDown,
} from "lucide-react";
import { Tooltip } from "../ui";
import { useIsMobile } from "../../hooks";
import type { RepoStatus } from "../../data/types";

interface GitStatusBarProps {
  status: RepoStatus;
  isOperating?: boolean;
  onSwitchBranch: () => void;
  onPull: () => void;
  onPush: () => void;
  onCommit: () => void;
  onFetch: () => void;
}

export function GitStatusBar({
  status,
  isOperating = false,
  onSwitchBranch,
  onPull,
  onPush,
  onCommit,
  onFetch,
}: GitStatusBarProps) {
  const hasChanges = status.staged + status.unstaged + status.untracked > 0;
  const hasStagedChanges = status.staged > 0 || status.unstaged > 0;
  const { isMobile } = useIsMobile();

  // Determine sync status
  const getSyncColor = () => {
    if (!status.hasOrigin) return "var(--color-text-muted)";
    if (status.hasConflicts) return "var(--color-error)";
    if (status.behind > 0) return "var(--color-warning)";
    if (status.ahead > 0) return "var(--color-info)";
    return "var(--color-success)";
  };

  const getSyncLabel = () => {
    if (!status.hasOrigin) return "No remote";
    if (status.hasConflicts) return "Conflicts";
    if (status.ahead === 0 && status.behind === 0) return "In sync";
    return "Sync";
  };

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4">
      <div className={`flex gap-4 ${isMobile ? "flex-col" : "items-center justify-between"}`}>
        {/* Status Cards */}
        <div className={`flex gap-3 ${isMobile ? "flex-col" : "items-center"}`}>
          {/* Branch Card */}
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={onSwitchBranch}
            className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] hover:border-[var(--color-highlight)] transition-colors group min-w-0"
          >
            <div className="w-8 h-8 rounded-lg bg-[var(--color-highlight)]/15 flex items-center justify-center flex-shrink-0">
              <GitBranch className="w-4 h-4 text-[var(--color-highlight)]" />
            </div>
            <div className="text-left min-w-0">
              <div className="text-sm font-semibold text-[var(--color-highlight)] truncate">
                {status.currentBranch}
              </div>
              <div className="text-xs text-[var(--color-text-muted)]">Current</div>
            </div>
            <ChevronRight className="w-4 h-4 text-[var(--color-text-muted)] group-hover:text-[var(--color-highlight)] transition-colors flex-shrink-0" />
          </motion.button>

          {/* Sync + Uncommitted row */}
          {isMobile ? (
            <div className="flex items-center gap-3">
              {/* Sync Status Card */}
              <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] flex-1">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
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
              {/* Uncommitted Changes Card */}
              {hasChanges && (
                <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] flex-1">
                  <div
                    className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{ backgroundColor: "color-mix(in srgb, var(--color-warning) 15%, transparent)" }}
                  >
                    <FileEdit className="w-4 h-4" style={{ color: "var(--color-warning)" }} />
                  </div>
                  <div>
                    <div className="text-sm font-semibold" style={{ color: "var(--color-warning)" }}>
                      {status.unstaged} files
                    </div>
                    <div className="text-xs text-[var(--color-text-muted)]">Uncommitted</div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              {/* Sync Status Card */}
              <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)]">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
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
              {/* Uncommitted Changes Card */}
              {hasChanges && (
                <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)]">
                  <div
                    className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{ backgroundColor: "color-mix(in srgb, var(--color-warning) 15%, transparent)" }}
                  >
                    <FileEdit className="w-4 h-4" style={{ color: "var(--color-warning)" }} />
                  </div>
                  <div>
                    <div className="text-sm font-semibold" style={{ color: "var(--color-warning)" }}>
                      {status.unstaged} files
                    </div>
                    <div className="text-xs text-[var(--color-text-muted)]">Uncommitted</div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Actions */}
        <div className={`flex items-center gap-1.5 ${isMobile ? "flex-wrap" : ""}`}>
          <ActionButton
            icon={ArrowDown}
            label="Pull"
            onClick={onPull}
            disabled={!status.hasOrigin || isOperating}
            disabledReason={!status.hasOrigin ? "No remote origin configured" : undefined}
            loading={isOperating}
          />
          <ActionButton
            icon={ArrowUp}
            label="Push"
            onClick={onPush}
            disabled={!status.hasOrigin || status.ahead === 0 || isOperating}
            disabledReason={
              !status.hasOrigin
                ? "No remote origin configured"
                : status.ahead === 0
                  ? "No commits to push"
                  : undefined
            }
            highlight={status.hasOrigin && status.ahead > 0 && !isOperating}
            loading={isOperating}
          />
          <ActionButton
            icon={GitCommit}
            label="Commit"
            onClick={onCommit}
            disabled={!hasStagedChanges || isOperating}
            disabledReason={!hasStagedChanges ? "No changes to commit" : undefined}
            highlight={hasStagedChanges && !isOperating}
            loading={isOperating}
          />
          <ActionButton
            icon={RefreshCw}
            label="Fetch"
            onClick={onFetch}
            disabled={!status.hasOrigin || isOperating}
            disabledReason={!status.hasOrigin ? "No remote origin configured" : undefined}
            loading={isOperating}
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
  disabledReason?: string;
  highlight?: boolean;
  loading?: boolean;
}

function ActionButton({ icon: Icon, label, onClick, disabled = false, disabledReason, highlight = false, loading = false }: ActionButtonProps) {
  const isDisabledByLoading = disabled && loading && !disabledReason;
  const button = (
    <motion.button
      whileHover={{ scale: disabled ? 1 : 1.05 }}
      whileTap={{ scale: disabled ? 1 : 0.95 }}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors
        ${disabled
          ? isDisabledByLoading
            ? "text-[var(--color-text-muted)] opacity-60 cursor-wait"
            : "text-[var(--color-text-muted)] opacity-40 cursor-not-allowed"
          : highlight
            ? "bg-[var(--color-highlight)] text-white hover:opacity-90"
            : "bg-[var(--color-bg)] hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text)] border border-[var(--color-border)]"
        }`}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </motion.button>
  );

  // Wrap with tooltip if disabled and has reason
  if (disabled && disabledReason) {
    return (
      <Tooltip content={disabledReason} position="bottom">
        {button}
      </Tooltip>
    );
  }

  return button;
}
