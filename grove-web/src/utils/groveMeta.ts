/**
 * `<grove-meta>{...JSON...}</grove-meta>` envelope parser.
 *
 * The agent-graph injection format and the `@-mention` chip format both wrap
 * their payload in this single tag so the frontend has one parsing path and
 * one dispatcher. The schema is intentionally extensible — adding a new
 * `type` is a matter of registering a renderer; unknown types fall back to
 * the envelope's `system-prompt` text so nothing ever crashes the UI.
 *
 * Wire format:
 * ```text
 * <grove-meta>{"v":1,"type":"<type>","data":{...},"system-prompt":"..."}</grove-meta>
 * ```
 *
 * - `v` — schema version, currently always `1`. Renderers MAY refuse to
 *   render unknown versions and fall back to the `system-prompt` text.
 * - `type` — dispatcher key.
 * - `data` — type-specific payload.
 * - `system-prompt` — human-readable fallback. Also what AIs read inside the
 *   tag, so it doubles as their semantic instruction.
 */

export interface GroveMetaEnvelope {
  v: number;
  type: string;
  data: Record<string, unknown>;
  systemPrompt: string;
  /** Stamped by Grove on plugin envelopes; a plugin cannot choose it. */
  source?: { plugin_id?: string; plugin_name?: string };
}

export type GroveMetaSegment =
  | { kind: "text"; content: string }
  | { kind: "meta"; envelope: GroveMetaEnvelope; raw: string };

const META_TAG_RE = /<grove-meta\b[^>]*>([\s\S]*?)<\/grove-meta>/g;

interface RawEnvelope {
  v?: unknown;
  type?: unknown;
  data?: unknown;
  "system-prompt"?: unknown;
  source?: unknown;
}

function tryParseEnvelope(jsonText: string): GroveMetaEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  // Buddy messages sent before the v1 envelope: {"kind":"buddy_message",...}.
  const legacy = parsed as Record<string, unknown>;
  if (legacy.kind === "buddy_message" && legacy.v === undefined) {
    return { v: 1, type: "buddy_message", data: legacy, systemPrompt: "" };
  }
  const raw = parsed as RawEnvelope;
  if (
    typeof raw.v !== "number" ||
    typeof raw.type !== "string" ||
    typeof raw["system-prompt"] !== "string" ||
    raw.data === null ||
    typeof raw.data !== "object" ||
    Array.isArray(raw.data)
  ) {
    return null;
  }
  return {
    v: raw.v,
    type: raw.type,
    data: raw.data as Record<string, unknown>,
    systemPrompt: raw["system-prompt"] as string,
    ...(raw.source && typeof raw.source === "object"
      ? { source: raw.source as GroveMetaEnvelope["source"] }
      : {}),
  };
}

/**
 * Split a chat message body into a sequence of plain-text and meta-envelope
 * segments. Malformed envelopes (bad JSON, missing required fields) are kept
 * as plain text so user content that happens to contain `<grove-meta>` won't
 * silently disappear.
 */
export function parseGroveMetaSegments(raw: string): GroveMetaSegment[] {
  const segments: GroveMetaSegment[] = [];
  if (!raw) return segments;

  // Reset state: the regex is module-scoped (g flag) so callers don't share
  // lastIndex across invocations.
  META_TAG_RE.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = META_TAG_RE.exec(raw)) !== null) {
    const envelope = tryParseEnvelope(match[1].trim());
    if (envelope == null) {
      // Treat malformed tag as plain text — let it through unchanged.
      continue;
    }
    if (match.index > cursor) {
      segments.push({ kind: "text", content: raw.slice(cursor, match.index) });
    }
    segments.push({
      kind: "meta",
      envelope,
      raw: match[0],
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < raw.length) {
    segments.push({ kind: "text", content: raw.slice(cursor) });
  }
  return segments;
}

/**
 * Build the wire-format envelope string. Used by the frontend `@-mention`
 * chip writer; the backend has its own builder in `agent_graph::inject`.
 */
export function buildGroveMetaTag(
  type: string,
  data: Record<string, unknown>,
  systemPrompt: string,
  v = 1,
): string {
  const payload = JSON.stringify({
    v,
    type,
    data,
    "system-prompt": systemPrompt,
  });
  return `<grove-meta>${payload}</grove-meta>`;
}
