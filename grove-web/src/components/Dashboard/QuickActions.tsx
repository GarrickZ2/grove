import { motion } from "framer-motion";
import {
  ArrowDown,
  ArrowUp,
  GitCommit,
  Archive,
  RefreshCw,
  Code,
  Terminal,
  Plus,
} from "lucide-react";
import type { RepoStatus } from "../../data/types";

interface QuickActionsProps {
  status: RepoStatus;
  onPull: () => void;
  onPush: () => void;
  onCommit: () => void;
  onStash: () => void;
  onFetch: () => void;
  onOpenIDE: () => void;
  onOpenTerminal: () => void;
  onNewTask: () => void;
}

interface ActionButton {
  icon: React.ElementType;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "ghost";
}

export function QuickActions({
  status,
  onPull,
  onPush,
  onCommit,
  onStash,
  onFetch,
  onOpenIDE,
  onOpenTerminal,
  onNewTask,
}: QuickActionsProps) {
  const hasChanges = status.staged + status.unstaged + status.untracked > 0;
  const hasStagedChanges = status.staged > 0 || status.unstaged > 0;

  const gitActions: ActionButton[] = [
    { icon: ArrowDown, label: "Pull", onClick: onPull, disabled: false },
    { icon: ArrowUp, label: "Push", onClick: onPush, disabled: status.ahead === 0 },
    { icon: GitCommit, label: "Commit", onClick: onCommit, disabled: !hasStagedChanges },
    { icon: Archive, label: "Stash", onClick: onStash, disabled: !hasChanges },
    { icon: RefreshCw, label: "Fetch", onClick: onFetch },
  ];

  const toolActions: ActionButton[] = [
    { icon: Code, label: "IDE", onClick: onOpenIDE },
    { icon: Terminal, label: "Terminal", onClick: onOpenTerminal },
    { icon: Plus, label: "New Task", onClick: onNewTask, variant: "primary" },
  ];

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4">
      <h2 className="text-sm font-medium text-[var(--color-text-muted)] mb-3">Quick Actions</h2>
      <div className="flex flex-wrap items-center gap-2">
        {/* Git Actions */}
        {gitActions.map((action, index) => (
          <motion.button
            key={action.label}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: index * 0.05 }}
            whileHover={{ scale: action.disabled ? 1 : 1.02 }}
            whileTap={{ scale: action.disabled ? 1 : 0.98 }}
            onClick={action.onClick}
            disabled={action.disabled}
            className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors
              ${action.disabled
                ? "bg-[var(--color-bg)] text-[var(--color-text-muted)] opacity-50 cursor-not-allowed"
                : "bg-[var(--color-bg)] hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text)] border border-[var(--color-border)]"
              }`}
          >
            <action.icon className="w-4 h-4" />
            {action.label}
          </motion.button>
        ))}

        {/* Divider */}
        <div className="w-px h-8 bg-[var(--color-border)] mx-2" />

        {/* Tool Actions */}
        {toolActions.map((action, index) => (
          <motion.button
            key={action.label}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: (gitActions.length + index) * 0.05 }}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={action.onClick}
            className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors
              ${action.variant === "primary"
                ? "bg-[var(--color-highlight)] hover:opacity-90 text-white"
                : "bg-[var(--color-bg)] hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text)] border border-[var(--color-border)]"
              }`}
          >
            <action.icon className="w-4 h-4" />
            {action.label}
          </motion.button>
        ))}
      </div>
    </div>
  );
}
