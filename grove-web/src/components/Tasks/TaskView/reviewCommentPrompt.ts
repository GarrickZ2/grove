import { buildGroveMetaTag } from "../../../utils/groveMeta";

/*
 * The chat message that hands Code Review comments to the agent
 * ("Send to active Agent Chat Session"). One `review_comment` grove-meta tag
 * per comment; a batch is those tags in one message, sent once.
 *
 * Review dispatches `SEND_COMMENT_TO_CHAT_EVENT` with either one comment as
 * `detail` (the per-comment action) or `{ comments: [...] }` (send all open).
 */

export const SEND_COMMENT_TO_CHAT_EVENT = "grove-send-comment-to-chat";

/** The fields of a ReviewCommentEntry the prompt reads. */
export interface ChatReviewComment {
  id: number;
  comment_type?: string;
  file_path?: string;
  start_line?: number;
  end_line?: number;
  content: string;
  agent?: string;
  status?: string;
}

/** One comment's grove-meta tag (unchanged from the original per-comment send). */
export function buildReviewCommentMessage(comment: ChatReviewComment): string {
  // 1. Build line/location labels
  const lineRange = comment.start_line
    ? comment.start_line === comment.end_line
      ? `L${comment.start_line}`
      : `L${comment.start_line}-L${comment.end_line}`
    : "";
  const locLabel = comment.file_path
    ? `${comment.file_path.split("/").pop() || comment.file_path}${lineRange ? ":" + lineRange : ""}`
    : "Project-level";

  // 2. Build grove-meta payload
  const metaType = "review_comment";
  const metaData = {
    id: comment.id,
    commentType: comment.comment_type || "inline",
    filePath: comment.file_path || "",
    startLine: comment.start_line,
    endLine: comment.end_line,
    content: comment.content,
    agent: comment.agent || "",
    status: comment.status || "open",
  };

  const systemPrompt = `Please address Code Review Comment #${comment.id} on ${locLabel}. Comment: "${comment.content}". Use the grove_reply_review tool to reply and set resolve: true when addressed.`;

  return buildGroveMetaTag(metaType, metaData, systemPrompt);
}

/** Several comments in one message: each keeps its own tag, in order. */
export function buildReviewCommentsMessage(comments: ChatReviewComment[]): string {
  return comments.map(buildReviewCommentMessage).join("\n");
}

/** A batch request (`{ comments }`) rather than a single comment. */
export function isReviewCommentBatch(detail: unknown): detail is { comments: ChatReviewComment[] } {
  return !!detail && typeof detail === "object" && Array.isArray((detail as { comments?: unknown }).comments);
}

/* ── Active chat's agent, for "Send N comments to <agent>?" ─────────────── */

export const ACTIVE_CHAT_AGENT_EVENT = "grove-active-chat-agent-changed";

type AgentWindow = Window & { __groveActiveChatAgent?: string | null };

/** TaskChat publishes its agent label next to `__groveActiveChatId`. */
export function publishActiveChatAgent(label: string | null): void {
  if (typeof window === "undefined") return;
  (window as AgentWindow).__groveActiveChatAgent = label;
  window.dispatchEvent(new CustomEvent(ACTIVE_CHAT_AGENT_EVENT, { detail: label }));
}

export function readActiveChatAgent(): string | null {
  if (typeof window === "undefined") return null;
  return (window as AgentWindow).__groveActiveChatAgent ?? null;
}
