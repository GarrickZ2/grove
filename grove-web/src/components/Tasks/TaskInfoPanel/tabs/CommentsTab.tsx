import { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { MessageSquare, CheckCircle, Clock, FileCode, Loader2 } from "lucide-react";
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Task } from "../../../../data/types";
import { useProject } from "../../../../context/ProjectContext";
import { getReviewComments, type ReviewCommentEntry } from "../../../../api";
import { AgentAvatar } from "../../../Review/AgentAvatar";

type ReviewStatus = "open" | "resolved" | "outdated";

interface CommentsTabProps {
  task: Task;
}

/** Format ISO timestamp to local timezone, seconds precision, no T or offset */
function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return ts;
  }
}

/** Extract filename from path and build line label */
function formatLocation(comment: ReviewCommentEntry): string {
  const type = comment.comment_type || 'inline';

  if (type === 'project') {
    return 'Project-level';
  } else if (type === 'file' && comment.file_path) {
    const parts = comment.file_path.split("/");
    const filename = parts[parts.length - 1] || comment.file_path;
    return `${filename} (File-level)`;
  } else if (comment.file_path && comment.start_line !== undefined && comment.end_line !== undefined) {
    const parts = comment.file_path.split("/");
    const filename = parts[parts.length - 1] || comment.file_path;
    const lineLabel =
      comment.start_line !== comment.end_line
        ? `L${comment.start_line}-${comment.end_line}`
        : `L${comment.start_line}`;
    return `${filename} ${lineLabel}`;
  }

  return 'Unknown location';
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
    case "outdated":
      return {
        icon: Clock,
        color: "var(--color-text-muted)",
        label: "Outdated",
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
          <FileCode className="w-3.5 h-3.5 flex-shrink-0" />
          <code className="font-mono">{formatLocation(comment)}</code>
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

      {/* Main comment */}
      <div className="p-3">
        <div className="flex items-center gap-2 mb-1.5">
          <AgentAvatar name={comment.author} size={18} />
          <span className="text-xs font-medium text-[var(--color-text)]">{comment.author}</span>
          <span className="text-xs text-[var(--color-text-muted)]">{formatTimestamp(comment.timestamp)}</span>
        </div>
        <div className="text-sm text-[var(--color-text)] pl-[26px] markdown-content">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {comment.content}
          </ReactMarkdown>
        </div>

        {/* Replies */}
        {comment.replies.length > 0 && comment.replies.map((reply) => (
          <div key={reply.id} className="mt-2.5 pt-2.5 border-t border-[var(--color-border)] pl-[26px]">
            <div className="flex items-center gap-2 mb-1">
              <AgentAvatar name={reply.author} size={16} />
              <span className="text-xs font-medium text-[var(--color-text)]">{reply.author}</span>
              <span className="text-xs text-[var(--color-text-muted)]">{formatTimestamp(reply.timestamp)}</span>
            </div>
            <div className="text-sm text-[var(--color-text-muted)] pl-[24px] markdown-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {reply.content}
              </ReactMarkdown>
            </div>
          </div>
        ))}
      </div>
    </motion.div>
  );
}

export function CommentsTab({ task }: CommentsTabProps) {
  const { selectedProject } = useProject();
  const [comments, setComments] = useState<ReviewCommentEntry[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [resolvedCount, setResolvedCount] = useState(0);
  const [outdatedCount, setOutdatedCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  const loadComments = useCallback(async () => {
    if (!selectedProject) return;

    try {
      setIsLoading(true);
      const response = await getReviewComments(selectedProject.id, task.id);
      setComments(response.comments);
      setOpenCount(response.open_count);
      setResolvedCount(response.resolved_count);
      setOutdatedCount(response.outdated_count);
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
        {outdatedCount > 0 && (
          <div className="flex items-center gap-1.5">
            <Clock className="w-4 h-4 text-[var(--color-text-muted)]" />
            <span className="text-[var(--color-text)]">{outdatedCount} Outdated</span>
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
