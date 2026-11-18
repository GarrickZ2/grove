/** Editing and deleting what was said, for the panels that show threads.
 *  The owner may change everything; a share link's reader only what they
 *  wrote. A reply is named by its id; without one it is the comment, and
 *  deleting the comment deletes its thread. */
export interface ThreadChanges<C> {
  canChange: (comment: C, replyId?: number) => boolean;
  edit: (comment: C, text: string, replyId?: number) => Promise<void>;
  remove: (comment: C, replyId?: number) => Promise<void>;
}

/** What a share link's reader wrote, which they may change. */
export function writtenByReader(comment: { mine?: boolean; replies: { id: number; mine?: boolean }[] }, replyId?: number): boolean {
  if (replyId === undefined) return Boolean(comment.mine);
  return Boolean(comment.replies.find((reply) => reply.id === replyId)?.mine);
}
