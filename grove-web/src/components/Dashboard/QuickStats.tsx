import { motion } from "framer-motion";
import { Circle, CheckCircle, Archive, PauseCircle } from "lucide-react";
import type { Stats } from "../../data/types";

interface QuickStatsProps {
  stats: Stats;
}

export function QuickStats({ stats }: QuickStatsProps) {
  const statItems = [
    {
      label: "Live",
      value: stats.liveTasks,
      icon: Circle,
      color: "var(--color-success)",
      bgColor: "var(--color-success)",
    },
    {
      label: "Idle",
      value: stats.idleTasks,
      icon: PauseCircle,
      color: "var(--color-text-muted)",
      bgColor: "var(--color-text-muted)",
    },
    {
      label: "Merged",
      value: stats.mergedTasks,
      icon: CheckCircle,
      color: "#a855f7",
      bgColor: "#a855f7",
    },
    {
      label: "Archived",
      value: stats.archivedTasks,
      icon: Archive,
      color: "var(--color-text-muted)",
      bgColor: "var(--color-text-muted)",
    },
  ];

  const total = stats.liveTasks + stats.idleTasks + stats.mergedTasks + stats.archivedTasks;

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--color-border)]">
        <h2 className="text-sm font-medium text-[var(--color-text)]">
          Task Overview
        </h2>
      </div>
      <div className="p-4">
        {/* Progress bar */}
        <div className="h-2 rounded-full bg-[var(--color-bg-tertiary)] overflow-hidden flex mb-4">
          {stats.liveTasks > 0 && (
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${(stats.liveTasks / total) * 100}%` }}
              className="h-full bg-[var(--color-success)]"
            />
          )}
          {stats.idleTasks > 0 && (
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${(stats.idleTasks / total) * 100}%` }}
              className="h-full bg-[var(--color-text-muted)]"
            />
          )}
          {stats.mergedTasks > 0 && (
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${(stats.mergedTasks / total) * 100}%` }}
              className="h-full bg-purple-500"
            />
          )}
          {stats.archivedTasks > 0 && (
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${(stats.archivedTasks / total) * 100}%` }}
              className="h-full bg-[var(--color-border)]"
            />
          )}
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-2 gap-3">
          {statItems.map((item, index) => {
            const Icon = item.icon;
            return (
              <motion.div
                key={item.label}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.05 }}
                className="flex items-center gap-3 p-3 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)]"
              >
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center"
                  style={{ backgroundColor: `${item.bgColor}15` }}
                >
                  <Icon className="w-4 h-4" style={{ color: item.color }} />
                </div>
                <div>
                  <div className="text-lg font-semibold text-[var(--color-text)]">
                    {item.value}
                  </div>
                  <div className="text-xs text-[var(--color-text-muted)]">
                    {item.label}
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
