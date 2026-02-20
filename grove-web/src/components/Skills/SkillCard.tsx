import { motion } from "framer-motion";
import { CheckCircle2, ArrowUpCircle, Circle } from "lucide-react";
import type { SkillSummary } from "../../api";

interface SkillCardProps {
  skill: SkillSummary;
  hasUpdate?: boolean;
  isSelected: boolean;
  onClick: () => void;
}

export function SkillCard({ skill, hasUpdate, isSelected, onClick }: SkillCardProps) {
  const statusConfig = {
    installed: {
      icon: CheckCircle2,
      color: "text-[var(--color-success)]",
      label: `Installed ${skill.installed_agent_count}/${skill.total_agents}`,
    },
    partial: {
      icon: ArrowUpCircle,
      color: "text-[var(--color-warning)]",
      label: `Installed ${skill.installed_agent_count}/${skill.total_agents}`,
    },
    not_installed: {
      icon: Circle,
      color: "text-[var(--color-text-muted)]",
      label: "Not installed",
    },
  };

  const status = statusConfig[skill.install_status];
  const StatusIcon = status.icon;

  return (
    <motion.button
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      className={`w-full text-left p-4 rounded-lg border transition-colors ${
        isSelected
          ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/5"
          : "border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:border-[var(--color-text-muted)]/30"
      }`}
    >
      {/* Name + Source badge */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <h3 className="text-sm font-semibold text-[var(--color-text)] truncate">
          {skill.name}
        </h3>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {hasUpdate && (
            <span className="px-1.5 py-0.5 text-[9px] font-semibold rounded-md bg-[var(--color-warning)]/10 text-[var(--color-warning)]">
              Update
            </span>
          )}
          <span className="px-1.5 py-0.5 text-[10px] font-medium rounded-md bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]">
            {skill.source}
          </span>
        </div>
      </div>

      {/* Description */}
      <p className="text-xs text-[var(--color-text-muted)] line-clamp-2 mb-3 leading-relaxed">
        {skill.description}
      </p>

      {/* Status */}
      <div className="flex items-center justify-between">
        <div className={`flex items-center gap-1.5 text-xs ${status.color}`}>
          <StatusIcon className="w-3.5 h-3.5" />
          <span>{status.label}</span>
        </div>
        {skill.author && (
          <span className="text-[10px] text-[var(--color-text-muted)]">
            by {skill.author}
          </span>
        )}
      </div>
    </motion.button>
  );
}
