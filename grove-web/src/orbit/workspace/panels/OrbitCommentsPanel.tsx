import { useMemo, useState } from "react";
import { Eye, MessageSquare, RotateCw } from "lucide-react";
import type { Task } from "../../../data/types";
import type { ReviewCommentEntry } from "../../../api";
import { MarkdownRenderer } from "../../../components/ui";
import { AgentAvatar } from "../../../components/Review/AgentAvatar";
import { AgentDisplay } from "../../../components/Review/agentDisplay";
import { useReviewComments } from "../../../components/Tasks/TaskInfoPanel/tabs/useReviewComments";
import { Segmented } from "../../ui/Segmented";
import { EmptyState } from "../../ui/Surface";
import { formatDateTime, relativeText } from "../../ui/format";
import { commentLocation, filterComments, type CommentFilter } from "./panelModel";
import { PanelEmpty, PanelError, PanelHeaderContext, PanelLoading } from "../../ui/PanelShell";
import { usePanelMenuItems, type PanelMenuItem } from "../../ui/panelSlots";
import { PanelBody } from "./PanelStates";
import { requestOpenReview } from "../openReview";

const STATUS: Record<string, { label: string; tone: string }> = {
  open: { label: "Open", tone: "is-warn" },
  outdated: { label: "Outdated", tone: "is-info" },
  resolved: { label: "Resolved", tone: "" },
};

/** Opens Code Review at the comment's file and line (or just Review, for a whole-change comment). */
function openInReview(projectId: string, taskId: string, comment: ReviewCommentEntry) {
  const file = comment.file_path || undefined;
  // DELETE-side lines number the old file, which Review can't scroll to; land on the file.
  const line = file && comment.side !== "DELETE" ? comment.start_line : undefined;
  // Outdated anchors may have left the diff; All files still has the file.
  const mode = file ? (comment.status === "outdated" ? "full" : "diff") : undefined;
  requestOpenReview({ projectId, taskId, file, line, mode });
}

function Comment({ comment, index, onOpenInReview }: { comment: ReviewCommentEntry; index: number; onOpenInReview?: () => void }) {
  const where = commentLocation(comment);
  const status = STATUS[comment.status] ?? { label: comment.status, tone: "" };
  return (
    <article className={`owp-cmt owp-cmt-enter is-${comment.status}`} style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}>
      <AgentAvatar agent={comment.agent} size={22} />
      <div className="owp-cmt-body">
        <div className="owp-where">
          <code title={where.title}>{where.label}</code>
          <span className={`owp-tag ${status.tone}`}>{status.label}</span>
          <time dateTime={comment.timestamp} title={formatDateTime(comment.timestamp)}>{relativeText(comment.timestamp)}</time>
        </div>
        <div className="owp-by"><AgentDisplay agent={comment.agent} role={comment.role} model={comment.model} /></div>
        <div className="owp-md markdown-content"><MarkdownRenderer content={comment.content} /></div>
        {onOpenInReview ? (
          <button type="button" className="owp-cmt-open" onClick={onOpenInReview} title={where.title ? `Open ${where.title} in Code Review` : "Open in Code Review"}>
            <Eye aria-hidden="true" />Open in Review
          </button>
        ) : null}
        {comment.replies.length > 0 ? (
          <div className="owp-replies">
            {comment.replies.map((reply) => (
              <div key={reply.id} className="owp-reply">
                <div className="owp-reply-head">
                  <AgentAvatar agent={reply.agent} size={16} />
                  <b><AgentDisplay agent={reply.agent} role={reply.role} model={reply.model} /></b>
                  <time dateTime={reply.timestamp} title={formatDateTime(reply.timestamp)}>{relativeText(reply.timestamp)}</time>
                </div>
                <div className="owp-md markdown-content"><MarkdownRenderer content={reply.content} /></div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

const EMPTY_FILTER: Record<CommentFilter, string> = {
  open: "Nothing open. Every comment is resolved.",
  resolved: "No resolved comments yet.",
  all: "No comments.",
};

/** Comments panel body: Code Review comments with their status and replies. */
export function OrbitCommentsPanel({ projectId, task }: { projectId?: string; task: Task }) {
  const { comments, openCount, resolvedCount, outdatedCount, isLoading, error, reload } = useReviewComments(projectId, task.id);
  const [picked, setPicked] = useState<CommentFilter | null>(null);
  const actualOpen = openCount + outdatedCount;
  // Start on what needs attention; fall back to everything once nothing is open.
  const filter: CommentFilter = picked ?? (actualOpen > 0 ? "open" : "all");
  const menu = useMemo<PanelMenuItem[]>(() => [{ id: "comments-refresh", label: "Refresh", icon: RotateCw, onSelect: () => void reload() }], [reload]);
  usePanelMenuItems(menu);

  if (isLoading && comments.length === 0) {
    return (
      <PanelBody label="Comments">
        <PanelLoading label="Loading comments" boxes={3} />
      </PanelBody>
    );
  }

  if (error) {
    return (
      <PanelBody label="Comments">
        <PanelError title="Couldn’t load review comments" onRetry={() => void reload()} retrying={isLoading}>{error}</PanelError>
      </PanelBody>
    );
  }

  if (comments.length === 0) {
    return (
      <PanelBody label="Comments">
        <PanelEmpty icon={MessageSquare} title="No review comments">
          Comments left in Code Review, by you or an agent, show up here with their replies.
        </PanelEmpty>
      </PanelBody>
    );
  }

  const visible = filterComments(comments, filter);

  return (
    <PanelBody label="Comments">
      <PanelHeaderContext>{actualOpen > 0 ? `${actualOpen} open` : comments.length > 0 ? "All resolved" : "From code review"}</PanelHeaderContext>
      <div className="owp-filter">
        <Segmented
          size="sm"
          block
          ariaLabel="Show comments"
          value={filter}
          onChange={setPicked}
          options={[
            { value: "open", label: "Open", count: actualOpen },
            { value: "all", label: "All", count: comments.length },
            { value: "resolved", label: "Resolved", count: resolvedCount },
          ]}
        />
      </div>
      <div className="owp-scroll">
        <div className="owp-box" key={filter}>
          {visible.length === 0 ? (
            <EmptyState>{EMPTY_FILTER[filter]}</EmptyState>
          ) : (
            visible.map((comment, index) => (
              <Comment
                key={comment.id}
                comment={comment}
                index={index}
                onOpenInReview={projectId ? () => openInReview(projectId, task.id, comment) : undefined}
              />
            ))
          )}
        </div>
      </div>
    </PanelBody>
  );
}
