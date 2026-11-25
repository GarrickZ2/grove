/** Design, Sketch and share link comments carry their author as one string,
 *  "Codex (Reviewer)"; the avatar and the name want the two apart. */
export function commentAuthor(author: string): { agent: string; role: string } {
  const match = /^(.+?)\s*\(([^()]*)\)$/.exec(author.trim());
  return match ? { agent: match[1], role: match[2].trim() } : { agent: author.trim(), role: "" };
}
