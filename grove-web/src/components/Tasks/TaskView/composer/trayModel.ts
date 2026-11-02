import type { PreviewCommentDraft } from "../../../../context";

/** Anchor line for a comment: the message for chat comments, else the file and its folder. */
export function commentAnchor(draft: PreviewCommentDraft): { label: string; dir: string } {
  const label = draft.source === "chat"
    ? `Conversation · message ${draft.filePath.split("-").pop()}`
    : draft.fileName || draft.filePath.split("/").pop() || draft.filePath;
  const dir = draft.source === "chat" ? "" : draft.filePath.slice(0, Math.max(0, draft.filePath.length - label.length - 1));
  return { label, dir };
}
