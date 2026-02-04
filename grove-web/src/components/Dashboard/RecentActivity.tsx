import { motion } from "framer-motion";
import { GitMerge, Plus, RefreshCw, Archive, RotateCcw } from "lucide-react";
import type { ActivityItem, ActivityType } from "../../data/types";

interface RecentActivityProps {
  activities: ActivityItem[];
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getActivityIcon(type: ActivityType) {
  switch (type) {
    case "merge":
      return { icon: GitMerge, color: "#a855f7" };
    case "create":
      return { icon: Plus, color: "var(--color-success)" };
    case "sync":
      return { icon: RefreshCw, color: "var(--color-info)" };
    case "archive":
      return { icon: Archive, color: "var(--color-text-muted)" };
    case "recover":
      return { icon: RotateCcw, color: "var(--color-warning)" };
  }
}

function getActivityText(type: ActivityType): string {
  switch (type) {
    case "merge":
      return "Merged";
    case "create":
      return "Created";
    case "sync":
      return "Synced";
    case "archive":
      return "Archived";
    case "recover":
      return "Recovered";
  }
}

export function RecentActivity({ activities }: RecentActivityProps) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--color-border)]">
        <h2 className="text-sm font-medium text-[var(--color-text)]">
          Recent Activity
        </h2>
      </div>
      <div className="p-4">
        {activities.length === 0 ? (
          <div className="text-center py-6 text-sm text-[var(--color-text-muted)]">
            No recent activity
          </div>
        ) : (
          <div className="space-y-3">
            {activities.map((activity, index) => {
              const { icon: Icon, color } = getActivityIcon(activity.type);
              return (
                <motion.div
                  key={activity.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: index * 0.05 }}
                  className="flex items-start gap-3"
                >
                  <div
                    className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
                    style={{ backgroundColor: `${color}15` }}
                  >
                    <Icon className="w-3.5 h-3.5" style={{ color }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-[var(--color-text)]">
                      <span className="text-[var(--color-text-muted)]">
                        {getActivityText(activity.type)}
                      </span>{" "}
                      <span className="font-medium">{activity.taskName}</span>
                    </div>
                    <div className="text-xs text-[var(--color-text-muted)] mt-0.5">
                      {activity.projectName} • {formatTimeAgo(activity.timestamp)}
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
