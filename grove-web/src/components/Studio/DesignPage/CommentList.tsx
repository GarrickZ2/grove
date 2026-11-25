import { useState } from "react";
import { useBanner } from "../../../context";
import type { ReviewCommentEntry } from "../../../api/tasks";
import { commentAuthor } from "../../Review/commentAuthor";
import { ConversationSidebar } from "../../Review/ConversationSidebar";
import { ReviewComments } from "../../Review/ReviewComments";
import { SendOpenCommentsDialog } from "../../Review/SendOpenCommentsDialog";
import type { ThreadComment } from "./DesignThread";
import type { ThreadChanges } from "./threadChanges";

type Listed = ThreadComment & { id: number; via_share?: boolean };

/** A design's or a sketch's comment as Code Review's cards show one. */
// eslint-disable-next-line react-refresh/only-export-components -- the list's own mapping, shared with the thread
export function reviewEntry(comment: Listed, canChange?: (replyId?: number) => boolean): ReviewCommentEntry {
  return {
    id: comment.id,
    comment_type: "file",
    content: comment.content,
    ...commentAuthor(comment.author),
    model: "",
    timestamp: comment.timestamp,
    status: comment.status,
    via_share: comment.via_share,
    mine: canChange?.(),
    replies: comment.replies.map((reply) => ({
      id: reply.id,
      content: reply.content,
      ...commentAuthor(reply.author),
      model: "",
      timestamp: reply.timestamp,
      mine: canChange?.(reply.id),
    })),
  };
}

/** The comments of a design, a sketch or a file: Code Review's list. */
export function CommentList<C extends Listed>({ comments, placeOf, entryOf, agent, canSend, onSend, onSendAll, onOpen, onStatus, onReply, changes }: {
  comments: C[];
  /** Where the comment is: a page's title, an element. */
  placeOf: (comment: C) => string;
  /** The comment as Code Review has it, where it is one already. */
  entryOf?: (comment: C) => ReviewCommentEntry;
  agent?: string | null;
  canSend?: boolean;
  onSend?: (comments: C[]) => void;
  /** Ask before all open ones are sent; without it the list asks itself. */
  onSendAll?: () => void;
  onOpen: (comment: C, at: { x: number; y: number }) => void;
  /** Resolve or reopen; absent where the reader may not. */
  onStatus?: (comments: C[], status: "open" | "resolved") => void;
  onReply?: (comment: C, text: string) => Promise<void>;
  /** Editing and deleting; absent where nothing can be. */
  changes?: ThreadChanges<C>;
}) {
  const { showBanner } = useBanner();
  const [sendingAll, setSendingAll] = useState(false);
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const entries = comments.map((comment) => entryOf?.(comment) ?? reviewEntry(comment, changes ? (replyId) => changes.canChange(comment, replyId) : undefined));
  const open = comments.filter((comment) => comment.status !== "resolved");
  const on = (id: number, act: (comment: C) => void) => {
    const comment = byId.get(id);
    if (comment) act(comment);
  };
  const attempt = (work: Promise<void>, failure: string) => {
    work.catch(() => showBanner(failure, "error"));
  };
  const removeAll = async (list: C[]) => {
    if (!changes) return;
    for (const comment of list) await changes.remove(comment);
  };
  const sendTitle = !canSend
    ? "Open the task's chat to send comments to its agent"
    : `Send ${open.length} open ${open.length === 1 ? "comment" : "comments"} to ${agent || "the agent"}`;

  return (
    <ReviewComments>
      <ConversationSidebar
        comments={entries}
        visible
        flat
        locationOf={(entry) => {
          const comment = byId.get(entry.id);
          return comment ? placeOf(comment) : "";
        }}
        onOpenComment={(entry, box) => on(entry.id, (comment) => onOpen(comment, { x: box.left - 342, y: box.top + 12 }))}
        onNavigateToComment={() => {}}
        onSendComment={onSend ? (entry) => on(entry.id, (comment) => onSend([comment])) : null}
        onSendAllOpen={onSend ? onSendAll ?? (() => setSendingAll(true)) : undefined}
        sendAllDisabled={!canSend || !open.length}
        sendAllTitle={sendTitle}
        onResolveComment={onStatus ? (id) => on(id, (comment) => onStatus([comment], "resolved")) : undefined}
        onReopenComment={onStatus ? (id) => on(id, (comment) => onStatus([comment], "open")) : undefined}
        onReplyComment={onReply ? (id, _status, text) => on(id, (comment) => attempt(onReply(comment, text), "Couldn't save the reply")) : undefined}
        onDeleteComment={changes ? (id) => on(id, (comment) => attempt(changes.remove(comment), "Couldn't delete the comment")) : undefined}
        // The owner's alone, as in Code Review; only what is listed here.
        onBulkDelete={changes && onStatus ? (statuses, authors) => {
          const chosen = entries.filter((entry) => (!statuses || statuses.includes(entry.status)) && (!authors || authors.includes(entry.agent)));
          attempt(removeAll(chosen.flatMap((entry) => byId.get(entry.id) ?? [])), "Couldn't delete the comments");
        } : undefined}
      />
      {sendingAll && onSend ? (
        <SendOpenCommentsDialog
          comments={entries.filter((entry) => entry.status !== "resolved")}
          agent={agent ?? null}
          onSend={() => onSend(open)}
          onClose={() => setSendingAll(false)}
        />
      ) : null}
    </ReviewComments>
  );
}
