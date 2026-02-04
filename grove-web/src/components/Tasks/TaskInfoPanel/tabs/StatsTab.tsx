import { motion } from "framer-motion";
import { Calendar, GitCommit, FileCode, Clock } from "lucide-react";
import type { Task } from "../../../../data/types";

interface StatsTabProps {
  task: Task;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(start: Date, end: Date): string {
  const diff = end.getTime() - start.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  return `${hours}h`;
}

interface StatCardProps {
  icon: typeof Calendar;
  label: string;
  value: string | number;
  subValue?: string;
  delay?: number;
}

function StatCard({ icon: Icon, label, value, subValue, delay = 0 }: StatCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay }}
      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4"
    >
      <div className="flex items-center gap-2 text-[var(--color-text-muted)] mb-2">
        <Icon className="w-4 h-4" />
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <div className="text-xl font-semibold text-[var(--color-text)]">{value}</div>
      {subValue && (
        <div className="text-xs text-[var(--color-text-muted)] mt-1">{subValue}</div>
      )}
    </motion.div>
  );
}

export function StatsTab({ task }: StatsTabProps) {
  const totalLines = task.additions + task.deletions;

  return (
    <div className="space-y-4">
      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard
          icon={Calendar}
          label="Created"
          value={formatDate(task.createdAt)}
          delay={0}
        />
        <StatCard
          icon={Clock}
          label="Last Updated"
          value={formatDate(task.updatedAt)}
          delay={0.05}
        />
        <StatCard
          icon={GitCommit}
          label="Commits"
          value={task.commits.length}
          subValue={task.commits.length > 0 ? `Latest: ${task.commits[0]?.message.slice(0, 30)}...` : "No commits"}
          delay={0.1}
        />
        <StatCard
          icon={FileCode}
          label="Files Changed"
          value={task.filesChanged}
          subValue={`${task.additions} additions, ${task.deletions} deletions`}
          delay={0.15}
        />
      </div>

      {/* Duration */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4"
      >
        <h3 className="text-sm font-medium text-[var(--color-text)] mb-3">Task Duration</h3>
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <div className="text-2xl font-semibold text-[var(--color-text)]">
              {formatDuration(task.createdAt, task.updatedAt)}
            </div>
            <div className="text-xs text-[var(--color-text-muted)] mt-1">
              Active time
            </div>
          </div>
          <div className="h-12 w-px bg-[var(--color-border)]" />
          <div className="flex-1">
            <div className="text-2xl font-semibold text-[var(--color-text)]">
              {totalLines}
            </div>
            <div className="text-xs text-[var(--color-text-muted)] mt-1">
              Total lines changed
            </div>
          </div>
        </div>
      </motion.div>

      {/* Activity Timeline */}
      {task.commits.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4"
        >
          <h3 className="text-sm font-medium text-[var(--color-text)] mb-3">Commit Timeline</h3>
          <div className="relative">
            {/* Timeline line */}
            <div className="absolute left-[7px] top-2 bottom-2 w-0.5 bg-[var(--color-border)]" />

            {/* Commits */}
            <div className="space-y-3">
              {task.commits.map((commit, index) => (
                <div key={commit.hash} className="flex items-start gap-3 relative">
                  <div
                    className="w-4 h-4 rounded-full border-2 border-[var(--color-highlight)] bg-[var(--color-bg)] flex-shrink-0 z-10"
                    style={{
                      borderColor: index === 0 ? "var(--color-highlight)" : "var(--color-border)",
                    }}
                  />
                  <div className="flex-1 min-w-0 pb-2">
                    <p className="text-sm text-[var(--color-text)] truncate">
                      {commit.message}
                    </p>
                    <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)] mt-0.5">
                      <code className="font-mono">{commit.hash.slice(0, 7)}</code>
                      <span>•</span>
                      <span>{formatDate(commit.date)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      )}
    </div>
  );
}
