import { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { MessageSquare, CheckCircle, XCircle, Clock, FileCode, Loader2 } from "lucide-react";
import type { Task } from "../../../../data/types";
import { useProject } from "../../../../context/ProjectContext";
import { getReviewComments, type ReviewCommentEntry } from "../../../../api";

type ReviewStatus = "open" | "resolved" | "not_resolved";

interface ReviewTabProps {
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

function ReviewCommentCard({ comment }: { comment: ReviewCommentEntry }) {
  const statusConfig = getStatusConfig(comment.status as ReviewStatus);
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
          <code className="font-mono truncate max-w-[200px]">{comment.location}</code>
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
        {comment.reply && (
          <div className="mt-2 pt-2 border-t border-[var(--color-border)]">
            <p className="text-xs text-[var(--color-text-muted)] mb-1">Reply:</p>
            <p className="text-sm text-[var(--color-text-muted)]">{comment.reply}</p>
          </div>
        )}
      </div>
    </motion.div>
  );
}

export function ReviewTab({ task }: ReviewTabProps) {
  const { selectedProject } = useProject();
  const [comments, setComments] = useState<ReviewCommentEntry[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [resolvedCount, setResolvedCount] = useState(0);
  const [notResolvedCount, setNotResolvedCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  const loadComments = useCallback(async () => {
    if (!selectedProject) return;

    try {
      setIsLoading(true);
      const response = await getReviewComments(selectedProject.id, task.id);
      setComments(response.comments);
      setOpenCount(response.open_count);
      setResolvedCount(response.resolved_count);
      setNotResolvedCount(response.not_resolved_count);
    } catch (err) {
      console.error("Failed to load review comments:", err);
      setComments([]);
    } finally {
      setIsLoading(false);
    }
  }, [selectedProject, task.id]);

  useEffect(() => {
    loadComments();
  }, [loadComments]);

  if (isLoading) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center">
        <Loader2 className="w-8 h-8 text-[var(--color-text-muted)] mb-3 animate-spin" />
        <p className="text-[var(--color-text-muted)]">Loading comments...</p>
      </div>
    );
  }

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
