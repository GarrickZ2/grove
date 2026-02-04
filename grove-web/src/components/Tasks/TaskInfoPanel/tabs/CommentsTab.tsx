import { motion } from "framer-motion";
import { MessageSquare, CheckCircle, XCircle, Clock, FileCode } from "lucide-react";
import type { Task, ReviewComment, ReviewStatus } from "../../../../data/types";
import { getTaskReviewComments } from "../../../../data/mockData";

interface CommentsTabProps {
  task: Task;
}

function getStatusConfig(status: ReviewStatus): {
  icon: typeof CheckCircle;
  color: string;
  label: string;
} {
  switch (status) {
    case "open":
      return {
        icon: Clock,
        color: "var(--color-warning)",
        label: "Open",
      };
    case "resolved":
      return {
        icon: CheckCircle,
        color: "var(--color-success)",
        label: "Resolved",
      };
    case "not_resolved":
      return {
        icon: XCircle,
        color: "var(--color-error)",
        label: "Not Resolved",
      };
  }
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

function ReviewCommentCard({ comment }: { comment: ReviewComment }) {
  const statusConfig = getStatusConfig(comment.status);
  const StatusIcon = statusConfig.icon;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-[var(--color-bg-secondary)] border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
          <FileCode className="w-3.5 h-3.5" />
          <code className="font-mono">{comment.file}</code>
          <span>:</span>
          <span>L{comment.line}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <StatusIcon
            className="w-3.5 h-3.5"
            style={{ color: statusConfig.color }}
          />
          <span
            className="text-xs font-medium"
            style={{ color: statusConfig.color }}
          >
            {statusConfig.label}
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="p-3">
        <p className="text-sm text-[var(--color-text)]">{comment.content}</p>
        <div className="flex items-center gap-2 mt-2 text-xs text-[var(--color-text-muted)]">
          <span>@{comment.author}</span>
          <span>•</span>
          <span>{formatTimeAgo(comment.createdAt)}</span>
          {comment.resolvedAt && (
            <>
              <span>•</span>
              <span className="text-[var(--color-success)]">
                Resolved {formatTimeAgo(comment.resolvedAt)}
              </span>
            </>
          )}
        </div>
      </div>
    </motion.div>
  );
}

export function CommentsTab({ task }: CommentsTabProps) {
  const comments = getTaskReviewComments(task.id);

  const openCount = comments.filter((c) => c.status === "open").length;
  const resolvedCount = comments.filter((c) => c.status === "resolved").length;
  const notResolvedCount = comments.filter((c) => c.status === "not_resolved").length;

  if (comments.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center">
        <MessageSquare className="w-12 h-12 text-[var(--color-text-muted)] mb-3" />
        <p className="text-[var(--color-text-muted)]">No review comments</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex gap-4 text-sm">
        <div className="flex items-center gap-1.5">
          <Clock className="w-4 h-4 text-[var(--color-warning)]" />
          <span className="text-[var(--color-text)]">{openCount} Open</span>
        </div>
        <div className="flex items-center gap-1.5">
          <CheckCircle className="w-4 h-4 text-[var(--color-success)]" />
          <span className="text-[var(--color-text)]">{resolvedCount} Resolved</span>
        </div>
        {notResolvedCount > 0 && (
          <div className="flex items-center gap-1.5">
            <XCircle className="w-4 h-4 text-[var(--color-error)]" />
            <span className="text-[var(--color-text)]">{notResolvedCount} Not Resolved</span>
          </div>
        )}
      </div>

      {/* Comments */}
      <div className="space-y-3">
        {comments.map((comment, index) => (
          <motion.div
            key={comment.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.05 }}
          >
            <ReviewCommentCard comment={comment} />
          </motion.div>
        ))}
      </div>
    </div>
  );
}
