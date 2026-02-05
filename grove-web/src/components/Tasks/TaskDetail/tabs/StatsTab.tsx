import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Calendar, GitCommit, FileCode, Clock, Activity, Loader2 } from "lucide-react";
import { getTaskStats, type TaskStatsResponse } from "../../../../api";
import type { Task } from "../../../../data/types";

interface StatsTabProps {
  projectId: string;
  task: Task;
}

function formatDate(date: Date | undefined, timeAgo?: string): string {
  // Prefer pre-formatted timeAgo if available
  if (timeAgo) return timeAgo;
  if (!date) return "";
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(start: Date, end: Date): string {
  // Handle invalid dates
  if (!start || !end || isNaN(start.getTime()) || isNaN(end.getTime())) {
    return "—";
  }

  const diff = end.getTime() - start.getTime();

  // Handle negative or zero diff
  if (diff <= 0) {
    return "< 1m";
  }

  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return "< 1m";
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

// Get heatmap color based on edit intensity (matches TUI color scheme)
function getHeatmapColor(count: number, maxCount: number): string {
  if (count === 0) return "rgba(128, 128, 128, 0.2)"; // muted
  const ratio = count / maxCount;
  if (ratio <= 0.25) return "rgb(80, 160, 180)";   // cool teal
  if (ratio <= 0.50) return "rgb(100, 200, 100)";  // medium green
  if (ratio <= 0.80) return "rgb(255, 180, 50)";   // warm orange
  return "rgb(255, 100, 100)";                      // hot red
}

// Get activity block color (matches TUI design)
function getActivityBlockColor(count: number): string {
  if (count === 0) return "var(--color-bg-tertiary)";    // muted/empty
  if (count === 1) return "rgb(100, 180, 100)";          // light green
  if (count <= 3) return "rgb(50, 205, 50)";             // lime green
  if (count <= 6) return "rgb(0, 230, 118)";             // bright green
  return "rgb(255, 200, 0)";                              // gold/yellow
}

// Format relative time
function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

// Truncate file path for display
function truncatePath(path: string, maxLen: number = 35): string {
  if (path.length <= maxLen) return path;
  const parts = path.split("/");
  if (parts.length <= 2) return "..." + path.slice(-maxLen + 3);
  // Show first dir + ... + filename
  const first = parts[0];
  const last = parts[parts.length - 1];
  const middle = "...";
  if (first.length + middle.length + last.length <= maxLen) {
    return `${first}/${middle}/${last}`;
  }
  return "..." + path.slice(-maxLen + 3);
}

export function StatsTab({ projectId, task }: StatsTabProps) {
  const [stats, setStats] = useState<TaskStatsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const totalLines = task.additions + task.deletions;

  // Load task stats from API
  useEffect(() => {
    setIsLoading(true);
    setError(null);
    getTaskStats(projectId, task.id)
      .then(setStats)
      .catch((err) => {
        console.error("Failed to load task stats:", err);
        setError("Failed to load stats");
      })
      .finally(() => setIsLoading(false));
  }, [projectId, task.id]);

  const maxEditCount = stats?.file_edits.length
    ? Math.max(...stats.file_edits.map((f) => f.edit_count))
    : 1;

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

      {/* File Edits Heatmap (from API) */}
      {isLoading ? (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4"
        >
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 text-[var(--color-text-muted)] animate-spin" />
          </div>
        </motion.div>
      ) : error ? (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4"
        >
          <p className="text-sm text-[var(--color-text-muted)] text-center py-4">{error}</p>
        </motion.div>
      ) : stats && stats.file_edits.length > 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4"
        >
          <div className="flex items-center gap-2 mb-3">
            <Activity className="w-4 h-4 text-[var(--color-text-muted)]" />
            <h3 className="text-sm font-medium text-[var(--color-text)]">File Edits</h3>
            <span className="text-xs text-[var(--color-text-muted)]">
              ({stats.total_edits} total, {stats.files_touched} files)
            </span>
          </div>

          {/* Last activity */}
          {stats.last_activity && (
            <div className="text-xs text-[var(--color-text-muted)] mb-3">
              Last activity: {formatRelativeTime(stats.last_activity)}
            </div>
          )}

          {/* File edits heatmap */}
          <div className="space-y-1.5">
            {stats.file_edits.map((file, index) => (
              <motion.div
                key={file.path}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.3 + index * 0.03 }}
                className="flex items-center gap-2"
              >
                {/* Filename on left */}
                <span
                  className="text-xs text-[var(--color-text-muted)] font-mono truncate w-48 flex-shrink-0"
                  title={file.path}
                >
                  {truncatePath(file.path, 28)}
                </span>
                {/* Edit count bar in middle */}
                <div className="flex-1 h-5 bg-[var(--color-bg-tertiary)] rounded-sm overflow-hidden">
                  <div
                    className="h-full rounded-sm transition-all"
                    style={{
                      width: `${(file.edit_count / maxEditCount) * 100}%`,
                      minWidth: "4px",
                      backgroundColor: getHeatmapColor(file.edit_count, maxEditCount),
                    }}
                  />
                </div>
                {/* Count on right */}
                <span className="text-xs text-[var(--color-text-muted)] tabular-nums w-6 text-right flex-shrink-0">
                  {file.edit_count}
                </span>
              </motion.div>
            ))}
          </div>

          {/* Color legend */}
          <div className="flex items-center gap-3 mt-4 pt-3 border-t border-[var(--color-border)]">
            <span className="text-xs text-[var(--color-text-muted)]">Intensity:</span>
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: "rgb(80, 160, 180)" }} />
              <span className="text-[10px] text-[var(--color-text-muted)]">Low</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: "rgb(100, 200, 100)" }} />
              <span className="text-[10px] text-[var(--color-text-muted)]">Med</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: "rgb(255, 180, 50)" }} />
              <span className="text-[10px] text-[var(--color-text-muted)]">High</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: "rgb(255, 100, 100)" }} />
              <span className="text-[10px] text-[var(--color-text-muted)]">Hot</span>
            </div>
          </div>
        </motion.div>
      ) : stats ? (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4"
        >
          <div className="flex items-center gap-2 mb-3">
            <Activity className="w-4 h-4 text-[var(--color-text-muted)]" />
            <h3 className="text-sm font-medium text-[var(--color-text)]">File Edits</h3>
          </div>
          <p className="text-sm text-[var(--color-text-muted)] text-center py-4">
            No file edit activity recorded
          </p>
        </motion.div>
      ) : null}

      {/* Activity Timeline - Minute-level heatmap (from API) */}
      {stats && stats.hourly_activity.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35 }}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4"
        >
          <div className="flex items-center gap-2 mb-3">
            <Clock className="w-4 h-4 text-[var(--color-text-muted)]" />
            <h3 className="text-sm font-medium text-[var(--color-text)]">Activity Timeline</h3>
            <span className="text-xs text-[var(--color-text-muted)]">
              (each block = 1 minute)
            </span>
          </div>
          <div className="space-y-1.5">
            {stats.hourly_activity.slice(0, 8).map((hourEntry) => {
              const hourDate = new Date(hourEntry.hour);
              const now = new Date();
              const isToday = hourDate.toDateString() === now.toDateString();
              const isYesterday = hourDate.toDateString() === new Date(now.getTime() - 86400000).toDateString();

              // Format time explicitly without locale issues
              const hourStr = hourDate.getHours().toString().padStart(2, "0");
              const dateLabel = isToday
                ? `${hourStr}:00`
                : isYesterday
                  ? `Yest ${hourStr}:00`
                  : `${(hourDate.getMonth() + 1)}/${hourDate.getDate()} ${hourStr}:00`;

              // Ensure buckets is an array of 60 values
              const buckets = Array.isArray(hourEntry.buckets) && hourEntry.buckets.length === 60
                ? hourEntry.buckets
                : Array(60).fill(0);

              return (
                <div key={hourEntry.hour} className="flex items-center gap-2">
                  <span
                    className="text-xs text-[var(--color-text-muted)] w-20 font-mono flex-shrink-0"
                    title={hourDate.toISOString()}
                  >
                    {dateLabel}
                  </span>
                  {/* 60 minute blocks */}
                  <div className="flex gap-[2px] flex-1">
                    {buckets.map((count, minute) => (
                      <div
                        key={minute}
                        style={{
                          width: "10px",
                          height: "20px",
                          borderRadius: "2px",
                          backgroundColor: getActivityBlockColor(count),
                        }}
                        title={`${hourStr}:${minute.toString().padStart(2, "0")} - ${count} edit${count !== 1 ? "s" : ""}`}
                      />
                    ))}
                  </div>
                  <span className="text-xs text-[var(--color-text-muted)] tabular-nums w-6 text-right flex-shrink-0">
                    {hourEntry.total}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Color legend */}
          <div className="flex items-center gap-3 mt-3 pt-3 border-t border-[var(--color-border)]">
            <span className="text-xs text-[var(--color-text-muted)]">Activity:</span>
            <div className="flex items-center gap-1">
              <div className="w-3 h-4 rounded-sm bg-[var(--color-bg-tertiary)]" />
              <span className="text-[10px] text-[var(--color-text-muted)]">0</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-4 rounded-sm" style={{ backgroundColor: "rgb(100, 180, 100)" }} />
              <span className="text-[10px] text-[var(--color-text-muted)]">1</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-4 rounded-sm" style={{ backgroundColor: "rgb(50, 205, 50)" }} />
              <span className="text-[10px] text-[var(--color-text-muted)]">2-3</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-4 rounded-sm" style={{ backgroundColor: "rgb(0, 230, 118)" }} />
              <span className="text-[10px] text-[var(--color-text-muted)]">4-6</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-4 rounded-sm" style={{ backgroundColor: "rgb(255, 200, 0)" }} />
              <span className="text-[10px] text-[var(--color-text-muted)]">7+</span>
            </div>
          </div>
        </motion.div>
      )}

      {/* Commit Timeline */}
      {task.commits.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
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
                      <span>{formatDate(commit.date, commit.timeAgo)}</span>
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
