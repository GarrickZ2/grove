import { GitBranch, ArrowRight, Circle, CheckCircle, AlertTriangle, XCircle, Archive } from "lucide-react";
import type { Task, TaskStatus } from "../../../data/types";

interface TaskHeaderProps {
  task: Task;
}

function getStatusConfig(status: TaskStatus): {
  icon: typeof Circle;
  color: string;
  label: string;
  pulse?: boolean;
} {
  switch (status) {
    case "live":
      return {
        icon: Circle,
        color: "var(--color-success)",
        label: "Live",
        pulse: true,
      };
    case "idle":
      return {
        icon: Circle,
        color: "var(--color-text-muted)",
        label: "Idle",
      };
    case "merged":
      return {
        icon: CheckCircle,
        color: "#a855f7",
        label: "Merged",
      };
    case "conflict":
      return {
        icon: AlertTriangle,
        color: "var(--color-error)",
        label: "Conflict",
      };
    case "broken":
      return {
        icon: XCircle,
        color: "var(--color-error)",
        label: "Broken",
      };
    case "archived":
      return {
        icon: Archive,
        color: "var(--color-text-muted)",
        label: "Archived",
      };
  }
}

export function TaskHeader({ task }: TaskHeaderProps) {
  const statusConfig = getStatusConfig(task.status);
  const StatusIcon = statusConfig.icon;

  return (
    <div className="px-4 py-3 border-b border-[var(--color-border)]">
      {/* Title and Status */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-[var(--color-text)]">
          {task.name}
        </h2>
        <div className="flex items-center gap-2">
          <div className="relative">
            <StatusIcon
              className="w-3.5 h-3.5"
              style={{
                color: statusConfig.color,
                fill: task.status === "live" ? statusConfig.color : "transparent"
              }}
            />
            {statusConfig.pulse && (
              <span className="absolute inset-0 animate-ping">
                <Circle
                  className="w-3.5 h-3.5"
                  style={{
                    fill: `${statusConfig.color}30`,
                    color: "transparent"
                  }}
                />
              </span>
            )}
          </div>
          <span
            className="text-sm font-medium"
            style={{ color: statusConfig.color }}
          >
            {statusConfig.label}
          </span>
        </div>
      </div>

      {/* Branch info */}
      <div className="flex items-center gap-2 mt-1.5 text-sm text-[var(--color-text-muted)]">
        <GitBranch className="w-3.5 h-3.5" />
        <span className="truncate">{task.branch}</span>
        <ArrowRight className="w-3 h-3" />
        <span>{task.target}</span>
      </div>
    </div>
  );
}
