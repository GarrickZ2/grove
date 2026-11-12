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
  /** Where in the rendered file a comment made on a preview sits. */
  anchor?: { text?: string; selector?: string; textRange?: { quote?: string } };
  /** The thread under a comment made on a preview, oldest first. */
  replies?: Array<{ agent?: string; content: string }>;
  /** Set for a comment on a design page (Studio's Design panel). */
  design?: {
    name: string;
    page: string;
    /** The element the comment is on. */
    selector?: string;
    text?: string;
    /** Replies in the thread so far, oldest first. */
    replies?: string[];
  };
  /** Set for a comment on a sketch (Studio's Sketch panel). */
  sketch?: {
    id: string;
    name: string;
    /** Where on the sketch, for the agent: the elements by id, type and text, or the area. */
    place: string;
    /** Replies in the thread so far, oldest first. */
    replies?: string[];
  };
}

/** A comment on a sketch: which sketch and element, the thread, and how to answer. */
function buildSketchCommentMessage(comment: ChatReviewComment & { sketch: NonNullable<ChatReviewComment["sketch"]> }): string {
  const { sketch } = comment;
  const thread = sketch.replies?.length ? ` Replies so far: ${sketch.replies.map((reply) => `"${reply}"`).join("; ")}.` : "";
  const systemPrompt = `Please address Comment #${comment.id} on the sketch "${sketch.name}" (sketch://${sketch.id}), on ${sketch.place}. Comment: "${comment.content}".${thread} Read the sketch with grove_sketch_read, change it with grove_sketch_draw (keep the ids of the elements you change), then answer the comment with the grove_reply_review tool, saying what you changed.`;
  return buildGroveMetaTag(
    "review_comment",
    {
      id: comment.id,
      commentType: "file",
      filePath: comment.file_path || `sketch/${sketch.id}`,
      content: comment.content,
      agent: comment.agent || "",
      status: comment.status || "open",
    },
    systemPrompt,
  );
}

/** A comment on a design page: where it is, the thread, and how to answer. */
function buildDesignCommentMessage(comment: ChatReviewComment & { design: NonNullable<ChatReviewComment["design"]> }): string {
  const { design } = comment;
  const element = design.selector
    ? ` on the element \`${design.selector}\`${design.text ? ` ("${design.text}")` : ""}`
    : "";
  const thread = design.replies?.length ? ` Replies so far: ${design.replies.map((reply) => `"${reply}"`).join("; ")}.` : "";
  const systemPrompt = `Please address Comment #${comment.id} on the design page design/${design.name}/${design.page}${element}. Comment: "${comment.content}".${thread} Change the design, look at the result with grove_design_read, then answer the comment with the grove_reply_review tool, saying what you changed.`;
  return buildGroveMetaTag(
    "review_comment",
    {
      id: comment.id,
      commentType: "file",
      filePath: comment.file_path || `design/${design.name}/${design.page}`,
      content: comment.content,
      agent: comment.agent || "",
      status: comment.status || "open",
    },
    systemPrompt,
  );
}

/** A comment made on a file's preview: the part of the file it is on, and the thread so far. */
function previewCommentPrompt(comment: ChatReviewComment, anchor: NonNullable<ChatReviewComment["anchor"]>): string {
  const quote = (anchor.textRange?.quote || anchor.text || "").trim();
  const part = quote ? `, on the part that reads "${quote.length > 300 ? `${quote.slice(0, 300)}…` : quote}"` : "";
  const thread = comment.replies?.length
    ? ` Replies so far: ${comment.replies.map((reply) => `"${reply.agent ? `${reply.agent}: ` : ""}${reply.content}"`).join("; ")}.`
    : "";
  return `Please address Comment #${comment.id} on the file ${comment.file_path}${part}. Comment: "${comment.content}".${thread} Use the grove_reply_review tool to reply and set resolve: true when addressed.`;
}

/** One comment's grove-meta tag (unchanged from the original per-comment send). */
export function buildReviewCommentMessage(comment: ChatReviewComment): string {
  if (comment.design) return buildDesignCommentMessage({ ...comment, design: comment.design });
  if (comment.sketch) return buildSketchCommentMessage({ ...comment, sketch: comment.sketch });

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

  const systemPrompt = comment.anchor
    ? previewCommentPrompt(comment, comment.anchor)
    : `Please address Code Review Comment #${comment.id} on ${locLabel}. Comment: "${comment.content}". Use the grove_reply_review tool to reply and set resolve: true when addressed.`;

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
