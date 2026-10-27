import { parseGroveMetaSegments } from "../../../utils/groveMeta";

/** Plain-text counterpart of the message body for minimap previews and labels. */
export function compactConversationText(value: string, limit = 220): string {
  // Parse before clipping: bootstrap instructions can be much longer than the
  // preview, leaving no room for the actual prompt if truncated first.
  const text = parseGroveMetaSegments(value).map((segment) => {
    if (segment.kind === "text") return segment.content;
    const { envelope } = segment;
    if (envelope.v === 1 && envelope.type === "grove_session_init") return "";
    return envelope.systemPrompt;
  }).join("");
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}
