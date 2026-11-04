import { parseGroveMetaSegments, type GroveMetaEnvelope } from "../../../utils/groveMeta";

// Rendered as nothing in the bubble: the sender line says who a Buddy message
// is from, and mentioned Buddies are already named in the text.
const SILENT_ENVELOPES = new Set(["grove_session_init", "buddy_message", "buddy_mentions"]);

/** What an envelope reads as outside the chat bubble. */
export function readableEnvelopeText(envelope: GroveMetaEnvelope): string {
  return envelope.v === 1 && SILENT_ENVELOPES.has(envelope.type) ? "" : envelope.systemPrompt;
}

/** The message body as a person reads it, for copying and search. */
export function readableConversationText(value: string): string {
  return parseGroveMetaSegments(value)
    .map((segment) => segment.kind === "text" ? segment.content : readableEnvelopeText(segment.envelope))
    .join("")
    .trim();
}

/** Plain-text counterpart of the message body for minimap previews and labels. */
export function compactConversationText(value: string, limit = 220): string {
  // Parse before clipping: bootstrap instructions can be much longer than the
  // preview, leaving no room for the actual prompt if truncated first.
  const compact = readableConversationText(value).replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}
