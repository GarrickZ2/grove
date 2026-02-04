import { motion } from "framer-motion";
import { GitBranch, ArrowUpDown, FileEdit, AlertTriangle } from "lucide-react";
import type { RepoStatus as RepoStatusType } from "../../data/types";

interface RepoStatusProps {
  status: RepoStatusType;
}

export function RepoStatus({ status }: RepoStatusProps) {
  // Determine sync status color
  const getSyncColor = () => {
    if (status.hasConflicts) return "var(--color-error)";
    if (status.behind > 0 && status.ahead > 0) return "var(--color-warning)";
    if (status.behind > 0) return "var(--color-warning)";
    if (status.ahead > 0) return "var(--color-info)";
    return "var(--color-success)";
  };

  const getSyncLabel = () => {
    if (status.hasConflicts) return "Conflicts";
    if (status.ahead === 0 && status.behind === 0) return "In sync";
    return "Out of sync";
  };

  const totalChanges = status.staged + status.unstaged + status.untracked;

  const cards = [
    {
      icon: GitBranch,
      label: "Current",
      value: status.currentBranch,
      color: "var(--color-highlight)",
      bgColor: "var(--color-highlight)",
    },
    {
      icon: ArrowUpDown,
      label: getSyncLabel(),
      value: `↑${status.ahead} ↓${status.behind}`,
      color: getSyncColor(),
      bgColor: getSyncColor(),
    },
    {
      icon: status.hasConflicts ? AlertTriangle : FileEdit,
      label: "Uncommitted",
      value: totalChanges > 0
        ? `+${status.staged + status.unstaged} (${totalChanges} files)`
        : "Clean",
      color: totalChanges > 0 ? "var(--color-warning)" : "var(--color-success)",
      bgColor: totalChanges > 0 ? "var(--color-warning)" : "var(--color-success)",
    },
  ];

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4">
      <h2 className="text-sm font-medium text-[var(--color-text-muted)] mb-3">Repository Status</h2>
      <div className="grid grid-cols-3 gap-3">
        {cards.map((card, index) => (
          <motion.div
            key={card.label}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.1 }}
            className="p-3 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)]"
          >
            <div className="flex items-center gap-2 mb-2">
              <div
                className="w-7 h-7 rounded-lg flex items-center justify-center"
                style={{ backgroundColor: `color-mix(in srgb, ${card.bgColor} 15%, transparent)` }}
              >
                <card.icon className="w-4 h-4" style={{ color: card.color }} />
              </div>
            </div>
            <div
              className="text-lg font-semibold truncate"
              style={{ color: card.color }}
            >
              {card.value}
            </div>
            <div className="text-xs text-[var(--color-text-muted)]">{card.label}</div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
