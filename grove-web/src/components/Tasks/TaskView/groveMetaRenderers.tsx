import { createElement, type ReactNode } from "react";
import { agentIconComponent, resolveAgentIcon } from "../../../utils/agentIcon";
import { openExternalUrl } from "../../../utils/openExternal";
import { parseGroveMetaSegments, type GroveMetaEnvelope } from "../../../utils/groveMeta";
import { resolvePluginMeta, type ResolvedPluginMeta } from "../../../utils/pluginMeta";

/**
 * Single-tag, type-dispatched renderer for `<grove-meta>` envelopes.
 *
 * To add a new envelope type:
 *   1. Register a renderer in `GROVE_META_RENDERERS` keyed by the `type` string.
 *   2. (Optional) Add a TypeScript interface for the `data` shape.
 *
 * Unknown / unsupported `type` falls back to `envelope.systemPrompt`, so the
 * UI never crashes on schema drift between backend and frontend versions.
 * Session bootstrap metadata is explicitly hidden here while remaining part
 * of the persisted ACP transcript.
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

interface BrowserTabData {
  url: string;
  title?: string;
  tab_id?: number;
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

/** Browser-tab @-mention chip — same visual language as the chip the user
 *  saw in the input box (favicon + title pill). Title is truncated so a long
 *  Open Graph description doesn't blow up the message bubble. Same threshold
 *  as the composer chip (`MAX_CHIP_TITLE = 40` in TaskChat.tsx) so a tab
 *  reads identically on send and on replay. */
const BROWSER_TAB_MAX_TITLE = 40;
function renderBrowserTab(env: GroveMetaEnvelope): ReactNode {
  const data = env.data as unknown as BrowserTabData;
  const url = data.url;
  const rawTitle = data.title || url;
  const title =
    rawTitle.length > BROWSER_TAB_MAX_TITLE
      ? `${rawTitle.slice(0, BROWSER_TAB_MAX_TITLE).trimEnd()}…`
      : rawTitle;
  let faviconUrl = "";
  try {
    const domain = new URL(url).hostname;
    faviconUrl = `https://www.google.com/s2/favicons?sz=32&domain=${domain}`;
  } catch {
    faviconUrl = "";
  }
  const tooltip = `${rawTitle} (${url})${
    typeof data.tab_id === "number" ? ` · tab_id=${data.tab_id}` : ""
  }`;
  return (
    <button
      type="button"
      onClick={() => openExternalUrl(url)}
      title={tooltip}
      className="inline-flex items-center gap-1 align-baseline rounded-full px-2 py-px text-[12px] font-medium leading-tight cursor-pointer"
      style={{
        background: "color-mix(in srgb, var(--color-bg-secondary) 80%, var(--color-bg))",
        border: "1px solid color-mix(in srgb, var(--color-border) 65%, transparent)",
        color: "var(--color-accent)",
        margin: "0 2px",
        verticalAlign: "baseline",
      }}
    >
      {faviconUrl && (
        <img
          src={faviconUrl}
          alt=""
          width={13}
          height={13}
          style={{
            display: "inline-block",
            verticalAlign: "middle",
            flexShrink: 0,
            borderRadius: 2,
          }}
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
        />
      )}
      <span className="max-w-[260px] truncate">{title}</span>
    </button>
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

function renderReviewCommentCard(env: GroveMetaEnvelope): ReactNode {
  const data = env.data as unknown as {
    id: number;
    commentType?: string;
    filePath?: string;
    startLine?: number;
    endLine?: number;
    content: string;
    agent?: string;
    status?: string;
    instructions?: string;
  };
  const filePath = data.filePath || "";
  const fileName = filePath.split("/").pop() || "";
  const dir = filePath.endsWith(fileName)
    ? filePath.slice(0, Math.max(0, filePath.length - fileName.length - 1))
    : "";
  
  const isProjectLevel = data.commentType === "project" || !filePath;
  const isFileLevel = data.commentType === "file";

  const typeLabel = isProjectLevel
    ? "Project Discussion"
    : isFileLevel
      ? "File Comment"
      : `Line Comment`;

  const lineRange = data.startLine
    ? data.startLine === data.endLine
      ? `:L${data.startLine}`
      : `:L${data.startLine}-L${data.endLine}`
    : "";

  return (
    <div
      className="my-2 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-bg-secondary)_78%,transparent)] text-[var(--color-text)]"
      title={env.systemPrompt}
    >
      <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 rounded-md bg-[color-mix(in_srgb,var(--color-warning)_14%,transparent)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-warning)]">
            Comment #{data.id}
          </span>
          {!isProjectLevel ? (
            <>
              <span className="truncate text-[12px] font-semibold" title={filePath}>
                {fileName}{lineRange}
              </span>
              {dir && (
                <span className="truncate text-[10px] text-[var(--color-text-muted)]" title={filePath}>
                  {dir}
                </span>
              )}
            </>
          ) : (
            <span className="text-[12px] font-semibold">Project Discussion</span>
          )}
        </div>
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] font-medium">
          {typeLabel}
        </span>
      </div>
      <div className="space-y-1.5 px-3 py-2.5">
        <div className="whitespace-pre-wrap break-words text-[12.5px] leading-snug">
          {data.content}
        </div>
      </div>
    </div>
  );
}

/** Who sent a Buddy message (hand-off, follow-up, notice), read from its
 * `buddy_message` envelope. The sender line above the bubble shows this, so
 * the envelope itself renders nothing inside the message. */
export function buddyMessageSender(content: string): { id: string; name: string; avatar: string | null } | null {
  for (const segment of parseGroveMetaSegments(content)) {
    if (segment.kind !== "meta" || segment.envelope.type !== "buddy_message") continue;
    const data = segment.envelope.data as { buddy_id?: unknown; name?: unknown; avatar?: unknown };
    return {
      id: typeof data.buddy_id === "string" ? data.buddy_id : "",
      name: typeof data.name === "string" && data.name ? data.name : "Buddy",
      avatar: typeof data.avatar === "string" ? data.avatar : null,
    };
  }
  return null;
}

/** Shows which plugin a Prompt came from. The name is Grove-stamped. */
function renderPluginInjectBadge(env: GroveMetaEnvelope): ReactNode {
  const name = env.source?.plugin_name ?? (env.data as { plugin_name?: string }).plugin_name ?? "Plugin";
  return (
    <div
      className="mb-2 inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium"
      style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}
      title={env.systemPrompt}
    >
      From plugin <span style={{ color: "var(--color-text)" }}>{name}</span>
    </div>
  );
}

const META_TONE: Record<NonNullable<ResolvedPluginMeta["badge"]>["tone"], string> = {
  neutral: "var(--color-text-muted)",
  success: "var(--color-success)",
  warning: "var(--color-warning)",
  error: "var(--color-error)",
  info: "var(--color-info)",
};

function renderPluginMeta(meta: ResolvedPluginMeta, env: GroveMetaEnvelope): ReactNode {
  if (meta.display === "hidden") return null;
  const badge = meta.badge && (
    <span className="text-[10px] font-semibold" style={{ color: META_TONE[meta.badge.tone] }}>{meta.badge.text}</span>
  );
  if (meta.display === "pill") {
    return (
      <span
        className="mx-0.5 inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]"
        style={{ borderColor: "var(--color-border)", color: "var(--color-text)" }}
        title={`${meta.pluginName}: ${env.systemPrompt}`}
      >
        {meta.icon}<span>{meta.title}</span>{badge}
      </span>
    );
  }
  return (
    <div
      className="mb-2 max-w-md rounded-lg border px-3 py-2 text-xs"
      style={{ borderColor: "var(--color-border)", background: "var(--color-bg-secondary)", color: "var(--color-text)" }}
      title={env.systemPrompt}
    >
      <div className="flex items-center gap-1.5 font-medium">
        {meta.icon && <span>{meta.icon}</span>}<span className="min-w-0 truncate">{meta.title}</span>{badge}
      </div>
      {meta.subtitle && <div className="mt-0.5" style={{ color: "var(--color-text-secondary)" }}>{meta.subtitle}</div>}
      {meta.fields.length > 0 && (
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {meta.fields.map((field) => (
            <div key={field.label} className="contents">
              <dt style={{ color: "var(--color-text-muted)" }}>{field.label}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {meta.pluginName && <div className="mt-1.5 text-[10px]" style={{ color: "var(--color-text-muted)" }}>{meta.pluginName}</div>}
    </div>
  );
}

export const GROVE_META_RENDERERS: Record<string, Renderer> = {
  grove_session_init: () => null,
  mention_spawn: (env) => renderMentionSpawn(env),
  mention_send: (env) => renderMentionSend(env),
  mention_reply: (env) => renderMentionReply(env),
  agent_inject_send: (env) => renderAgentInjectBadge(env, "send"),
  agent_inject_reply: (env) => renderAgentInjectBadge(env, "reply"),
  user_remind: (env) => renderUserRemindBadge(env),
  buddy_message: () => null,
  buddy_mentions: () => null,
  preview_comment: (env) => renderPreviewCommentCard(env),
  browser_tab: (env) => renderBrowserTab(env),
  review_comment: (env) => renderReviewCommentCard(env),
  plugin_inject: (env) => renderPluginInjectBadge(env),
};

/** Render an envelope, falling back to `systemPrompt` text on unknown type or
 *  renderer failure. */
export function renderGroveMetaEnvelope(
  envelope: GroveMetaEnvelope,
  ctx: RenderContext,
): ReactNode {
  if (envelope.v !== 1) return envelope.systemPrompt;
  if (envelope.type.startsWith("plugin:")) {
    const meta = resolvePluginMeta(envelope);
    return meta ? renderPluginMeta(meta, envelope) : envelope.systemPrompt;
  }
  const renderer = GROVE_META_RENDERERS[envelope.type];
  if (!renderer) return envelope.systemPrompt;
  try {
    return renderer(envelope, ctx);
  } catch {
    return envelope.systemPrompt;
  }
}
