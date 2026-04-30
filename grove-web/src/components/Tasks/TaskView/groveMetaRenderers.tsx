import { createElement, type ReactNode } from "react";
import { agentIconComponent, resolveAgentIcon } from "../../../utils/agentIcon";
import type { GroveMetaEnvelope } from "../../../utils/groveMeta";

/**
 * Single-tag, type-dispatched renderer for `<grove-meta>` envelopes.
 *
 * To add a new envelope type:
 *   1. Register a renderer in `GROVE_META_RENDERERS` keyed by the `type` string.
 *   2. (Optional) Add a TypeScript interface for the `data` shape.
 *
 * Unknown / unsupported `type` falls back to `envelope.systemPrompt`, so the
 * UI never crashes on schema drift between backend and frontend versions.
 */

type Renderer = (
  envelope: GroveMetaEnvelope,
  ctx: RenderContext,
) => ReactNode;

export interface RenderContext {
  /** Inline (within a paragraph) vs block (own line). Renderers can choose to
   *  render compactly when inline. */
  layout: "inline" | "block";
}

interface MentionSpawnData {
  agent: string;
}

interface MentionSendData {
  sid: string;
  name: string;
  duty?: string;
  /** Underlying agent key for the target session (renders the brand icon). */
  agent?: string;
}

interface MentionReplyData {
  sid: string;
  name: string;
  msg_id: string;
  agent?: string;
}

interface AgentInjectData {
  sid: string;
  name: string;
  msg_id?: string;
  agent?: string;
}

interface PreviewCommentData {
  index?: number;
  total?: number;
  source?: string;
  filePath?: string;
  fileName?: string;
  rendererId?: string;
  locator?: {
    selector?: string;
    tagName?: string;
    id?: string;
    className?: string;
    text?: string;
  };
  comment?: string;
}

/**
 * Neutral pill style — readable in any theme. Type is conveyed by the brand
 * icon (and the small reply glyph for `mention_reply`), not by tinted color.
 */
const PILL_BASE =
  "inline-flex items-center gap-1 align-baseline rounded-md px-1.5 py-px text-[12px] font-medium leading-tight " +
  "bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] text-[var(--color-text)]";

/** Render `<muted-verb> <agent-icon> <name>` — verb leads (states the
 *  action), then the brand icon and the session name read together as the
 *  target. */
function pillWithVerb(
  agent: string | undefined,
  verb: string,
  name: string,
  title: string,
): ReactNode {
  const Icon = agentIconComponent(agent);
  return (
    <span className={PILL_BASE} title={title}>
      <span className="opacity-70 font-medium">{verb}</span>
      {createElement(Icon, { size: 12, className: "shrink-0" })}
      <span>{name}</span>
    </span>
  );
}

function renderMentionSpawn(env: GroveMetaEnvelope): ReactNode {
  const data = env.data as unknown as MentionSpawnData;
  // Persona ids resolve to a friendly label (the persona name) via the
  // shared icon util's registry; built-in agent keys also resolve to their
  // brand label (e.g. "Claude Code"). Fall back to the raw value only when
  // neither registry has the key.
  const label = resolveAgentIcon(data.agent).label || data.agent;
  return pillWithVerb(data.agent, "Spawn", label, `Spawn ${label}`);
}

function renderMentionSend(env: GroveMetaEnvelope): ReactNode {
  const data = env.data as unknown as MentionSendData;
  return pillWithVerb(
    data.agent,
    "Send To",
    data.name,
    data.duty ? `Send to ${data.name} — ${data.duty}` : `Send to ${data.name}`,
  );
}

function renderMentionReply(env: GroveMetaEnvelope): ReactNode {
  const data = env.data as unknown as MentionReplyData;
  return pillWithVerb(
    data.agent,
    "Reply To",
    data.name,
    `Reply to ${data.name}`,
  );
}

function renderAgentInjectBadge(
  env: GroveMetaEnvelope,
  variant: "send" | "reply",
): ReactNode {
  const data = env.data as unknown as AgentInjectData;
  const Icon = agentIconComponent(data.agent);
  // Receiver-side framing: this badge sits on a message that ARRIVED in the
  // current chat from another session, so the verb is "From", not "To".
  const verb = variant === "send" ? "Send From" : "Reply From";
  return (
    <div
      className="mb-2 inline-flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--color-text)]"
      title={env.systemPrompt}
    >
      <span className="opacity-70">{verb}</span>
      {createElement(Icon, { size: 14, className: "shrink-0" })}
      <span className="truncate">{data.name}</span>
    </div>
  );
}

/** Reminder envelope sent from the graph's "Remind" toolbar button.
 *  Renders as an amber/warning-tinted badge so it's visually distinct from
 *  agent_inject_send / agent_inject_reply (which are neutral). */
function renderUserRemindBadge(env: GroveMetaEnvelope): ReactNode {
  const data = env.data as unknown as AgentInjectData;
  const Icon = agentIconComponent(data.agent);
  return (
    <div
      className="mb-2 inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium"
      style={{
        borderColor: "color-mix(in srgb, var(--color-warning) 40%, transparent)",
        background: "color-mix(in srgb, var(--color-warning) 10%, transparent)",
        color: "var(--color-text)",
      }}
      title={env.systemPrompt}
    >
      <span style={{ color: "var(--color-warning)" }} className="font-semibold">
        Reminder
      </span>
      <span className="opacity-70">about</span>
      {createElement(Icon, { size: 14, className: "shrink-0" })}
      <span className="truncate">{data.name}</span>
    </div>
  );
}

function renderPreviewCommentCard(env: GroveMetaEnvelope): ReactNode {
  const data = env.data as unknown as PreviewCommentData;
  const filePath = data.filePath || "";
  const fileName = data.fileName || filePath.split("/").pop() || "Preview";
  const dir = filePath.endsWith(fileName)
    ? filePath.slice(0, Math.max(0, filePath.length - fileName.length - 1))
    : "";
  const locator = data.locator || {};
  const element = locator.selector || locator.tagName || data.rendererId || "preview element";
  const countLabel = typeof data.index === "number" && typeof data.total === "number"
    ? `${data.index}/${data.total}`
    : "Preview";

  return (
    <div
      className="my-2 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-bg-secondary)_78%,transparent)] text-[var(--color-text)]"
      title={env.systemPrompt}
    >
      <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 rounded-md bg-[color-mix(in_srgb,var(--color-highlight)_14%,transparent)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-highlight)]">
            {countLabel}
          </span>
          <span className="truncate text-[12px] font-semibold" title={filePath}>
            {fileName}
          </span>
          {dir && (
            <span className="truncate text-[10px] text-[var(--color-text-muted)]" title={filePath}>
              {dir}
            </span>
          )}
        </div>
        {data.source && (
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
            {data.source}
          </span>
        )}
      </div>
      <div className="space-y-1.5 px-3 py-2.5">
        <div className="whitespace-pre-wrap break-words text-[12.5px] leading-snug">
          {data.comment || env.systemPrompt}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
          <code className="max-w-full truncate rounded border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-1.5 py-0.5">
            {element}
          </code>
          {locator.text && (
            <span className="max-w-full truncate" title={locator.text}>
              {locator.text}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export const GROVE_META_RENDERERS: Record<string, Renderer> = {
  mention_spawn: (env) => renderMentionSpawn(env),
  mention_send: (env) => renderMentionSend(env),
  mention_reply: (env) => renderMentionReply(env),
  agent_inject_send: (env) => renderAgentInjectBadge(env, "send"),
  agent_inject_reply: (env) => renderAgentInjectBadge(env, "reply"),
  user_remind: (env) => renderUserRemindBadge(env),
  preview_comment: (env) => renderPreviewCommentCard(env),
};

/** Render an envelope, falling back to `systemPrompt` text on unknown type or
 *  renderer failure. */
export function renderGroveMetaEnvelope(
  envelope: GroveMetaEnvelope,
  ctx: RenderContext,
): ReactNode {
  if (envelope.v !== 1) return envelope.systemPrompt;
  const renderer = GROVE_META_RENDERERS[envelope.type];
  if (!renderer) return envelope.systemPrompt;
  try {
    return renderer(envelope, ctx);
  } catch {
    return envelope.systemPrompt;
  }
}
