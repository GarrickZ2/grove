import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  useDeferredValue,
  memo,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  MessageSquare,
  MessageSquarePlus,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Maximize2,
  Minimize2,
  Send,
  Loader2,
  CheckCircle2,
  Circle,
  Brain,
  ListTodo,
  Slash,
  X,
  ShieldCheck,
  ShieldX,
  AlertTriangle,
  Plus,
  ListPlus,
  Trash2,
  Pencil,
  Square,
  Paperclip,
  Mic,
  Bot,
  Globe,
  Terminal,
  Eye,
  BookOpen,
  ArrowDown,
  Sparkles,
  Plug,
  Wrench,
  ChevronUp,
  ExternalLink,
  Bookmark,
  Search,
  User,
} from "lucide-react";
import {
  Button,
  ImageLightbox,
  MarkdownRenderer,
  VSCodeIcon,
  agentOptions,
  FileMentionDropdown,
} from "../../ui";
import {
  buildMentionItems,
  buildStudioMentionItems,
  filterMentionItems,
  buildAgentMentionItems,
} from "../../../utils/fileMention";
import type { MentionItem } from "../../../utils/fileMention";
import { getMentionCandidates } from "../../../api";
import { useProject } from "../../../context/ProjectContext";
import { useConfig } from "../../../context/ConfigContext";
import { usePreviewComments, type PreviewCommentDraft } from "../../../context";
import { PreviewSearchBar } from "../../Review/PreviewSearchBar";
import { useDomSearch } from "../../Review/useDomSearch";
import { listSketches, type SketchMeta } from "../../../api/sketches";
import { readLastActiveTab, writeLastActiveTab } from "../../../utils/lastActiveTab";
import type { Task } from "../../../data/types";
import { getApiHost, appendHmacToUrl } from "../../../api/client";
import { useAgentQuota, useRadioEvents } from "../../../hooks";
import { AgentQuotaPopover } from "./AgentQuotaPopover";
import { quotaBadgePercent, quotaHealthColor } from "./quotaColors";
import {
  getConfig,
  listChats,
  createChat,
  updateChatTitle,
  deleteChat,
  uploadChatAttachment,
  getTaskFiles,
  checkCommands,
  getChatHistory,
  takeControl,
  readFile,
  updateNotes,
} from "../../../api";
import type { ChatSessionResponse, CustomAgent } from "../../../api";
import { openExternalUrl } from "../../../utils/openExternal";
import "./task-chat.css";

// ─── Types ───────────────────────────────────────────────────────────────────

interface TaskChatProps {
  projectId: string;
  task: Task;
  collapsed?: boolean;
  onExpand?: () => void;
  onCollapse?: () => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
  hideHeader?: boolean;
  /** Navigate to a file (optionally at a line) in the Review panel */
  onNavigateToFile?: (
    filePath: string,
    line?: number,
    mode?: "diff" | "full",
  ) => void;
  /** Called when chat transitions from busy to idle (work completed) */
  onChatBecameIdle?: () => void;
  /** Called when the user successfully sends a message */
  onUserMessageSent?: () => void;
  /** Called when busy state changes (true = agent working, false = idle) */
  onBusyStateChange?: (busy: boolean) => void;
}

type ToolMessage = {
  type: "tool";
  id: string;
  title: string;
  status: string;
  content?: string;
  collapsed: boolean;
  locations?: { path: string; line?: number }[];
};

interface PermOption {
  option_id: string;
  name: string;
  kind: string; // "allow_once" | "allow_always" | "reject_once" | "reject_always"
}

type PermissionMessage = {
  type: "permission";
  /** Server-assigned id (ACP tool_call_id). Empty for legacy events. */
  id: string;
  description: string;
  options: PermOption[];
  resolved?: string; // selected option name when resolved
};

interface Attachment {
  type: "image" | "audio" | "resource";
  data: string; // base64 for image/audio
  mimeType: string;
  name: string; // original filename
  label: string; // display label e.g. "Image #1", "Audio #2", "File #3"
  previewUrl?: string; // blob URL for image preview
  uri?: string;
  size?: number;
  /** Raw file pending upload — upload is deferred until the prompt is sent */
  pendingFile?: File;
}

type ChatMessage =
  | {
      type: "user";
      content: string;
      sender?: string;
      attachments?: Attachment[];
      terminal?: boolean;
    }
  | { type: "assistant"; content: string; complete: boolean }
  | { type: "thinking"; content: string; collapsed: boolean; complete: boolean }
  | ToolMessage
  | { type: "system"; content: string }
  | PermissionMessage
  | { type: "terminal_output"; chunks: string[]; exitCode?: number | null };

type ServerEvent = {
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

interface PlanEntry {
  content: string;
  status: string;
}

interface SlashCommand {
  name: string;
  description: string;
  input_hint?: string;
}

interface PromptCaps {
  image: boolean;
  audio: boolean;
  embeddedContext: boolean;
}

type TitleEditSurface = "header" | "sidebar-header" | "sidebar-list";

const AGENT_PICKER_MENU_WIDTH = 192;
const AGENT_PICKER_MENU_MAX_HEIGHT = 256;
const AGENT_PICKER_VIEWPORT_MARGIN = 8;

/** Per-chat cached state (preserved across chat switches) */
interface PerChatState {
  messages: ChatMessage[];
  hiddenMessageCount: number;
  attachmentCounters: AttachmentCounters;
  isBusy: boolean;
  selectedModel: string;
  permissionLevel: string;
  modelOptions: { label: string; value: string }[];
  modeOptions: { label: string; value: string }[];
  /** Thought-level / reasoning-effort selector (0.11 SessionConfigOption) */
  thoughtLevelOptions: { label: string; value: string }[];
  thoughtLevel: string;
  thoughtLevelConfigId: string;
  planEntries: PlanEntry[];
  slashCommands: SlashCommand[];
  isConnected: boolean;
  agentLabel: string;
  agentIcon: React.ComponentType<{ size?: number; className?: string }> | null;
  promptCaps: PromptCaps;
  planFilePath: string;
  planFileContent: string;
  isRemoteSession: boolean;
  remoteOwnerName: string;
  /** Unsent composer draft — innerHTML of the contentEditable input,
   * preserves text plus any slash/file chips. Restored on chat switch so a
   * half-typed message isn't lost when the user peeks at another chat. */
  draftHtml: string;
}

function defaultPerChatState(): PerChatState {
  return {
    messages: [],
    hiddenMessageCount: 0,
    attachmentCounters: { image: 0, audio: 0, resource: 0 },
    isBusy: false,
    selectedModel: "",
    permissionLevel: "",
    modelOptions: [],
    modeOptions: [],
    thoughtLevelOptions: [],
    thoughtLevel: "",
    thoughtLevelConfigId: "",
    planEntries: [],
    slashCommands: [],
    isConnected: false,
    agentLabel: "Chat",
    agentIcon: null,
    isRemoteSession: false,
    remoteOwnerName: "",
    promptCaps: { image: false, audio: false, embeddedContext: false },
    planFilePath: "",
    planFileContent: "",
    draftHtml: "",
  };
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.split(",")[1] ?? "");
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

// ─── Render grouping types ───────────────────────────────────────────────────

type ToolSectionItem = { message: ToolMessage; index: number };
type RenderItem =
  | { kind: "single"; message: ChatMessage; index: number }
  | { kind: "tool-section"; sectionId: string; tools: ToolSectionItem[] };

/** Group consecutive tool messages into sections; everything else is a single item */
function buildRenderItems(messages: ChatMessage[]): RenderItem[] {
  const items: RenderItem[] = [];
  let toolBuf: ToolSectionItem[] = [];

  const flush = () => {
    if (toolBuf.length > 0) {
      items.push({
        kind: "tool-section",
        sectionId: toolBuf[0].message.id,
        tools: [...toolBuf],
      });
      toolBuf = [];
    }
  };

  messages.forEach((msg, i) => {
    if (msg.type === "tool") {
      toolBuf.push({ message: msg, index: i });
    } else {
      flush();
      items.push({ kind: "single", message: msg, index: i });
    }
  });
  flush();
  return items;
}

function getAutoScrollTailSignature(messages: ChatMessage[]): string {
  const tail = messages.slice(-2);
  return tail
    .map((message) => {
      switch (message.type) {
        case "assistant":
          return `assistant:${message.complete ? 1 : 0}:${message.content.length}`;
        case "thinking":
          return `thinking:${message.complete ? 1 : 0}:${message.content.length}`;
        case "tool":
          return `tool:${message.id}:${message.status}:${(message.content ?? "").length}`;
        case "system":
          return `system:${message.content.length}`;
        case "permission":
          return `permission:${message.description}:${message.resolved ?? ""}`;
        case "terminal_output":
          return `terminal_output:${message.exitCode ?? ""}:${message.chunks.length}:${message.chunks.reduce((s, c) => s + c.length, 0)}`;
        case "user":
          return `user:${message.content.length}:${message.attachments?.length ?? 0}:${message.terminal ? 1 : 0}`;
      }
    })
    .join("|");
}

/** Per-type attachment counters. Initialized once from history on chat switch,
 *  then incremented cheaply on each new attachment. */
interface AttachmentCounters {
  image: number;
  audio: number;
  resource: number;
}

function buildAttachmentCounters(messages: ChatMessage[]): AttachmentCounters {
  const counters: AttachmentCounters = { image: 0, audio: 0, resource: 0 };
  for (const msg of messages) {
    if (msg.type === "user" && msg.attachments) {
      for (const att of msg.attachments) {
        counters[att.type]++;
      }
    }
  }
  return counters;
}

function attachmentLabel(type: "image" | "audio" | "resource", index: number): string {
  const prefix = type === "image" ? "Image" : type === "audio" ? "Audio" : "File";
  return `${prefix} #${index}`;
}

function formatPreviewCommentPrompt(comments: PreviewCommentDraft[]): string {
  const lines = [
    "Please address these preview comments. Each comment points to a rendered preview element and includes locator details from the preview DOM.",
    "",
  ];

  for (const [idx, draft] of comments.entries()) {
    lines.push(`${idx + 1}. ${draft.filePath}`);
    lines.push(`   Source: ${draft.source}`);
    lines.push(`   Renderer: ${draft.rendererId}`);
    lines.push(`   Element: ${draft.locator.tagName}${draft.locator.id ? `#${draft.locator.id}` : ""}${draft.locator.className ? `.${draft.locator.className.split(/\s+/).slice(0, 3).join(".")}` : ""}`);
    if (draft.locator.selector) lines.push(`   CSS selector: ${draft.locator.selector}`);
    if (draft.locator.xpath) lines.push(`   XPath: ${draft.locator.xpath}`);
    if (draft.locator.text) lines.push(`   Visible text: ${draft.locator.text}`);
    if (draft.locator.html) lines.push(`   HTML snippet: ${draft.locator.html}`);
    lines.push(`   Comment: ${draft.comment}`);
    lines.push("");
  }

  return lines.join("\n").trim();
}

/** Mark all incomplete thinking messages as complete and auto-collapse them */
/**
 * Merge locations from a tool_call/tool_call_update into existing ones,
 * de-duped by (path, line). Preserves insertion order so early-discovered
 * locations stay on top.
 */
function mergeLocations(
  existing: { path: string; line?: number }[] | undefined,
  incoming: { path: string; line?: number }[] | undefined,
): { path: string; line?: number }[] | undefined {
  if (!incoming || incoming.length === 0) return existing;
  const base = existing ?? [];
  const out = [...base];
  for (const loc of incoming) {
    if (!out.some((e) => e.path === loc.path && e.line === loc.line)) {
      out.push(loc);
    }
  }
  return out;
}

function completeThinking(messages: ChatMessage[]): ChatMessage[] {
  let changed = false;
  const result = messages.map((m) => {
    if (m.type === "thinking" && !m.complete) {
      changed = true;
      return { ...m, complete: true, collapsed: true };
    }
    return m;
  });
  return changed ? result : messages;
}

function appendSystemMessage(
  messages: ChatMessage[],
  content: string,
): ChatMessage[] {
  const last = messages[messages.length - 1];
  if (last?.type === "system" && last.content === content) return messages;
  return [...messages, { type: "system", content }];
}

type ChatRenderWindowSettings = {
  limit: number;
  trigger: number;
};

function normalizeChatRenderWindowSettings(
  limit?: number,
  trigger?: number,
): ChatRenderWindowSettings {
  const normalizedLimit = Number.isFinite(limit)
    ? Math.max(0, Math.floor(limit ?? 0))
    : 0;
  const normalizedTrigger = Number.isFinite(trigger)
    ? Math.max(0, Math.floor(trigger ?? 0))
    : 0;

  if (normalizedLimit === 0) {
    return {
      limit: 0,
      trigger: normalizedTrigger || 1500,
    };
  }

  return {
    limit: normalizedLimit,
    trigger:
      normalizedTrigger > normalizedLimit
        ? normalizedTrigger
        : normalizedLimit + 500,
  };
}

function pruneChatViewMessages(
  messages: ChatMessage[],
  hiddenMessageCount: number,
  settings: ChatRenderWindowSettings,
): { messages: ChatMessage[]; hiddenMessageCount: number; pruned: boolean } {
  if (
    settings.limit <= 0 ||
    settings.trigger <= settings.limit ||
    messages.length < settings.trigger
  ) {
    return { messages, hiddenMessageCount, pruned: false };
  }

  const removeCount = messages.length - settings.limit;
  if (removeCount <= 0) {
    return { messages, hiddenMessageCount, pruned: false };
  }

  return {
    messages: messages.slice(removeCount),
    hiddenMessageCount: hiddenMessageCount + removeCount,
    pruned: true,
  };
}

function buildDefaultSessionTitle() {
  const now = new Date();
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `New Session ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function OverflowTitle({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [shift, setShift] = useState(0);

  const measure = useCallback(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;
    const overflow = Math.max(0, content.scrollWidth - container.clientWidth);
    setShift(overflow);
  }, []);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") {
      measure();
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }

    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;

    const observer = new ResizeObserver(() => {
      measure();
    });

    measure();
    observer.observe(container);
    observer.observe(content);
    return () => observer.disconnect();
  }, [measure, text]);

  const shouldAnimate = hovered && shift > 8;
  const style: (CSSProperties & { "--overflow-shift"?: string }) | undefined =
    shouldAnimate ? { "--overflow-shift": `-${shift}px` } : undefined;

  return (
    <div
      ref={containerRef}
      className={`overflow-hidden whitespace-nowrap ${className}`}
      title={text}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        ref={contentRef}
        style={style}
        className={
          shouldAnimate
            ? "overflow-title-animate inline-block whitespace-nowrap"
            : "truncate"
        }
      >
        {text}
      </div>
    </div>
  );
}

function InlineEditTitle({
  value,
  onChange,
  onSave,
  onCancel,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  className: string;
}) {
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onSave}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === "Enter") onSave();
        if (e.key === "Escape") onCancel();
      }}
      className={className}
    />
  );
}

function resolveLatestPendingPermission(
  messages: ChatMessage[],
  optionId: string,
  fallbackResolvedName: string,
  /**
   * Request id (ACP tool_call_id). When present, exactly target the matching
   * permission so concurrent / out-of-order responses can't accidentally close
   * an unrelated dialog. Falls back to FIFO matching when empty (legacy
   * history events without ids).
   */
  requestId?: string,
): ChatMessage[] {
  let targetIndex = -1;

  if (requestId) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.type !== "permission" || message.resolved) continue;
      if (message.id === requestId) {
        targetIndex = i;
        break;
      }
    }
    if (targetIndex === -1) return messages;
  } else {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.type !== "permission" || message.resolved) continue;
      if (message.options.some((option) => option.option_id === optionId)) {
        targetIndex = i;
        break;
      }
      if (targetIndex === -1) {
        targetIndex = i;
      }
    }
  }

  if (targetIndex === -1) {
    return messages;
  }

  return messages.map((message, index) =>
    index === targetIndex && message.type === "permission"
      ? {
          ...message,
          resolved:
            message.options.find((option) => option.option_id === optionId)
              ?.name ?? fallbackResolvedName,
        }
      : message,
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create a non-editable command chip DOM element */
function createCommandChip(name: string): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.command = name;
  chip.style.cssText =
    "display:inline-flex;align-items:center;gap:4px;padding:1px 6px;border-radius:4px;" +
    "background:color-mix(in srgb,var(--color-highlight) 15%,transparent);" +
    "border:1px solid color-mix(in srgb,var(--color-highlight) 30%,transparent);" +
    "font-size:12px;font-weight:500;color:var(--color-highlight);" +
    "margin:0 2px;user-select:none;vertical-align:baseline;line-height:1.5;";

  const label = document.createElement("span");
  label.textContent = `/${name}`;
  chip.appendChild(label);

  const closeBtn = document.createElement("span");
  closeBtn.dataset.chipClose = "true";
  closeBtn.textContent = "\u00d7";
  closeBtn.style.cssText =
    "margin-left:2px;cursor:pointer;opacity:0.6;font-size:13px;line-height:1;";
  chip.appendChild(closeBtn);

  return chip;
}

/** Create a non-editable file chip DOM element */
function createFileChip(
  filePath: string,
  isDir = false,
  displayLabel?: string,
  category?: string,
): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.file = filePath;
  if (displayLabel) chip.dataset.label = displayLabel;
  if (category) chip.dataset.category = category;
  chip.title = filePath;
  chip.style.cssText =
    "display:inline-flex;align-items:center;gap:4px;padding:1px 6px;border-radius:4px;" +
    "background:color-mix(in srgb,var(--color-warning) 15%,transparent);" +
    "border:1px solid color-mix(in srgb,var(--color-warning) 30%,transparent);" +
    "font-size:12px;font-weight:500;color:var(--color-warning);" +
    "margin:0 2px;user-select:none;vertical-align:baseline;line-height:1.5;";

  const isLink = filePath.toLowerCase().endsWith(".link.json");
  // Icon (Link / Folder / File)
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("width", "12");
  icon.setAttribute("height", "12");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.style.cssText = "flex-shrink:0;";
  if (isLink) {
    // Lucide Link icon (two connected chain segments)
    const p1 = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p1.setAttribute(
      "d",
      "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
    );
    const p2 = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p2.setAttribute(
      "d",
      "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
    );
    icon.appendChild(p1);
    icon.appendChild(p2);
  } else if (isDir) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
    );
    icon.appendChild(path);
  } else {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",
    );
    const poly = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "polyline",
    );
    poly.setAttribute("points", "14 2 14 8 20 8");
    icon.appendChild(path);
    icon.appendChild(poly);
  }
  chip.appendChild(icon);

  const label = document.createElement("span");
  if (displayLabel) {
    label.textContent = displayLabel;
  } else {
    label.textContent = isDir ? filePath : filePath.split("/").pop() || filePath;
  }
  chip.appendChild(label);

  const closeBtn = document.createElement("span");
  closeBtn.dataset.chipClose = "true";
  closeBtn.textContent = "\u00d7";
  closeBtn.style.cssText =
    "margin-left:2px;cursor:pointer;opacity:0.6;font-size:13px;line-height:1;";
  chip.appendChild(closeBtn);

  return chip;
}

/**
 * Create an agent-graph @-mention pill. Three kinds, all rendered as a single
 * non-editable inline atom. Metadata is stored on dataset attrs and consumed
 * by `getPromptFromEditable` at send time to expand into the spec §6 template
 * string.
 */
function createAgentMentionChip(item: MentionItem): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.mentionKind = item.kind ?? "file";
  // Per-kind metadata; absent fields are simply not serialized.
  if (item.sessionId) chip.dataset.sessionId = item.sessionId;
  if (item.msgId) chip.dataset.msgId = item.msgId;
  if (item.duty != null) chip.dataset.duty = item.duty;
  if (item.agentName) chip.dataset.agentName = item.agentName;
  if (item.displayName) chip.dataset.displayName = item.displayName;

  const isPending = item.kind === "agent_reply";
  const accent = isPending
    ? "var(--color-error, #ef4444)"
    : "var(--color-accent, var(--color-highlight))";
  chip.style.cssText =
    "display:inline-flex;align-items:center;gap:4px;padding:1px 6px;border-radius:4px;" +
    `background:color-mix(in srgb,${accent} 15%,transparent);` +
    `border:1px solid color-mix(in srgb,${accent} 35%,transparent);` +
    `font-size:12px;font-weight:500;color:${accent};` +
    "margin:0 2px;user-select:none;vertical-align:baseline;line-height:1.5;";
  if (item.kind === "agent_send" && item.duty) {
    chip.title = `${item.displayName ?? ""} — ${item.duty}`;
  }

  const label = document.createElement("span");
  const name = item.displayName ?? item.agentName ?? "";
  label.textContent = isPending ? `@${name} ⚠` : `@${name}`;
  chip.appendChild(label);

  const closeBtn = document.createElement("span");
  closeBtn.dataset.chipClose = "true";
  closeBtn.textContent = "×";
  closeBtn.style.cssText =
    "margin-left:2px;cursor:pointer;opacity:0.6;font-size:13px;line-height:1;";
  chip.appendChild(closeBtn);

  return chip;
}

/**
 * Expand an agent-graph @-mention chip into the spec §6 template string. The
 * resulting text is what the AI receiving the prompt sees — Grove never calls
 * the underlying `grove_agent_*` tools itself; the AI decides whether to.
 */
function expandAgentMentionChip(node: HTMLElement): string {
  const kind = node.dataset.mentionKind;
  if (kind === "agent_spawn") {
    const agent = node.dataset.agentName ?? node.dataset.displayName ?? "";
    return `@[agent=${agent} · use grove_agent_spawn to create a Session, then grove_agent_send to dispatch]`;
  }
  if (kind === "agent_send") {
    const id = node.dataset.sessionId ?? "";
    const name = node.dataset.displayName ?? "";
    const duty = node.dataset.duty ?? "";
    return `@[session id=${id}, name=${name}, duty="${duty}" · use grove_agent_send(to="${id}") to dispatch]`;
  }
  if (kind === "agent_reply") {
    const id = node.dataset.sessionId ?? "";
    const name = node.dataset.displayName ?? "";
    const msg = node.dataset.msgId ?? "";
    return `@[session id=${id}, name=${name}, pending_msg=${msg} · use grove_agent_reply(msg_id="${msg}") to respond]`;
  }
  return "";
}

/** Extract prompt text from a contentEditable element, converting chips to /command */
function getPromptFromEditable(el: HTMLElement): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent || "");
    } else if (node instanceof HTMLElement) {
      if (node.dataset.mentionKind && node.dataset.mentionKind !== "file") {
        parts.push(expandAgentMentionChip(node));
      } else if (node.dataset.command) {
        parts.push(`/${node.dataset.command}`);
      } else if (node.dataset.ref) {
        parts.push(`[${node.dataset.ref}]`);
      } else if (node.dataset.file) {
        // Studio-categorized chips carry a friendly label separate from the
        // raw path — serialize as "Name(path)" so both the reader and the
        // agent see what the chip means. Fall back to the bare path for
        // ordinary file mentions.
        const file = node.dataset.file;
        const lbl = node.dataset.label;
        parts.push(lbl && lbl !== file ? `${lbl}(${file})` : file);
      } else if (node.tagName === "BR") {
        parts.push("\n");
      } else if (node.tagName === "DIV" || node.tagName === "P") {
        if (parts.length > 0 && parts[parts.length - 1] !== "\n")
          parts.push("\n");
        node.childNodes.forEach(walk);
      } else {
        node.childNodes.forEach(walk);
      }
    }
  };
  el.childNodes.forEach(walk);
  return parts.join("").trim();
}

function reduceHistoryMessages(
  messages: ChatMessage[],
  msg: ServerEvent,
): ChatMessage[] {
  switch (msg.type) {
    case "message_chunk": {
      const prev = completeThinking(messages);
      for (let i = prev.length - 1; i >= 0; i -= 1) {
        const m = prev[i];
        if (m.type === "assistant" && !m.complete) {
          const updated = [...prev];
          updated[i] = { ...m, content: m.content + msg.text };
          return updated;
        }
        if (m.type === "user" || m.type === "tool") break;
      }
      if (!msg.text?.trim()) return prev;
      return [
        ...prev,
        { type: "assistant", content: msg.text, complete: false },
      ];
    }
    case "thought_chunk": {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (m.type === "thinking") {
          const updated = [...messages];
          updated[i] = { ...m, content: m.content + msg.text };
          return updated;
        }
        if (m.type === "user" || m.type === "assistant") break;
      }
      return [
        ...messages,
        {
          type: "thinking",
          content: msg.text,
          collapsed: false,
          complete: false,
        },
      ];
    }
    case "tool_call": {
      const prev = completeThinking(messages);
      if (prev.some((m) => m.type === "tool" && m.id === msg.id)) {
        return prev.map((m) =>
          m.type === "tool" && m.id === msg.id
            ? {
                ...m,
                title: msg.title,
                // locations 按增量合并，按 (path,line) 去重保序
                locations: mergeLocations(m.locations, msg.locations),
              }
            : m,
        );
      }
      const completed = prev.map((m) =>
        m.type === "assistant" && !m.complete ? { ...m, complete: true } : m,
      );
      return [
        ...completed,
        {
          type: "tool",
          id: msg.id,
          title: msg.title,
          status: "running",
          collapsed: false,
          locations: msg.locations,
        },
      ];
    }
    case "tool_call_update": {
      // 按 ACP 规范，每条 tool_call_update 的 content 是增量内容，应在已有
      // content 上追加（去重），而不是覆盖。覆盖会让早期的命令/进度被最终
      // 的结果/错误挤掉。
      const mergeContent = (
        prev: string | undefined,
        next: string | undefined,
      ): string | undefined => {
        if (!next) return prev;
        if (!prev) return next;
        // 见后端 compact_events 同名逻辑：三种 agent 行为
        //   1. 纯增量（next 是 delta）→ 拼接
        //   2. 累积快照（next 以 prev 为前缀）→ 用 next 替换，避免 O(n²)
        //   3. 重复广播（next 已包含在 prev 中）→ 跳过
        if (prev.includes(next)) return prev;
        if (next.startsWith(prev)) return next;
        return prev.endsWith("\n") ? prev + next : prev + "\n" + next;
      };
      const exists = messages.some((m) => m.type === "tool" && m.id === msg.id);
      if (exists) {
        return messages.map((m) =>
          m.type === "tool" && m.id === msg.id
            ? {
                ...m,
                status: msg.status,
                content: mergeContent(m.content, msg.content),
                locations: mergeLocations(m.locations, msg.locations),
              }
            : m,
        );
      }
      return [
        ...messages,
        {
          type: "tool",
          id: msg.id,
          title: msg.id,
          status: msg.status,
          content: msg.content,
          collapsed: true,
          locations: msg.locations ?? [],
        },
      ];
    }
    case "permission_request":
      return [
        ...messages,
        {
          type: "permission",
          id: typeof msg.id === "string" ? msg.id : "",
          description: msg.description,
          options: msg.options ?? [],
        },
      ];
    case "permission_response":
      return resolveLatestPendingPermission(
        messages,
        msg.option_id,
        msg.option_id,
        typeof msg.id === "string" ? msg.id : undefined,
      );
    case "complete": {
      const completed = completeThinking(messages);
      return completed.map((m) =>
        m.type === "assistant" && !m.complete ? { ...m, complete: true } : m,
      );
    }
    case "user_message":
      return [
        ...messages,
        {
          type: "user",
          content: msg.text,
          terminal: !!msg.terminal,
          sender: msg.sender || undefined,
          attachments: msg.attachments?.map((a: ServerEvent) => ({
            type:
              a.type === "resource_link"
                ? "resource"
                : (a.type as "image" | "audio" | "resource"),
            data: a.data ?? "",
            mimeType: a.mime_type ?? "",
            name: a.name ?? "",
            label: a.label ?? a.name ?? "",
            uri: a.uri ?? undefined,
            size: a.size ?? undefined,
            previewUrl:
              a.type === "image"
                ? `data:${a.mime_type};base64,${a.data}`
                : undefined,
          })),
        },
      ];
    case "terminal_execute":
      return [
        ...messages,
        { type: "user", content: msg.command, terminal: true },
        { type: "terminal_output", chunks: [], exitCode: undefined },
      ];
    case "terminal_chunk": {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].type === "terminal_output") {
          const updated = [...messages];
          const terminalMessage = messages[i] as {
            type: "terminal_output";
            chunks: string[];
            exitCode?: number | null;
          };
          updated[i] = {
            ...terminalMessage,
            chunks: [...terminalMessage.chunks, msg.output],
          };
          return updated;
        }
      }
      return [...messages, { type: "terminal_output", chunks: [msg.output] }];
    }
    case "terminal_complete": {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].type === "terminal_output") {
          const updated = [...messages];
          const terminalMessage = messages[i] as {
            type: "terminal_output";
            chunks: string[];
            exitCode?: number | null;
          };
          updated[i] = { ...terminalMessage, exitCode: msg.exit_code ?? 0 };
          return updated;
        }
      }
      return messages;
    }
    default:
      return messages;
  }
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function TaskChat({
  projectId,
  task,
  collapsed = false,
  onExpand,
  onCollapse,
  onConnected: onConnectedProp,
  onDisconnected: onDisconnectedProp,
  fullscreen = false,
  onToggleFullscreen,
  hideHeader = false,
  onNavigateToFile,
  onChatBecameIdle,
  onUserMessageSent,
  onBusyStateChange,
}: TaskChatProps) {
  const sessionModeStorageKey = `taskchat:session-mode:${projectId}`;
  // ─── Multi-chat state ───────────────────────────────────────────────────
  const [chats, setChats] = useState<ChatSessionResponse[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [showChatMenu, setShowChatMenu] = useState(false);
  const [editingTitle, setEditingTitle] = useState<{
    chatId: string;
    surface: TitleEditSurface;
  } | null>(null);
  const [editTitleValue, setEditTitleValue] = useState("");
  const chatMenuRef = useRef<HTMLDivElement>(null);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [acpAgentAvailability, setAcpAgentAvailability] = useState<
    Record<string, boolean>
  >({});
  const [acpAvailabilityLoaded, setAcpAvailabilityLoaded] = useState(false);
  const [customAgents, setCustomAgents] = useState<CustomAgent[]>([]);
  const headerAgentPickerRef = useRef<HTMLDivElement>(null);
  const sidebarAgentPickerRef = useRef<HTMLDivElement>(null);
  const agentPickerMenuRef = useRef<HTMLDivElement>(null);
  const [agentPickerAnchor, setAgentPickerAnchor] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const showAgentPickerRef = useRef(false);
  const [sessionRailCollapsed, setSessionRailCollapsed] = useState<boolean>(
    () => {
      if (typeof window === "undefined") return true;
      return window.localStorage.getItem(sessionModeStorageKey) !== "sidebar";
    },
  );

  // Per-chat state cache (preserved across chat switches)
  const perChatStateRef = useRef<Map<string, PerChatState>>(new Map());
  // Per-chat WebSocket connections
  const wsMapRef = useRef<Map<string, WebSocket>>(new Map());
  // Track intentionally closed WebSockets (don't auto-reconnect these)
  const intentionalCloseRef = useRef<Set<string>>(new Set());
  // Track in-flight connection attempts to prevent async TOCTOU race
  const connectingRef = useRef<Set<string>>(new Set());

  // ─── Active chat's live state ─────────────────────────────────────────
  const [isConnected, setIsConnected] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hiddenMessageCount, setHiddenMessageCount] = useState(0);
  const hiddenMessageCountRef = useRef(0);
  const [hasContent, setHasContent] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const busyRef = useRef(false);
  const updateBusy = useCallback((value: boolean) => {
    busyRef.current = value;
    setIsBusy(value);
    onBusyStateChange?.(value);
  }, [onBusyStateChange]);
  const terminalRunningRef = useRef(false);
  const composingRef = useRef(false);
  const [selectedModel, setSelectedModel] = useState("");
  const [permissionLevel, setPermissionLevel] = useState("");
  const [modelOptions, setModelOptions] = useState<
    { label: string; value: string }[]
  >([]);
  const [modeOptions, setModeOptions] = useState<
    { label: string; value: string }[]
  >([]);
  const [thoughtLevel, setThoughtLevel] = useState("");
  const [thoughtLevelConfigId, setThoughtLevelConfigId] = useState("");
  const [thoughtLevelOptions, setThoughtLevelOptions] = useState<
    { label: string; value: string }[]
  >([]);
  const [showThoughtLevelMenu, setShowThoughtLevelMenu] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showPermMenu, setShowPermMenu] = useState(false);
  const [planEntries, setPlanEntries] = useState<PlanEntry[]>([]);
  const [showPlan, setShowPlan] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [lightboxSvg, setLightboxSvg] = useState<string | null>(null);
  const [planFilePath, setPlanFilePath] = useState("");
  const [planFileContent, setPlanFileContent] = useState("");
  const [showPlanFile, setShowPlanFile] = useState(false);
  const [showPermissionPanel, setShowPermissionPanel] = useState(false);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashSelectedIdx, setSlashSelectedIdx] = useState(0);
  const [isTerminalMode, setIsTerminalMode] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(),
  );
  // The sectionId of the currently auto-expanded tool section (null = none)
  // Set on tool_call, cleared on message_chunk or complete
  const [, setAutoExpandSectionId] = useState<string | null>(null);
  const [pendingMessages, setPendingMessages] = useState<string[]>([]);
  const [showPendingQueue, setShowPendingQueue] = useState(true);
  const [editingPendingIdx, setEditingPendingIdx] = useState<number | null>(
    null,
  );
  const [editingPendingValue, setEditingPendingValue] = useState("");
  const [agentLabel, setAgentLabel] = useState("Chat");
  const [AgentIcon, setAgentIcon] = useState<React.ComponentType<{
    size?: number;
    className?: string;
  }> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesViewportRef = useRef<HTMLDivElement>(null);
  const editableRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const permMenuRef = useRef<HTMLDivElement>(null);
  const thoughtLevelMenuRef = useRef<HTMLDivElement>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const slashItemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [taskFiles, setTaskFiles] = useState<string[]>([]);
  const [sketchMeta, setSketchMeta] = useState<SketchMeta[]>([]);
  const taskFilesFetchTimeRef = useRef(0);
  const taskFilesLoadingRef = useRef(false);
  const { selectedProject } = useProject();
  const { config: appConfig } = useConfig();
  const { drafts: previewCommentDrafts, removeDraft: removePreviewCommentDraft, clearDrafts: clearPreviewCommentDrafts } = usePreviewComments();
  const isStudioProject = selectedProject?.projectType === "studio";
  const chatRenderWindowSettings = useMemo(
    () =>
      normalizeChatRenderWindowSettings(
        appConfig?.acp?.render_window_limit,
        appConfig?.acp?.render_window_trigger,
      ),
    [
      appConfig?.acp?.render_window_limit,
      appConfig?.acp?.render_window_trigger,
    ],
  );
  const updateHiddenMessageCount = useCallback((value: number) => {
    hiddenMessageCountRef.current = value;
    setHiddenMessageCount(value);
  }, []);
  const pruneActiveChatMessages = useCallback(
    (nextMessages: ChatMessage[]) => {
      const pruned = pruneChatViewMessages(
        nextMessages,
        hiddenMessageCountRef.current,
        chatRenderWindowSettings,
      );
      if (pruned.pruned) {
        updateHiddenMessageCount(pruned.hiddenMessageCount);
      }
      return pruned.messages;
    },
    [chatRenderWindowSettings, updateHiddenMessageCount],
  );
  const [showFileMenu, setShowFileMenu] = useState(false);
  const [fileFilter, setFileFilter] = useState("");
  const [fileSelectedIdx, setFileSelectedIdx] = useState(0);
  const fileMenuRef = useRef<HTMLDivElement>(null);
  // Agent-graph @-mention candidates (spawn / send / reply). Cohabits the
  // same `@` popover as file mentions — see `combinedMentionItems`.
  const [agentMentionItems, setAgentMentionItems] = useState<MentionItem[]>([]);
  const [promptCaps, setPromptCaps] = useState<PromptCaps>({
    image: false,
    audio: false,
    embeddedContext: false,
  });
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const attachCountersRef = useRef<AttachmentCounters>({ image: 0, audio: 0, resource: 0 });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isInputExpanded, setIsInputExpanded] = useState(false);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [showPreviewComments, setShowPreviewComments] = useState(false);
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const [chatSearchQuery, setChatSearchQuery] = useState("");
  const planFilePathRef = useRef("");
  const planFileToolIdsRef = useRef<Set<string>>(new Set());
  const autoStickToBottomRef = useRef(true);
  const suppressNextSmoothScrollRef = useRef(false);
  const messagesCountRef = useRef(messages.length);
  messagesCountRef.current = messages.length;
  const inputAreaRef = useRef<HTMLDivElement>(null);
  const chatboxContainerRef = useRef<HTMLDivElement>(null);
  const taskChatRootRef = useRef<HTMLDivElement>(null);
  // Composer width budget — when the chat panel is squeezed (e.g. opened
  // alongside a Graph / Editor split), drop the Model / Mode / Thinking
  // dropdowns so the Send button doesn't get clipped. Threshold is the
  // narrowest width at which all three pills + send still fit comfortably.
  const COMPOSER_OPTIONS_MIN_WIDTH = 420;
  const [composerNarrow, setComposerNarrow] = useState(false);

  // ─── Read-only observation mode state ──────────────────────────────────
  const [isRemoteSession, setIsRemoteSession] = useState(false);
  const [remoteOwnerName, setRemoteOwnerName] = useState("");
  const [isTakingControl, setIsTakingControl] = useState(false);
  const [isSavingToNote, setIsSavingToNote] = useState(false);
  const [saveToNoteDone, setSaveToNoteDone] = useState(false);
  const pollingOffsetRef = useRef(0);
  const pollingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Buffer WS events while HTTP history is loading to avoid race condition
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wsEventBufferRef = useRef<any[]>([]);
  const historyLoadingRef = useRef(false);

  const activeChat = chats.find((c) => c.id === activeChatId);
  // Quota for built-in AI coding agents (Claude Code / Codex / Gemini).
  // Unsupported agents return null, which hides the quota badge entirely.
  const {
    usage: agentQuota,
    refreshing: quotaRefreshing,
    refresh: refreshAgentQuota,
  } = useAgentQuota(activeChat?.agent ?? null, isBusy, selectedModel || undefined);
  const quotaBadgePercentRemaining = agentQuota
    ? quotaBadgePercent(agentQuota)
    : null;
  const orderedChats = useMemo(() => [...chats].reverse(), [chats]);
  const hasTodoPanel = planEntries.length > 0;
  const hasPlanPanel = !!planFileContent;
  const hasPendingPanel = pendingMessages.length > 0;
  const activePermissionMessage = useMemo(
    () =>
      [...messages]
        .reverse()
        .find(
          (m): m is PermissionMessage => m.type === "permission" && !m.resolved,
        ) ?? null,
    [messages],
  );
  const taskPreviewCommentDrafts = useMemo(
    () => previewCommentDrafts.filter((draft) => draft.projectId === projectId && draft.taskId === task.id),
    [previewCommentDrafts, projectId, task.id],
  );
  const hasPreviewCommentsPanel = taskPreviewCommentDrafts.length > 0;
  const activeComposerPanel =
    showPermissionPanel && activePermissionMessage
      ? "permission"
      : showPlan && hasTodoPanel
        ? "todo"
        : showPlanFile && hasPlanPanel
        ? "plan"
        : showPendingQueue && hasPendingPanel
          ? "pending"
          : showPreviewComments && hasPreviewCommentsPanel
            ? "previewComments"
            : null;
  const composerPanelOpen = activeComposerPanel !== null;

  useEffect(() => {
    if (activePermissionMessage) {
      setShowPermissionPanel(true);
      setShowPlan(false);
      setShowPlanFile(false);
      setShowPendingQueue(false);
      setShowPreviewComments(false);
    } else {
      setShowPermissionPanel(false);
    }
  }, [activePermissionMessage]);

  // Reset preview-comments toggle when drafts become empty — otherwise a
  // stale `true` reopens the panel next time a draft is added.
  useEffect(() => {
    if (!hasPreviewCommentsPanel && showPreviewComments) setShowPreviewComments(false);
  }, [hasPreviewCommentsPanel, showPreviewComments]);

  // ── Chat search (Cmd/Ctrl+F) ────────────────────────────────────────
  // Skip thinking blocks (data-grove-search-skip) and our own UI.
  const chatSearch = useDomSearch(messagesViewportRef, chatSearchOpen ? chatSearchQuery : "", chatSearchOpen);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "f" || !(e.metaKey || e.ctrlKey)) return;
      const root = taskChatRootRef.current;
      if (!root) return;
      const target = document.activeElement;
      if (!target || !root.contains(target)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      setChatSearchOpen((v) => !v);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);
  // Close search when switching chats
  useEffect(() => {
    setChatSearchOpen(false);
    setChatSearchQuery("");
  }, [activeChatId]);

  // Filtered slash commands based on current input — substring match on
  // command name only. Name-only avoids the old noise bug where matching
  // against description surfaced /review when the user typed /compact.
  // Substring (vs. prefix) gives middle-match support: `/view` finds
  // `/review`, `/plan` finds `/superpowers:write-plan`.
  // Defer the filter string so heavy filter+dropdown re-renders happen at
  // lower priority — keystrokes stay responsive while the dropdown catches up.
  const deferredSlashFilter = useDeferredValue(slashFilter);
  const filteredSlashCommands = useMemo(() => {
    if (!deferredSlashFilter) return slashCommands;
    const lower = deferredSlashFilter.toLowerCase();
    return slashCommands.filter((c) =>
      c.name.toLowerCase().includes(lower),
    );
  }, [slashCommands, deferredSlashFilter]);

  // Build mention items (files + directories) from flat file list
  const mentionItems = useMemo(
    () =>
      isStudioProject
        ? buildStudioMentionItems(taskFiles, sketchMeta)
        : buildMentionItems(taskFiles),
    [isStudioProject, taskFiles, sketchMeta],
  );

  // Combined `@` mention list — agent-graph candidates first (more salient
  // for inter-session work), then files. Single dropdown, single fuzzy
  // filter, three+ groups via `category`.
  const combinedMentionItems = useMemo(
    () => [...agentMentionItems, ...mentionItems],
    [agentMentionItems, mentionItems],
  );

  // Filtered files based on @ input. Defer the filter string so the fuzzy
  // match (O(n) over potentially thousands of files) runs at low priority and
  // doesn't block typing.
  const deferredFileFilter = useDeferredValue(fileFilter);
  const filteredFiles = useMemo(
    () => filterMentionItems(combinedMentionItems, deferredFileFilter),
    [combinedMentionItems, deferredFileFilter],
  );

  // Check ACP agent availability on mount
  useEffect(() => {
    const checkAvailability = async () => {
      try {
        const acpCheckCmds = new Set<string>();
        for (const opt of agentOptions) {
          if (opt.acpCheck) acpCheckCmds.add(opt.acpCheck);
        }
        const [cmdResults, cfg] = await Promise.all([
          checkCommands([...acpCheckCmds]),
          getConfig(),
        ]);
        setAcpAgentAvailability(cmdResults);
        setCustomAgents(cfg.acp?.custom_agents ?? []);
      } catch {
        /* fail-open */
      }
      setAcpAvailabilityLoaded(true);
    };
    checkAvailability();
  }, []);

  // Compute available ACP agent options
  const acpAgentOptions = useMemo(() => {
    return agentOptions
      .filter((opt) => opt.acpCheck)
      .map((opt) => {
        if (!acpAvailabilityLoaded) return opt;
        const cmd = opt.acpCheck!;
        if (acpAgentAvailability[cmd] === false) {
          return { ...opt, disabled: true, disabledReason: `${cmd} not found` };
        }
        return opt;
      });
  }, [acpAgentAvailability, acpAvailabilityLoaded]);

  const getChatIcon = (agentId: string) => {
    const builtin = agentOptions.find((option) => option.value === agentId);
    if (builtin?.icon) return builtin.icon;
    const custom = customAgents.find((agent) => agent.id === agentId);
    if (custom?.type === "remote") return Globe;
    if (custom) return Terminal;
    return MessageSquare;
  };

  // Resolve a message sender id ("user" | "agent:<chat_id>" | other) into a
  // human-readable label + an icon component. For agent-to-agent injects
  // (sender = "agent:<chat_id>") we look up the chat's title and agent kind
  // so the receiving panel shows e.g. "测试子 Session" with the codex icon
  // instead of the raw "agent:chat-0daa3a" + generic robot.
  const resolveSender = useCallback(
    (sender?: string): { label: string; Icon: React.ComponentType<{ size?: number; className?: string }> } => {
      if (!sender) return { label: "", Icon: Bot };
      if (sender === "user") return { label: "user", Icon: User };
      if (sender.startsWith("agent:")) {
        const chatId = sender.slice("agent:".length);
        const chat = chats.find((c) => c.id === chatId);
        if (chat) {
          return { label: chat.title, Icon: getChatIcon(chat.agent) };
        }
      }
      return { label: sender, Icon: Bot };
    },
    // getChatIcon closes over agentOptions (constant) + customAgents (state).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chats, customAgents],
  );

  // Resolve agent label and icon from active chat's agent
  useEffect(() => {
    const resolve = (cmd: string, customAgents?: CustomAgent[]) => {
      const match = agentOptions.find((a) => a.value === cmd);
      if (match) {
        setAgentLabel(match.label);
        if (match.icon) setAgentIcon(() => match.icon!);
      } else {
        // Check custom agents
        const custom = customAgents?.find((a) => a.id === cmd);
        if (custom) {
          setAgentLabel(custom.name);
        } else {
          setAgentLabel(cmd);
        }
      }
    };

    if (activeChat) {
      // Load config to get custom agents for resolution
      getConfig()
        .then((cfg) => resolve(activeChat.agent, cfg.acp?.custom_agents))
        .catch(() => resolve(activeChat.agent));
    } else {
      getConfig()
        .then((cfg) =>
          resolve(cfg.layout.agent_command || "claude", cfg.acp?.custom_agents),
        )
        .catch(() => resolve("claude"));
    }
  }, [activeChat]);

  // ─── @ mention file list with TTL cache (5s) ──────────────────────
  const TASK_FILES_TTL_MS = 10_000;

  const refreshTaskFilesIfNeeded = useCallback(() => {
    if (taskFilesLoadingRef.current) return;
    const now = Date.now();
    if (now - taskFilesFetchTimeRef.current < TASK_FILES_TTL_MS) {
      taskFilesFetchTimeRef.current = now;
      return;
    }
    taskFilesLoadingRef.current = true;
    taskFilesFetchTimeRef.current = now;

    getTaskFiles(projectId, task.id)
      .then((res) => {
        setTaskFiles(res.files);
      })
      .catch(() => {})
      .finally(() => {
        taskFilesLoadingRef.current = false;
      });

    if (isStudioProject) {
      listSketches(projectId, task.id).catch(() => {});
    }
  }, [projectId, task.id, isStudioProject]);

  // Initial load on mount / task switch
  useEffect(() => {
    taskFilesFetchTimeRef.current = 0; // force stale on task switch
    refreshTaskFilesIfNeeded();
  }, [projectId, task.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh agent-graph @-mention candidates whenever the active chat changes
  // or the user opens the popover. Spawn candidates come from `acpAgentOptions`
  // (same source as the "+" new-chat picker) so icons line up; send / reply
  // candidates come from the backend's contacts view of the caller chat.
  const refreshAgentMentionCandidates = useCallback(() => {
    if (!activeChatId) {
      setAgentMentionItems([]);
      return;
    }
    const spawnAgents = acpAgentOptions
      .filter((o) => !o.disabled)
      .map((o) => ({ value: o.value, label: o.label }));
    getMentionCandidates(projectId, task.id, activeChatId)
      .then((resp) => {
        setAgentMentionItems(
          buildAgentMentionItems({
            spawnAgents,
            outgoing: resp.outgoing,
            pending_replies: resp.pending_replies,
          }),
        );
      })
      .catch(() => {
        setAgentMentionItems(
          buildAgentMentionItems({
            spawnAgents,
            outgoing: [],
            pending_replies: [],
          }),
        );
      });
  }, [projectId, task.id, activeChatId, acpAgentOptions]);

  useEffect(() => {
    refreshAgentMentionCandidates();
  }, [refreshAgentMentionCandidates]);

  // Studio: also load sketches so @ mentions can surface sketch names
  useEffect(() => {
    if (!isStudioProject) {
      setSketchMeta([]);
      return;
    }
    listSketches(projectId, task.id)
      .then(setSketchMeta)
      .catch(() => setSketchMeta([]));
  }, [isStudioProject, projectId, task.id]);

  // Dynamically measure the input area height so the messages viewport
  // always has enough bottom padding regardless of expanded input, panels, banners, etc.
  // We write directly to the DOM style to avoid a React state update → re-render → layout jump.
  useEffect(() => {
    const el = inputAreaRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const applyPadding = () => {
      const viewport = messagesViewportRef.current;
      if (!viewport) return;
      viewport.style.paddingBottom = `${el.getBoundingClientRect().height + 16}px`;
    };
    const ro = new ResizeObserver(applyPadding);
    ro.observe(el);
    applyPadding();
    return () => ro.disconnect();
  }, [activeChatId]);

  // Watch the chatbox container width — flip to narrow mode when the
  // composer can't comfortably fit the Model / Mode / Thinking dropdowns
  // alongside the input + Send button.
  useEffect(() => {
    const el = chatboxContainerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const w = el.getBoundingClientRect().width;
      setComposerNarrow(w > 0 && w < COMPOSER_OPTIONS_MIN_WIDTH);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scrollMessagesToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const viewport = messagesViewportRef.current;
      if (!viewport) return;
      viewport.scrollTo({ top: viewport.scrollHeight, behavior });
    },
    [],
  );

  const enableAutoStickToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      autoStickToBottomRef.current = true;
      scrollMessagesToBottom(behavior);
      requestAnimationFrame(() => setShowScrollToBottom(false));
    },
    [scrollMessagesToBottom],
  );

  // Track user-initiated scroll-up via wheel/touch events.
  // Only user wheel-up can DISABLE auto-stick; IntersectionObserver only
  // re-enables it when user scrolls back to bottom.
  useEffect(() => {
    const viewport = messagesViewportRef.current;
    if (!viewport) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        // User is scrolling UP → disable auto-stick
        autoStickToBottomRef.current = false;
      }
    };

    let touchStartY = 0;
    const handleTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0]?.clientY ?? 0;
    };
    const handleTouchMove = (e: TouchEvent) => {
      const currentY = e.touches[0]?.clientY ?? 0;
      if (currentY > touchStartY) {
        // Finger moving down = scrolling UP → disable auto-stick
        autoStickToBottomRef.current = false;
      }
    };

    viewport.addEventListener("wheel", handleWheel, { passive: true });
    viewport.addEventListener("touchstart", handleTouchStart, { passive: true });
    viewport.addEventListener("touchmove", handleTouchMove, { passive: true });
    return () => {
      viewport.removeEventListener("wheel", handleWheel);
      viewport.removeEventListener("touchstart", handleTouchStart);
      viewport.removeEventListener("touchmove", handleTouchMove);
    };
  }, [activeChatId]);

  useEffect(() => {
    const viewport = messagesViewportRef.current;
    const bottomMarker = messagesEndRef.current;
    if (!viewport || !bottomMarker || typeof IntersectionObserver === "undefined") {
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        const isAtBottom = entry?.isIntersecting ?? false;
        // Only re-enable auto-stick when bottom marker becomes visible
        // (user scrolled back to bottom). Never disable it here — only
        // wheel/touch handlers disable auto-stick.
        if (isAtBottom) {
          autoStickToBottomRef.current = true;
        }
        // Only show button when user has actively scrolled up (autoStick is false).
        // This prevents the button from flashing during initial load / chat switch.
        setShowScrollToBottom(!isAtBottom && !autoStickToBottomRef.current && messagesCountRef.current > 0);
      },
      {
        root: viewport,
        threshold: 0,
        rootMargin: "0px 0px 48px 0px",
      },
    );

    observer.observe(bottomMarker);
    return () => observer.disconnect();
  }, [activeChatId]);

  const autoScrollTailSignature = useMemo(
    () => getAutoScrollTailSignature(messages),
    [messages],
  );
  const prevAutoScrollTailRef = useRef(autoScrollTailSignature);
  const autoScrollTailSignatureRef = useRef(autoScrollTailSignature);
  autoScrollTailSignatureRef.current = autoScrollTailSignature;
  useEffect(() => {
    const previousTail = prevAutoScrollTailRef.current;
    const tailChanged = autoScrollTailSignature !== previousTail;
    if (tailChanged && autoStickToBottomRef.current) {
      // During streaming (incomplete assistant/thinking messages), use instant
      // scroll to prevent smooth animation from falling behind rapid updates.
      const lastMsg = messages[messages.length - 1];
      const isStreaming =
        lastMsg &&
        (lastMsg.type === "assistant" || lastMsg.type === "thinking") &&
        !lastMsg.complete;
      scrollMessagesToBottom(
        suppressNextSmoothScrollRef.current || isStreaming ? "auto" : "smooth",
      );
    }
    suppressNextSmoothScrollRef.current = false;
    prevAutoScrollTailRef.current = autoScrollTailSignature;
  }, [autoScrollTailSignature, scrollMessagesToBottom, messages]);

  useEffect(() => {
    suppressNextSmoothScrollRef.current = true;
    prevAutoScrollTailRef.current = autoScrollTailSignatureRef.current;
    requestAnimationFrame(() => {
      autoStickToBottomRef.current = true;
      scrollMessagesToBottom("auto");
      setShowScrollToBottom(false);
    });
  }, [activeChatId, scrollMessagesToBottom]);

  // Auto-scroll slash menu to keep selected item visible
  useEffect(() => {
    slashItemRefs.current[slashSelectedIdx]?.scrollIntoView({
      block: "nearest",
    });
  }, [slashSelectedIdx]);

  // Close dropdown menus when clicking outside
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      sessionModeStorageKey,
      sessionRailCollapsed ? "header" : "sidebar",
    );
  }, [sessionModeStorageKey, sessionRailCollapsed]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setSessionRailCollapsed(
      window.localStorage.getItem(sessionModeStorageKey) !== "sidebar",
    );
  }, [sessionModeStorageKey]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (
        modelMenuRef.current &&
        !modelMenuRef.current.contains(e.target as Node)
      )
        setShowModelMenu(false);
      if (
        permMenuRef.current &&
        !permMenuRef.current.contains(e.target as Node)
      )
        setShowPermMenu(false);
      if (
        thoughtLevelMenuRef.current &&
        !thoughtLevelMenuRef.current.contains(e.target as Node)
      )
        setShowThoughtLevelMenu(false);
      if (
        chatMenuRef.current &&
        !chatMenuRef.current.contains(e.target as Node)
      )
        setShowChatMenu(false);
      const insideHeaderAgentPicker =
        headerAgentPickerRef.current?.contains(e.target as Node) ?? false;
      const insideSidebarAgentPicker =
        sidebarAgentPickerRef.current?.contains(e.target as Node) ?? false;
      const insideAgentPickerMenu =
        agentPickerMenuRef.current?.contains(e.target as Node) ?? false;
      if (
        !insideHeaderAgentPicker &&
        !insideSidebarAgentPicker &&
        !insideAgentPickerMenu
      ) {
        setShowAgentPicker(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  useEffect(() => {
    showAgentPickerRef.current = showAgentPicker;
  }, [showAgentPicker]);

  const toggleAgentPicker = useCallback((el: HTMLElement) => {
    if (showAgentPickerRef.current) {
      setShowAgentPicker(false);
      return;
    }

    const rect = el.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const preferredLeft = rect.right + AGENT_PICKER_VIEWPORT_MARGIN;
    const preferredTop = rect.top;

    setAgentPickerAnchor({
      top: Math.max(
        AGENT_PICKER_VIEWPORT_MARGIN,
        Math.min(
          preferredTop,
          viewportHeight - AGENT_PICKER_MENU_MAX_HEIGHT - AGENT_PICKER_VIEWPORT_MARGIN,
        ),
      ),
      left: Math.max(
        AGENT_PICKER_VIEWPORT_MARGIN,
        Math.min(
          preferredLeft,
          viewportWidth - AGENT_PICKER_MENU_WIDTH - AGENT_PICKER_VIEWPORT_MARGIN,
        ),
      ),
    });
    setShowChatMenu(false);
    setShowAgentPicker(true);
  }, []);

  useEffect(() => {
    if (!showAgentPicker) return;

    const close = () => setShowAgentPicker(false);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);

    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [showAgentPicker]);

  // ─── Save/Restore per-chat state on switch ─────────────────────────────

  /** Save current active chat state to cache */
  const saveCurrentChatState = useCallback(() => {
    if (!activeChatId) return;
    perChatStateRef.current.set(activeChatId, {
      messages,
      hiddenMessageCount,
      attachmentCounters: { ...attachCountersRef.current },
      isBusy,
      selectedModel,
      permissionLevel,
      modelOptions,
      modeOptions,
      thoughtLevelOptions,
      thoughtLevel,
      thoughtLevelConfigId,
      planEntries,
      slashCommands,
      isConnected,
      agentLabel,
      agentIcon: AgentIcon,
      promptCaps,
      planFilePath,
      planFileContent,
      isRemoteSession,
      remoteOwnerName,
      draftHtml: editableRef.current?.innerHTML ?? "",
    });
  }, [
    activeChatId,
    messages,
    hiddenMessageCount,
    isBusy,
    selectedModel,
    permissionLevel,
    modelOptions,
    modeOptions,
    thoughtLevelOptions,
    thoughtLevel,
    thoughtLevelConfigId,
    planEntries,
    slashCommands,
    isConnected,
    agentLabel,
    AgentIcon,
    promptCaps,
    planFilePath,
    planFileContent,
    isRemoteSession,
    remoteOwnerName,
  ]);

  /** Restore chat state from cache */
  const restoreChatState = useCallback((chatId: string) => {
    const cached = perChatStateRef.current.get(chatId);
    if (cached) {
      setMessages(cached.messages);
      updateHiddenMessageCount(cached.hiddenMessageCount);
      updateBusy(cached.isBusy);
      setSelectedModel(cached.selectedModel);
      setPermissionLevel(cached.permissionLevel);
      setModelOptions(cached.modelOptions);
      setModeOptions(cached.modeOptions);
      setThoughtLevelOptions(cached.thoughtLevelOptions);
      setThoughtLevel(cached.thoughtLevel);
      setThoughtLevelConfigId(cached.thoughtLevelConfigId);
      setPlanEntries(cached.planEntries);
      setSlashCommands(cached.slashCommands);
      setIsConnected(cached.isConnected);
      setAgentLabel(cached.agentLabel);
      if (cached.agentIcon) setAgentIcon(() => cached.agentIcon);
      setPromptCaps(cached.promptCaps);
      setPlanFilePath(cached.planFilePath);
      setPlanFileContent(cached.planFileContent);
      planFilePathRef.current = cached.planFilePath;
      setShowPlanFile(!!cached.planFileContent);
      setIsRemoteSession(cached.isRemoteSession);
      setRemoteOwnerName(cached.remoteOwnerName);
    } else {
      setMessages([]);
      updateHiddenMessageCount(0);
      updateBusy(false);
      setSelectedModel("");
      setPermissionLevel("");
      setModelOptions([]);
      setModeOptions([]);
      setThoughtLevelOptions([]);
      setThoughtLevel("");
      setThoughtLevelConfigId("");
      setPlanEntries([]);
      setSlashCommands([]);
      setIsConnected(false);
      setIsTerminalMode(false);
      setPromptCaps({ image: false, audio: false, embeddedContext: false });
      setPlanFilePath("");
      setPlanFileContent("");
      planFilePathRef.current = "";
      setShowPlanFile(false);
      setIsRemoteSession(false);
      setRemoteOwnerName("");
    }
    // Reset pending messages — server will send queue_update on reconnect
    setPendingMessages([]);
    // Clear attachments on chat switch (revoke blob URLs to avoid leaks)
    setAttachments((prev) => {
      prev.forEach((att) => { if (att.previewUrl) URL.revokeObjectURL(att.previewUrl); });
      return [];
    });
    const restoredMessages = perChatStateRef.current.get(chatId)?.messages ?? [];
    attachCountersRef.current =
      cached?.attachmentCounters ?? buildAttachmentCounters(restoredMessages);
    // Point wsRef to this chat's WebSocket
    wsRef.current = wsMapRef.current.get(chatId) ?? null;
    // Restore the unsent composer draft for this chat. innerHTML round-trip
    // preserves slash/file chips because click handlers are delegated on the
    // editable container, not attached to individual chip DOM nodes.
    const draftHtml = cached?.draftHtml ?? "";
    const el = editableRef.current;
    if (el) {
      el.innerHTML = draftHtml;
      // Refresh hasContent since we bypassed onInput; attachments were just
      // cleared above, so drive the flag off the draft alone.
      const text = el.textContent?.trim() || "";
      const hasChips = el.querySelector("[data-command],[data-file]") !== null;
      setHasContent(text.length > 0 || hasChips);
    }
  }, [updateBusy, updateHiddenMessageCount]);

  // ─── Load chats on mount ───────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      try {
        let chatList = await listChats(projectId, task.id);
        if (chatList.length === 0) {
          // Auto-create first chat
          const newChat = await createChat(
            projectId,
            task.id,
            buildDefaultSessionTitle(),
          );
          chatList = [newChat];
        }
        if (cancelled) return;
        setChats(chatList);
        // Check if Radio requested a specific session (pending from before mount)
        const pending = (window as unknown as Record<string, unknown>).__grove_pending_chat as
          | { projectId: string; taskId: string; chatId: string }
          | undefined;
        if (
          pending &&
          pending.projectId === projectId &&
          pending.taskId === task.id &&
          chatList.some((c) => c.id === pending.chatId)
        ) {
          setActiveChatId(pending.chatId);
          writeLastActiveTab("chat", projectId, task.id, pending.chatId);
          delete (window as unknown as Record<string, unknown>).__grove_pending_chat;
        } else {
          // Prefer the last-active chat remembered from a prior visit; fall
          // back to the last chat in the list when no memory exists or the
          // remembered chat has been deleted.
          const remembered = readLastActiveTab("chat", projectId, task.id);
          const restoredId =
            remembered && chatList.some((c) => c.id === remembered)
              ? remembered
              : chatList[chatList.length - 1].id;
          setActiveChatId(restoredId);
        }
      } catch (err) {
        console.error("Failed to load chats:", err);
      }
    };
    init();
    return () => {
      cancelled = true;
    };
  }, [projectId, task.id]);

  // ─── Auto-refetch chat list on RadioEvent::ChatListChanged ─────────────
  // Fired by the `grove_agent_spawn` MCP tool after a sibling session is
  // spawned. Without this hook, an agent-spawned chat would be invisible in
  // the UI until the user manually refreshed.
  useRadioEvents({
    onChatListChanged: (evtProjectId, evtTaskId) => {
      if (evtProjectId !== projectId || evtTaskId !== task.id) return;
      void (async () => {
        try {
          const fresh = await listChats(projectId, task.id);
          setChats(fresh);
        } catch (err) {
          console.error("Failed to refetch chats after ChatListChanged:", err);
        }
      })();
    },
  });

  // ─── External chat switch (Radio → Blitz) ──────────────────────────────

  const switchChatRef = useRef<(chatId: string) => void>(() => {});
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.projectId === projectId && detail?.taskId === task.id && detail?.chatId) {
        switchChatRef.current(detail.chatId);
      }
    };
    window.addEventListener("grove:switch-chat", handler);
    return () => window.removeEventListener("grove:switch-chat", handler);
  }, [projectId, task.id]);

  // ─── Per-chat WebSocket management ─────────────────────────────────────

  // Refs for WS callbacks so connectChatWs doesn't need them as deps
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleServerMessageRef = useRef<(msg: any) => void>(() => {});
  const handleServerMessageForCacheRef = useRef<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chatId: string, msg: any) => void
  >(() => {});
  const onConnectedPropRef = useRef(onConnectedProp);
  onConnectedPropRef.current = onConnectedProp;
  const onDisconnectedPropRef = useRef(onDisconnectedProp);
  onDisconnectedPropRef.current = onDisconnectedProp;

  /** Connect a WebSocket for a given chat ID (idempotent) */
  const connectChatWs = useCallback(
    async (chatId: string) => {
      if (wsMapRef.current.has(chatId)) return; // Already connected
      if (connectingRef.current.has(chatId)) return; // Connection already in-flight
      connectingRef.current.add(chatId);

      const host = getApiHost();
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = await appendHmacToUrl(
        `${protocol}//${host}/api/v1/projects/${projectId}/tasks/${task.id}/chats/${chatId}/ws`,
      );

      connectingRef.current.delete(chatId);
      // Re-check after async gap: another call may have connected while we awaited
      if (wsMapRef.current.has(chatId)) return;

      const ws = new WebSocket(url);
      wsMapRef.current.set(chatId, ws);

      ws.onopen = () => {};

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (chatId === activeChatIdRef.current) {
            if (historyLoadingRef.current) {
              wsEventBufferRef.current.push(data);
            } else {
              handleServerMessageRef.current(data);
            }
          } else {
            // Buffer into per-chat cache
            handleServerMessageForCacheRef.current(chatId, data);
          }
        } catch {
          /* ignore */
        }
      };

      ws.onclose = () => {
        wsMapRef.current.delete(chatId);
        if (chatId === activeChatIdRef.current) {
          setIsConnected(false);
          onDisconnectedPropRef.current?.();
        } else {
          const cached = perChatStateRef.current.get(chatId);
          if (cached) cached.isConnected = false;
        }
        // Auto-reconnect after unexpected close (e.g., session killed by Take Control).
        // Skip if this was an intentional close (unmount, chat switch, etc.)
        if (intentionalCloseRef.current.has(chatId)) {
          intentionalCloseRef.current.delete(chatId);
        } else {
          setTimeout(() => {
            if (!wsMapRef.current.has(chatId)) {
              connectChatWs(chatId).then(() => {
                if (chatId === activeChatIdRef.current) {
                  wsRef.current = wsMapRef.current.get(chatId) ?? null;
                }
              });
            }
          }, 1000);
        }
      };

      ws.onerror = () => {
        if (chatId === activeChatIdRef.current) {
          setMessages((prev) => appendSystemMessage(prev, "Connection error."));
        }
      };
    },
    [projectId, task.id],
  );

  // Ref to track current activeChatId (for use in callbacks)
  const activeChatIdRef = useRef<string | null>(null);
  activeChatIdRef.current = activeChatId;

  // Connect WS first (for real-time events + SessionReady), then load history via HTTP
  useEffect(() => {
    if (!activeChatId) return;
    const chatId = activeChatId;
    historyLoadingRef.current = true;
    wsEventBufferRef.current = [];
    (async () => {
      // Step 1: Connect WS for real-time events
      await connectChatWs(chatId);
      wsRef.current = wsMapRef.current.get(chatId) ?? null;
      // Step 2: Load history from HTTP (one-shot, avoids "过电影" effect)
      if (chatId !== activeChatIdRef.current) return;
      try {
        const res = await getChatHistory(projectId, task.id, chatId);
        if (chatId !== activeChatIdRef.current) return;
        let msgs: ChatMessage[] = [];
        for (const evt of res.events) {
          msgs = reduceHistoryMessages(msgs, evt);
        }
        // Drain buffered WS events that arrived during HTTP load
        const buffered = wsEventBufferRef.current;
        wsEventBufferRef.current = [];
        historyLoadingRef.current = false;
        // Reduce buffered message events into msgs locally (avoids React batching concerns)
        for (const evt of buffered) {
          msgs = reduceHistoryMessages(msgs, evt);
        }
        const attachmentCounters = buildAttachmentCounters(msgs);
        const prunedHistory = pruneChatViewMessages(
          msgs,
          0,
          chatRenderWindowSettings,
        );
        msgs = prunedHistory.messages;
        setMessages(msgs);
        updateHiddenMessageCount(prunedHistory.hiddenMessageCount);
        // Keep attachment numbering based on full history, even when old
        // rendered messages are hidden from the view.
        attachCountersRef.current = attachmentCounters;
        // Process non-message side effects from buffered events
        for (const evt of buffered) {
          switch (evt.type) {
            case "session_ready":
              setIsConnected(true);
              onConnectedPropRef.current?.();
              if (evt.available_modes?.length) {
                setModeOptions(
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  evt.available_modes.map((m: any) => ({
                    label: m.name,
                    value: m.id,
                  })),
                );
              }
              if (evt.current_mode_id) setPermissionLevel(evt.current_mode_id);
              if (evt.available_models?.length) {
                setModelOptions(
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  evt.available_models.map((m: any) => ({
                    label: m.name,
                    value: m.id,
                  })),
                );
              }
              if (evt.current_model_id) setSelectedModel(evt.current_model_id);
              if (evt.available_thought_levels?.length) {
                setThoughtLevelOptions(
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  evt.available_thought_levels.map((t: any) => ({
                    label: t.name,
                    value: t.id,
                  })),
                );
              }
              if (evt.current_thought_level_id)
                setThoughtLevel(evt.current_thought_level_id);
              if (evt.thought_level_config_id)
                setThoughtLevelConfigId(evt.thought_level_config_id);
              if (evt.prompt_capabilities) {
                setPromptCaps({
                  image: evt.prompt_capabilities.image ?? false,
                  audio: evt.prompt_capabilities.audio ?? false,
                  embeddedContext:
                    evt.prompt_capabilities.embedded_context ?? false,
                });
              }
              break;
            case "thought_levels_update":
              setThoughtLevelOptions(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (evt.available ?? []).map((t: any) => ({
                  label: t.name,
                  value: t.id,
                })),
              );
              setThoughtLevel(evt.current ?? "");
              setThoughtLevelConfigId(evt.config_id ?? "");
              break;
            case "busy":
              updateBusy(true);
              break;
            case "complete":
              updateBusy(false);
              break;
            case "plan_update":
              setPlanEntries(evt.entries || []);
              break;
            case "queue_update":
              setPendingMessages(evt.messages || []);
              break;
            case "available_commands":
              setSlashCommands(evt.commands ?? []);
              break;
            case "session_ended":
              setIsConnected(false);
              break;
          }
        }
      } catch {
        historyLoadingRef.current = false;
        wsEventBufferRef.current = [];
      }
    })();
  }, [activeChatId, connectChatWs, projectId, task.id, updateBusy, chatRenderWindowSettings, updateHiddenMessageCount]);

  // Cleanup all WebSockets on unmount
  useEffect(() => {
    const wsMap = wsMapRef.current;
    const intentional = intentionalCloseRef.current;
    return () => {
      wsMap.forEach((_, id) => intentional.add(id));
      wsMap.forEach((ws) => ws.close());
      wsMap.clear();
    };
  }, []);

  // ─── WebSocket message handler ───────────────────────────────────────────

  const handleServerMessage = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (msg: any) => {
      switch (msg.type) {
        case "session_ready":
          setIsConnected(true);
          onConnectedProp?.();
          // Dynamic modes/models from agent
          if (msg.available_modes?.length) {
            setModeOptions(
              msg.available_modes.map((m: { id: string; name: string }) => ({
                label: m.name,
                value: m.id,
              })),
            );
          }
          if (msg.current_mode_id) setPermissionLevel(msg.current_mode_id);
          if (msg.available_models?.length) {
            setModelOptions(
              msg.available_models.map((m: { id: string; name: string }) => ({
                label: m.name,
                value: m.id,
              })),
            );
          }
          if (msg.current_model_id) setSelectedModel(msg.current_model_id);
          if (msg.available_thought_levels?.length) {
            setThoughtLevelOptions(
              msg.available_thought_levels.map(
                (t: { id: string; name: string }) => ({
                  label: t.name,
                  value: t.id,
                }),
              ),
            );
          }
          if (msg.current_thought_level_id)
            setThoughtLevel(msg.current_thought_level_id);
          if (msg.thought_level_config_id)
            setThoughtLevelConfigId(msg.thought_level_config_id);
          // Extract prompt capabilities
          if (msg.prompt_capabilities) {
            setPromptCaps({
              image: msg.prompt_capabilities.image ?? false,
              audio: msg.prompt_capabilities.audio ?? false,
              embeddedContext:
                msg.prompt_capabilities.embedded_context ?? false,
            });
          }
          break;
        case "message_chunk":
          // Auto-close the current tool section (one-time)
          setAutoExpandSectionId((prev) => {
            if (prev) {
              setExpandedSections((s) => {
                const n = new Set(s);
                n.delete(prev);
                return n;
              });
            }
            return null;
          });
          setMessages((prev) => reduceHistoryMessages(prev, msg));
          break;
        case "thought_chunk":
          // Auto-close the current tool section (same as message_chunk)
          setAutoExpandSectionId((prev) => {
            if (prev) {
              setExpandedSections((s) => {
                const n = new Set(s);
                n.delete(prev);
                return n;
              });
            }
            return null;
          });
          setMessages((prev) => reduceHistoryMessages(prev, msg));
          break;
        case "tool_call":
          setMessages((prev) => reduceHistoryMessages(prev, msg));
          // Default-expand: new section gets expanded once; existing section untouched
          setAutoExpandSectionId((prev) => {
            if (prev === null) {
              // New section — default expand it once
              setExpandedSections((s) => {
                const n = new Set(s);
                n.add(msg.id);
                return n;
              });
              return msg.id;
            }
            // Same section continues — don't touch expandedSections
            return prev;
          });
          // Track tool_call IDs that touch the plan file (for re-fetch on completion)
          if (
            planFilePathRef.current &&
            msg.locations?.some(
              (l: { path: string }) => l.path === planFilePathRef.current,
            )
          ) {
            planFileToolIdsRef.current.add(msg.id);
          }
          break;
        case "tool_call_update":
          setMessages((prev) => reduceHistoryMessages(prev, msg));
          // Re-fetch plan file content if a completed tool touches the plan file
          if (
            msg.status === "completed" &&
            planFilePathRef.current &&
            planFileToolIdsRef.current.has(msg.id)
          ) {
            planFileToolIdsRef.current.delete(msg.id);
            readFile(planFilePathRef.current)
              .then((res) => setPlanFileContent(res.content))
              .catch(() => {});
          }
          break;
        case "permission_request":
          setShowPermissionPanel(true);
          setShowPlan(false);
          setShowPlanFile(false);
          setShowPendingQueue(false);
          setMessages((prev) => reduceHistoryMessages(prev, msg));
          break;
        case "permission_response":
          setShowPermissionPanel(false);
          setMessages((prev) => reduceHistoryMessages(prev, msg));
          break;
        case "complete":
          setAutoExpandSectionId((prev) => {
            if (prev) {
              setExpandedSections((s) => {
                const n = new Set(s);
                n.delete(prev);
                return n;
              });
            }
            return null;
          });
          setMessages((prev) =>
            pruneActiveChatMessages(reduceHistoryMessages(prev, msg)),
          );
          updateBusy(false);
          onChatBecameIdle?.();
          break;
        case "busy":
          updateBusy(msg.value);
          if (!msg.value) {
            setMessages((prev) => pruneActiveChatMessages(prev));
            onChatBecameIdle?.();
          }
          break;
        case "error": {
          const isStalePermission = msg.message?.includes("No pending permission");
          if (isStalePermission) {
            // The permission we tried to respond to no longer exists on the backend.
            // Resolve all unresolved permissions as cancelled so the UI unblocks.
            setMessages((prev) =>
              prev.map((m) =>
                m.type === "permission" && !m.resolved
                  ? { ...m, resolved: "Cancelled" }
                  : m,
              ),
            );
            setShowPermissionPanel(false);
          } else {
            setMessages((prev) => [
              ...prev,
              { type: "system", content: `Error: ${msg.message}` },
            ]);
            updateBusy(false);
            onChatBecameIdle?.();
          }
          break;
        }
        case "user_message": {
          setMessages((prev) => reduceHistoryMessages(prev, msg));
          enableAutoStickToBottom("smooth");
          break;
        }
        case "mode_changed":
          setPermissionLevel(msg.mode_id);
          break;
        case "thought_levels_update":
          setThoughtLevelOptions(
            (msg.available ?? []).map(
              (t: { id: string; name: string }) => ({
                label: t.name,
                value: t.id,
              }),
            ),
          );
          setThoughtLevel(msg.current ?? "");
          setThoughtLevelConfigId(msg.config_id ?? "");
          break;
        case "plan_update": {
          const entries: PlanEntry[] = msg.entries ?? [];
          setPlanEntries(entries);
          // Auto-expand while in progress, auto-collapse when all done
          const allDone =
            entries.length > 0 &&
            entries.every((e: PlanEntry) => e.status === "completed");
          const shouldOpen = !allDone;
          setShowPlan(shouldOpen);
          if (shouldOpen) {
            setShowPlanFile(false);
            setShowPendingQueue(false);
          }
          break;
        }
        case "plan_file_update":
          setPlanFilePath(msg.path);
          planFilePathRef.current = msg.path;
          if (msg.content) {
            setPlanFileContent(msg.content);
            setShowPlanFile(true);
            setShowPlan(false);
            setShowPendingQueue(false);
          } else {
            readFile(msg.path)
              .then((res) => {
                setPlanFileContent(res.content);
                setShowPlanFile(true);
                setShowPlan(false);
                setShowPendingQueue(false);
              })
              .catch(() => {});
          }
          break;
        case "available_commands":
          setSlashCommands(msg.commands ?? []);
          break;
        case "queue_update":
          // Server sends QueuedMessage[]; extract text for display
          setPendingMessages(
            (msg.messages ?? []).map((m: string | { text: string }) =>
              typeof m === "string" ? m : m.text,
            ),
          );
          break;
        case "remote_session":
          // Session is owned by another process — enter read-only observation mode
          setIsRemoteSession(true);
          setRemoteOwnerName(msg.agent_name || "Unknown");
          break;
        case "terminal_execute":
          // User-initiated terminal command — show as terminal user message
          terminalRunningRef.current = true;
          updateBusy(true);
          setMessages((prev) => reduceHistoryMessages(prev, msg));
          break;
        case "terminal_chunk":
          setMessages((prev) => reduceHistoryMessages(prev, msg));
          break;
        case "terminal_complete":
          terminalRunningRef.current = false;
          updateBusy(false);
          onChatBecameIdle?.();
          setMessages((prev) =>
            pruneActiveChatMessages(reduceHistoryMessages(prev, msg)),
          );
          break;
        case "session_ended":
          setIsConnected(false);
          break;
      }
    },
    [onConnectedProp, enableAutoStickToBottom, onChatBecameIdle, updateBusy, pruneActiveChatMessages],
  );

  /** Buffer a server message into the per-chat cache (for non-active chats) */
  const handleServerMessageForCache = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chatId: string, msg: any) => {
      const state =
        perChatStateRef.current.get(chatId) ?? defaultPerChatState();
      switch (msg.type) {
        case "session_ready":
          state.isConnected = true;
          if (msg.available_modes?.length)
            state.modeOptions = msg.available_modes.map(
              (m: { id: string; name: string }) => ({
                label: m.name,
                value: m.id,
              }),
            );
          if (msg.current_mode_id) state.permissionLevel = msg.current_mode_id;
          if (msg.available_models?.length)
            state.modelOptions = msg.available_models.map(
              (m: { id: string; name: string }) => ({
                label: m.name,
                value: m.id,
              }),
            );
          if (msg.current_model_id) state.selectedModel = msg.current_model_id;
          if (msg.available_thought_levels?.length)
            state.thoughtLevelOptions = msg.available_thought_levels.map(
              (t: { id: string; name: string }) => ({
                label: t.name,
                value: t.id,
              }),
            );
          if (msg.current_thought_level_id)
            state.thoughtLevel = msg.current_thought_level_id;
          if (msg.thought_level_config_id)
            state.thoughtLevelConfigId = msg.thought_level_config_id;
          if (msg.prompt_capabilities) {
            state.promptCaps = {
              image: msg.prompt_capabilities.image ?? false,
              audio: msg.prompt_capabilities.audio ?? false,
              embeddedContext:
                msg.prompt_capabilities.embedded_context ?? false,
            };
          }
          break;
        case "thought_levels_update":
          state.thoughtLevelOptions = (msg.available ?? []).map(
            (t: { id: string; name: string }) => ({
              label: t.name,
              value: t.id,
            }),
          );
          state.thoughtLevel = msg.current ?? "";
          state.thoughtLevelConfigId = msg.config_id ?? "";
          break;
        case "message_chunk":
        case "tool_call":
        case "thought_chunk":
        case "tool_call_update":
        case "permission_request":
        case "permission_response":
        case "complete":
        case "user_message":
        case "terminal_execute":
        case "terminal_chunk":
        case "terminal_complete":
          state.messages = reduceHistoryMessages(state.messages, msg);
          if (msg.type === "complete" || msg.type === "terminal_complete") {
            const pruned = pruneChatViewMessages(
              state.messages,
              state.hiddenMessageCount,
              chatRenderWindowSettings,
            );
            state.messages = pruned.messages;
            state.hiddenMessageCount = pruned.hiddenMessageCount;
            state.isBusy = false;
          }
          break;
        case "queue_update":
          // Server manages queue — ignored for non-active chat cache
          break;
        case "busy":
          state.isBusy = msg.value;
          if (!msg.value) {
            const pruned = pruneChatViewMessages(
              state.messages,
              state.hiddenMessageCount,
              chatRenderWindowSettings,
            );
            state.messages = pruned.messages;
            state.hiddenMessageCount = pruned.hiddenMessageCount;
          }
          break;
        case "plan_update":
          state.planEntries = msg.entries ?? [];
          break;
        case "plan_file_update":
          state.planFilePath = msg.path;
          if (msg.content) {
            state.planFileContent = msg.content;
          }
          break;
        case "available_commands":
          state.slashCommands = msg.commands ?? [];
          break;
        case "session_ended":
          state.isConnected = false;
          break;
      }
      perChatStateRef.current.set(chatId, state);
    },
    [chatRenderWindowSettings],
  );

  // Keep refs in sync so connectChatWs WS handlers always call latest versions
  handleServerMessageRef.current = handleServerMessage;
  handleServerMessageForCacheRef.current = handleServerMessageForCache;

  // ─── Read-only observation polling ─────────────────────────────────────
  useEffect(() => {
    if (!isRemoteSession || !activeChatId) {
      if (pollingTimerRef.current) {
        clearInterval(pollingTimerRef.current);
        pollingTimerRef.current = null;
      }
      return;
    }

    // Load initial history
    const chatId = activeChatId;
    getChatHistory(projectId, task.id, chatId, 0)
      .then((res) => {
        if (res.events.length > 0) {
          for (const evt of res.events) {
            handleServerMessageRef.current(evt);
          }
          pollingOffsetRef.current = res.total;
        }
      })
      .catch(() => {});

    // Poll every 5 seconds for incremental updates
    const loadLatest = async () => {
      try {
        const res = await getChatHistory(
          projectId,
          task.id,
          chatId,
          pollingOffsetRef.current,
        );
        if (res.events.length > 0) {
          for (const evt of res.events) {
            handleServerMessageRef.current(evt);
          }
          pollingOffsetRef.current = res.total;
        }
        // If session is gone, auto-exit read-only mode
        if (!res.session) {
          setIsRemoteSession(false);
          setRemoteOwnerName("");
        }
      } catch {
        /* ignore */
      }
    };
    const timer = setInterval(loadLatest, 5000);
    pollingTimerRef.current = timer;

    return () => {
      clearInterval(timer);
      pollingTimerRef.current = null;
    };
  }, [isRemoteSession, activeChatId, projectId, task.id]);

  // ─── Chat switching ────────────────────────────────────────────────────

  const switchChat = useCallback(
    async (chatId: string) => {
      if (chatId === activeChatId) return;
      saveCurrentChatState();
      setActiveChatId(chatId);
      writeLastActiveTab("chat", projectId, task.id, chatId);
      activeChatIdRef.current = chatId; // Sync ref immediately so WS messages route correctly
      restoreChatState(chatId);
      setShowChatMenu(false);
      // Connect WS if needed
      await connectChatWs(chatId);
      wsRef.current = wsMapRef.current.get(chatId) ?? null;
    },
    [activeChatId, projectId, task.id, saveCurrentChatState, restoreChatState, connectChatWs],
  );
  switchChatRef.current = switchChat;

  useEffect(() => {
    const handler = (e: Event) => {
      const { chatId } = (e as CustomEvent<{ chatId: string }>).detail;
      if (chatId && chats.some((c) => c.id === chatId)) {
        switchChat(chatId);
      }
    };
    window.addEventListener("grove:select-chat", handler);
    return () => window.removeEventListener("grove:select-chat", handler);
  }, [chats, switchChat]);

  // ─── New chat creation ─────────────────────────────────────────────────

  const handleNewChatWithAgent = useCallback(
    async (agent: string) => {
      setShowAgentPicker(false);
      try {
        const newChat = await createChat(
          projectId,
          task.id,
          buildDefaultSessionTitle(),
          agent,
        );
        setChats((prev) => [...prev, newChat]);
        switchChat(newChat.id);
      } catch (err) {
        console.error("Failed to create chat:", err);
      }
    },
    [projectId, task.id, switchChat],
  );

  // ─── Chat title editing ─────────────────────────────────────────────────

  const handleTitleSave = useCallback(async () => {
    if (!editingTitle || !editTitleValue.trim()) {
      setEditingTitle(null);
      return;
    }
    try {
      await updateChatTitle(
        projectId,
        task.id,
        editingTitle.chatId,
        editTitleValue.trim(),
      );
      setChats((prev) =>
        prev.map((c) =>
          c.id === editingTitle.chatId
            ? { ...c, title: editTitleValue.trim() }
            : c,
        ),
      );
    } catch (err) {
      console.error("Failed to update chat title:", err);
    }
    setEditingTitle(null);
  }, [editingTitle, editTitleValue, projectId, task.id]);

  // ─── Chat deletion ─────────────────────────────────────────────────────

  const handleDeleteChat = useCallback(
    async (chatId: string) => {
      if (chats.length <= 1) return; // Don't delete the last chat
      try {
        await deleteChat(projectId, task.id, chatId);
        // Close WebSocket if connected
        const ws = wsMapRef.current.get(chatId);
        if (ws) {
          intentionalCloseRef.current.add(chatId);
          ws.close();
          wsMapRef.current.delete(chatId);
        }
        perChatStateRef.current.delete(chatId);
        setChats((prev) => {
          const updated = prev.filter((c) => c.id !== chatId);
          if (chatId === activeChatId && updated.length > 0) {
            const next = updated[updated.length - 1];
            setActiveChatId(next.id);
            writeLastActiveTab("chat", projectId, task.id, next.id);
            restoreChatState(next.id);
          }
          return updated;
        });
      } catch (err) {
        console.error("Failed to delete chat:", err);
      }
      setShowChatMenu(false);
    },
    [chats.length, projectId, task.id, activeChatId, restoreChatState],
  );

  // ─── User actions ────────────────────────────────────────────────────────

  /** Check if the editable has any content (text, chips, or attachments) */
  const checkContent = useCallback(() => {
    const el = editableRef.current;
    if (!el) {
      setHasContent(attachments.length > 0);
      return;
    }
    const text = el.textContent?.trim() || "";
    const hasChips = el.querySelector("[data-command],[data-file]") !== null;
    setHasContent(text.length > 0 || hasChips || attachments.length > 0);
  }, [attachments.length]);

  /** Convert a File to an Attachment and add to state */
  const addFileAsAttachment = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("image/") && !file.type.startsWith("audio/")) {
        // Defer upload until the prompt is actually sent
        const label = attachmentLabel("resource", ++attachCountersRef.current.resource);
        setAttachments((prev) => [
          ...prev,
          {
            type: "resource",
            data: "",
            mimeType: file.type || "application/octet-stream",
            name: file.name,
            label,
            size: file.size,
            pendingFile: file,
          },
        ]);
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const base64 = dataUrl.split(",")[1];
        const attType: "image" | "audio" = file.type.startsWith("image/") ? "image" : "audio";
        const previewUrl = attType === "image"
          ? URL.createObjectURL(file)
          : undefined;
        const label = attachmentLabel(attType, ++attachCountersRef.current[attType]);
        setAttachments((prev) => [
          ...prev,
          {
            type: attType,
            data: base64,
            mimeType: file.type,
            name: file.name,
            label,
            previewUrl,
          },
        ]);
      };
      reader.readAsDataURL(file);
    },
    [],
  );

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => {
      const att = prev[index];
      if (att?.previewUrl) URL.revokeObjectURL(att.previewUrl);
      const remaining = prev.filter((_, i) => i !== index);
      // Re-label all remaining attachments so numbering stays contiguous
      const counters: AttachmentCounters = { ...attachCountersRef.current };
      // Reset counters to history baseline, then re-number pending attachments
      const historyBase = { ...counters };
      // Count how many of each type exist in remaining
      const pendingCounts: AttachmentCounters = { image: 0, audio: 0, resource: 0 };
      for (const a of remaining) pendingCounts[a.type]++;
      // History base = current counter - old pending count (before removal)
      const oldPendingCounts: AttachmentCounters = { image: 0, audio: 0, resource: 0 };
      for (const a of prev) oldPendingCounts[a.type]++;
      historyBase.image = counters.image - oldPendingCounts.image;
      historyBase.audio = counters.audio - oldPendingCounts.audio;
      historyBase.resource = counters.resource - oldPendingCounts.resource;
      // Re-assign labels sequentially
      const reCount: AttachmentCounters = { ...historyBase };
      const relabeled = remaining.map((a) => ({
        ...a,
        label: attachmentLabel(a.type, ++reCount[a.type]),
      }));
      attachCountersRef.current = reCount;
      return relabeled;
    });
  }, []);

  /** Insert an attachment reference chip (e.g. [Image #1]) into the input */
  const insertAttachmentReference = useCallback(
    (label: string) => {
      const el = editableRef.current;
      if (!el) return;
      // Build a non-editable chip span
      const chip = document.createElement("span");
      chip.contentEditable = "false";
      chip.setAttribute("data-ref", label);
      chip.className =
        "inline-flex items-center gap-0.5 rounded-md bg-[color-mix(in_srgb,var(--color-highlight)_14%,transparent)] text-[var(--color-highlight)] text-xs font-medium px-1.5 py-0.5 mx-0.5 align-baseline select-none cursor-default";
      chip.textContent = label;

      // Insert at cursor or append at end
      el.focus();
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(chip);
        // Move cursor after chip
        range.setStartAfter(chip);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        el.appendChild(chip);
      }
      // Trigger content check
      setHasContent(true);
    },
    [],
  );

  /** Take control of a remote session */
  const handleTakeControl = useCallback(async () => {
    if (!activeChatId || isTakingControl) return;
    setIsTakingControl(true);
    try {
      await takeControl(projectId, task.id, activeChatId);
      // Clear polling and remote state
      setIsRemoteSession(false);
      setRemoteOwnerName("");
      // Resolve any pending permission requests (session was killed, permissions are void)
      setShowPermissionPanel(false);
      setMessages((prev) =>
        prev.map((m) =>
          m.type === "permission" && !m.resolved
            ? { ...m, resolved: "Cancelled" }
            : m,
        ),
      );
      pollingOffsetRef.current = 0;
      // Reconnect via WebSocket (normal flow)
      intentionalCloseRef.current.add(activeChatId);
      wsMapRef.current.get(activeChatId)?.close();
      wsMapRef.current.delete(activeChatId);
      await connectChatWs(activeChatId);
      wsRef.current = wsMapRef.current.get(activeChatId) ?? null;
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          type: "system",
          content: "Failed to take control. Please try again.",
        },
      ]);
    } finally {
      setIsTakingControl(false);
    }
  }, [activeChatId, isTakingControl, projectId, task.id, connectChatWs]);

  const handleSavePlanToNote = useCallback(async () => {
    if (!planFileContent || isSavingToNote) return;
    setIsSavingToNote(true);
    setSaveToNoteDone(false);
    try {
      await updateNotes(projectId, task.id, planFileContent);
      setSaveToNoteDone(true);
      setTimeout(() => setSaveToNoteDone(false), 2000);
    } catch {
      setMessages((prev) => [
        ...prev,
        { type: "system", content: "Failed to save plan to note." },
      ]);
    } finally {
      setIsSavingToNote(false);
    }
  }, [planFileContent, isSavingToNote, projectId, task.id]);

  const handleSend = useCallback(async () => {
    const el = editableRef.current;
    if (!el) return;
    // Guard activeChatId before consuming any UI state — if we return after
    // clearing the editable, the user's typed message is silently lost.
    if (!activeChatId) return;
    const prompt = getPromptFromEditable(el);
    if (
      (!prompt && attachments.length === 0) ||
      !wsRef.current ||
      wsRef.current.readyState !== WebSocket.OPEN
    )
      return;

    // Shell mode → send terminal_execute directly (bypasses AI)
    if (isTerminalMode) {
      if (!prompt || isBusy) return;
      enableAutoStickToBottom("auto");
      wsRef.current.send(
        JSON.stringify({ type: "terminal_execute", command: prompt }),
      );
      el.innerHTML = "";
      setHasContent(false);
      setAttachments([]);
      setIsTerminalMode(false);
      setIsInputExpanded(false);
      el.focus();
      return;
    }

    const text = prompt;

    // Upload any pending files now (deferred from drag/drop time)
    let resolvedAttachments = attachments;
    const pendingOnes = attachments.filter((a) => a.pendingFile);
    if (pendingOnes.length > 0) {
      if (!activeChatId) return;
      try {
        const uploadResults = await Promise.all(
          pendingOnes.map(async (att) => {
            const data = await fileToBase64(att.pendingFile!);
            return uploadChatAttachment(projectId, task.id, activeChatId, {
              name: att.pendingFile!.name,
              mime_type: att.pendingFile!.type || undefined,
              data,
            });
          }),
        );
        let uploadIdx = 0;
        resolvedAttachments = attachments.map((att) => {
          if (!att.pendingFile) return att;
          const result = uploadResults[uploadIdx++];
          return {
            ...att,
            uri: result.uri,
            name: result.name,
            mimeType: result.mime_type ?? att.mimeType,
            size: result.size,
            pendingFile: undefined,
          };
        });
      } catch (err) {
        console.error("Failed to upload attachment:", err);
        setMessages((prev) => [
          ...prev,
          { type: "system", content: `Failed to upload attachment: ${err instanceof Error ? err.message : String(err)}` },
        ]);
        return;
      }
    }

    // Build attachments payload for server
    const contentAttachments = resolvedAttachments.map((att) => ({
      ...(att.type === "resource"
        ? {
            type: "resource_link",
            uri: att.uri,
            name: att.name,
            label: att.label,
            mime_type: att.mimeType || undefined,
            size: att.size,
          }
        : {
            type: att.type,
            data: att.data,
            label: att.label,
            mime_type: att.mimeType,
          }),
    }));

    if (isBusy) {
      // Queue message on server when agent is busy
      enableAutoStickToBottom("auto");
      wsRef.current.send(
        JSON.stringify({
          type: "queue_message",
          text,
          attachments: contentAttachments,
        }),
      );
      el.innerHTML = "";
      setHasContent(false);
      setAttachments((prev) => {
        prev.forEach((att) => { if (att.previewUrl) URL.revokeObjectURL(att.previewUrl); });
        return [];
      });
      setShowSlashMenu(false);
      setShowFileMenu(false);
      setIsTerminalMode(false);
      setIsInputExpanded(false);
      setShowPendingQueue(true);
      setShowPlan(false);
      setShowPlanFile(false);
      onUserMessageSent?.();
      el.focus();
    } else {
      enableAutoStickToBottom("auto");
      wsRef.current.send(
        JSON.stringify({
          type: "prompt",
          text,
          attachments: contentAttachments,
        }),
      );
      el.innerHTML = "";
      setHasContent(false);
      setAttachments((prev) => {
        prev.forEach((att) => { if (att.previewUrl) URL.revokeObjectURL(att.previewUrl); });
        return [];
      });
      setShowSlashMenu(false);
      setShowFileMenu(false);
      setIsTerminalMode(false);
      setIsInputExpanded(false);
      updateBusy(true);
      onUserMessageSent?.();
      el.focus();
    }
  }, [isTerminalMode, isBusy, attachments, activeChatId, projectId, task.id, enableAutoStickToBottom, onUserMessageSent, updateBusy]);

  const sendPreviewComments = useCallback((comments: PreviewCommentDraft[]) => {
    if (
      comments.length === 0 ||
      !activeChatId ||
      !wsRef.current ||
      wsRef.current.readyState !== WebSocket.OPEN ||
      isTerminalMode
    ) {
      return;
    }

    const text = formatPreviewCommentPrompt(comments);
    enableAutoStickToBottom("auto");
    wsRef.current.send(
      JSON.stringify({
        type: isBusy ? "queue_message" : "prompt",
        text,
        attachments: [],
      }),
    );
    clearPreviewCommentDrafts(comments.map((comment) => comment.id));
    setShowPreviewComments(false);
    setShowSlashMenu(false);
    setShowFileMenu(false);
    setShowPendingQueue(isBusy);
    setShowPlan(false);
    setShowPlanFile(false);
    if (!isBusy) updateBusy(true);
    onUserMessageSent?.();
  }, [
    activeChatId,
    clearPreviewCommentDrafts,
    enableAutoStickToBottom,
    isBusy,
    isTerminalMode,
    onUserMessageSent,
    updateBusy,
  ]);

  /** Cancel current agent work — server auto-sends next queued message after Complete */
  const handleSendNow = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "cancel" }));
  }, []);

  /** Stop agent or kill running terminal command */
  const handleStopAgent = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (terminalRunningRef.current) {
      wsRef.current.send(JSON.stringify({ type: "terminal_kill" }));
    } else {
      wsRef.current.send(JSON.stringify({ type: "cancel" }));
    }
  }, []);

  const handleEditPending = useCallback(
    (i: number) => {
      setEditingPendingIdx(i);
      setEditingPendingValue(pendingMessages[i]);
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "pause_queue" }));
      }
    },
    [pendingMessages],
  );

  const handleSavePendingEdit = useCallback(() => {
    if (
      editingPendingIdx === null ||
      !wsRef.current ||
      wsRef.current.readyState !== WebSocket.OPEN
    )
      return;
    const trimmed = editingPendingValue.trim();
    if (!trimmed) {
      wsRef.current.send(
        JSON.stringify({ type: "dequeue_message", index: editingPendingIdx }),
      );
    } else {
      wsRef.current.send(
        JSON.stringify({
          type: "update_queued_message",
          index: editingPendingIdx,
          text: trimmed,
        }),
      );
    }
    setEditingPendingIdx(null);
    setEditingPendingValue("");
    wsRef.current.send(JSON.stringify({ type: "resume_queue" }));
  }, [editingPendingIdx, editingPendingValue]);

  const handleCancelPendingEdit = useCallback(() => {
    setEditingPendingIdx(null);
    setEditingPendingValue("");
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "resume_queue" }));
    }
  }, []);

  const handleDeletePending = useCallback(
    (i: number) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      wsRef.current.send(JSON.stringify({ type: "dequeue_message", index: i }));
      if (editingPendingIdx === i) {
        setEditingPendingIdx(null);
        setEditingPendingValue("");
      }
    },
    [editingPendingIdx],
  );

  const handleClearPending = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "clear_queue" }));
    setEditingPendingIdx(null);
    setEditingPendingValue("");
  }, []);

  /** Respond to a permission request. `requestId` correlates with the server's
   * live pending permission so a stale dialog (rendered from history but
   * already cancelled by reconcile) can't be silently accepted. */
  const handlePermissionResponse = useCallback(
    (optionId: string, requestId: string) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      wsRef.current.send(
        JSON.stringify({
          type: "permission_response",
          id: requestId,
          option_id: optionId,
        }),
      );
    },
    [],
  );

  /** Detect /slash or @file at cursor position in contentEditable */
  const handleInput = useCallback(() => {
    // Detect "!" typed into empty input → enter shell mode and clear the "!"
    const el = editableRef.current;
    if (el && !isTerminalMode && !isBusy && el.textContent === "!") {
      el.innerHTML = "";
      setHasContent(false);
      setIsTerminalMode(true);
      return;
    }
    // Shell mode: highlight first word (command) differently from args
    if (el && isTerminalMode && !composingRef.current) {
      const raw = el.textContent || "";
      checkContent();
      const match = raw.match(/^(\S+)([\s\S]*)$/);
      if (match) {
        const sel = window.getSelection();
        // Calculate cursor offset within the raw text
        let cursorOffset = raw.length;
        if (sel && sel.rangeCount > 0) {
          const r = sel.getRangeAt(0);
          // Walk text nodes to find absolute offset
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let offset = 0;
          let node: Node | null;
          while ((node = walker.nextNode())) {
            if (node === r.startContainer) {
              cursorOffset = offset + r.startOffset;
              break;
            }
            offset += (node.textContent || "").length;
          }
        }
        const escCmd = match[1]
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        const escArgs = match[2]
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/\n/g, "<br>");
        const highlighted = `<span style="color:var(--color-accent);font-weight:600">${escCmd}</span>${escArgs}`;
        el.innerHTML = highlighted;
        // Restore cursor
        if (sel) {
          const newRange = document.createRange();
          const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let remaining = cursorOffset;
          let placed = false;
          let tn: Node | null;
          while ((tn = tw.nextNode())) {
            const len = (tn.textContent || "").length;
            if (remaining <= len) {
              newRange.setStart(tn, remaining);
              newRange.collapse(true);
              sel.removeAllRanges();
              sel.addRange(newRange);
              placed = true;
              break;
            }
            remaining -= len;
          }
          if (!placed) {
            newRange.selectNodeContents(el);
            newRange.collapse(false);
            sel.removeAllRanges();
            sel.addRange(newRange);
          }
        }
      }
      return;
    }
    checkContent();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) {
      setShowSlashMenu(false);
      setShowFileMenu(false);
      return;
    }
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) {
      setShowSlashMenu(false);
      setShowFileMenu(false);
      return;
    }
    const text = node.textContent || "";
    const offset = range.startOffset;
    // Scan backwards from cursor to find "@" or "/" (@ takes priority over /)
    let slashIdx = -1;
    let atIdx = -1;
    for (let i = offset - 1; i >= 0; i--) {
      if (text[i] === "@") {
        if (i === 0 || /\s/.test(text[i - 1])) atIdx = i;
        break;
      }
      if (text[i] === "/") {
        // Record slash position for /commands, but don't break — paths like @src/main contain /
        if (slashIdx < 0 && (i === 0 || /\s/.test(text[i - 1]))) slashIdx = i;
        continue;
      }
      if (/\s/.test(text[i])) break;
    }
    if (atIdx >= 0 && (taskFiles.length > 0 || agentMentionItems.length > 0)) {
      refreshTaskFilesIfNeeded();
      refreshAgentMentionCandidates();
      setFileFilter(text.slice(atIdx + 1, offset));
      setShowFileMenu(true);
      setFileSelectedIdx(0);
      setShowSlashMenu(false);
    } else if (slashIdx >= 0 && slashCommands.length > 0) {
      setSlashFilter(text.slice(slashIdx + 1, offset));
      setShowSlashMenu(true);
      setSlashSelectedIdx(0);
      setShowFileMenu(false);
    } else {
      setShowSlashMenu(false);
      setShowFileMenu(false);
    }
  }, [
    checkContent,
    isTerminalMode,
    isBusy,
    slashCommands.length,
    taskFiles.length,
    agentMentionItems.length,
    refreshTaskFilesIfNeeded,
    refreshAgentMentionCandidates,
  ]);

  /** Insert a command chip at the current cursor position, replacing the /partial text */
  const insertCommandAtCursor = useCallback(
    (name: string) => {
      const el = editableRef.current;
      if (!el) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      if (node.nodeType !== Node.TEXT_NODE) return;
      const text = node.textContent || "";
      const offset = range.startOffset;
      // Find the "/" start
      let slashIdx = -1;
      for (let i = offset - 1; i >= 0; i--) {
        if (text[i] === "/") {
          if (i === 0 || /\s/.test(text[i - 1])) slashIdx = i;
          break;
        }
        if (/\s/.test(text[i])) break;
      }
      if (slashIdx < 0) return;
      const before = text.slice(0, slashIdx);
      const after = text.slice(offset);
      const parent = node.parentNode;
      if (!parent) return;
      // Build replacement: textBefore + chip + textAfter
      const chip = createCommandChip(name);
      const frag = document.createDocumentFragment();
      if (before) frag.appendChild(document.createTextNode(before));
      frag.appendChild(chip);
      const afterNode = document.createTextNode(after || " ");
      frag.appendChild(afterNode);
      parent.replaceChild(frag, node);
      // Move cursor after chip
      const newRange = document.createRange();
      newRange.setStart(afterNode, after ? 0 : 1);
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);
      setShowSlashMenu(false);
      checkContent();
    },
    [checkContent],
  );

  /**
   * Insert a chip at the cursor position, replacing the `@partial` text.
   * Routes to the appropriate chip kind:
   *   - file mentions → file chip (existing path/displayName/category)
   *   - agent_spawn / agent_send / agent_reply → agent-graph mention chip
   * Lookups by `(path, category)` are unique within `filteredFiles` because
   * agent-graph items use synthetic path keys.
   */
  const insertFileAtCursor = useCallback(
    (filePath: string, isDir?: boolean, displayLabel?: string, category?: string) => {
      const el = editableRef.current;
      if (!el) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      if (node.nodeType !== Node.TEXT_NODE) return;
      const text = node.textContent || "";
      const offset = range.startOffset;
      // Find the "@" start
      let atIdx = -1;
      for (let i = offset - 1; i >= 0; i--) {
        if (text[i] === "@") {
          if (i === 0 || /\s/.test(text[i - 1])) atIdx = i;
          break;
        }
        if (/\s/.test(text[i])) break;
      }
      if (atIdx < 0) return;
      const before = text.slice(0, atIdx);
      const after = text.slice(offset);
      const parent = node.parentNode;
      if (!parent) return;

      const matched = filteredFiles.find(
        (f) => f.path === filePath && (f.category ?? "") === (category ?? ""),
      );
      const chip =
        matched && matched.kind && matched.kind !== "file"
          ? createAgentMentionChip(matched)
          : createFileChip(filePath, isDir, displayLabel, category);

      const frag = document.createDocumentFragment();
      if (before) frag.appendChild(document.createTextNode(before));
      frag.appendChild(chip);
      const afterNode = document.createTextNode(after || " ");
      frag.appendChild(afterNode);
      parent.replaceChild(frag, node);
      const newRange = document.createRange();
      newRange.setStart(afterNode, after ? 0 : 1);
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);
      setShowFileMenu(false);
      checkContent();
    },
    [checkContent, filteredFiles],
  );

  /** Delegated click handler for chip close buttons */
  const handleEditableMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.dataset.chipClose || target.closest("[data-chip-close]")) {
        e.preventDefault();
        const chip = target.closest("[data-command],[data-file],[data-mention-kind]");
        if (chip) {
          chip.remove();
          checkContent();
        }
      }
    },
    [checkContent],
  );

  /** Strip HTML on paste — insert plain text or handle image paste */
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      // Check for image paste
      const items = Array.from(e.clipboardData.items);
      const imageItem = items.find((i) => i.type.startsWith("image/"));
      if (imageItem && promptCaps.image) {
        e.preventDefault();
        const file = imageItem.getAsFile();
        if (file) addFileAsAttachment(file);
        return;
      }
      // Default: plain text paste
      e.preventDefault();
      const text = e.clipboardData.getData("text/plain");
      document.execCommand("insertText", false, text);
      checkContent();
    },
    [checkContent, promptCaps.image, addFileAsAttachment],
  );

  /** Handle file input selection */
  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      files.forEach((file) => {
        if (file.type.startsWith("image/") && promptCaps.image)
          void addFileAsAttachment(file);
        else if (file.type.startsWith("audio/") && promptCaps.audio)
          void addFileAsAttachment(file);
        else void addFileAsAttachment(file);
      });
      // Reset input so same file can be selected again
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [promptCaps.image, promptCaps.audio, addFileAsAttachment],
  );

  /** Drag & drop handlers */
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only set false when leaving the container (not entering a child)
    if (!e.currentTarget.contains(e.relatedTarget as Node))
      setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const files = Array.from(e.dataTransfer.files);
      files.forEach((file) => {
        if (file.type.startsWith("image/") && promptCaps.image)
          void addFileAsAttachment(file);
        else if (file.type.startsWith("audio/") && promptCaps.audio)
          void addFileAsAttachment(file);
        else void addFileAsAttachment(file);
      });
    },
    [promptCaps.image, promptCaps.audio, addFileAsAttachment],
  );

  // Re-check hasContent when attachments change
  useEffect(() => {
    checkContent();
  }, [attachments.length, checkContent]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Skip during IME composition (e.g. Chinese/Japanese input)
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;

      // Backspace: robust chip deletion for contentEditable
      if (e.key === "Backspace" && !e.metaKey && !e.altKey) {
        const sel = window.getSelection();
        if (sel && sel.isCollapsed && sel.anchorNode) {
          const anchor = sel.anchorNode;
          const offset = sel.anchorOffset;
          const isChipEl = (n: Node): n is HTMLElement =>
            n instanceof HTMLElement &&
            (n.dataset.command !== undefined ||
              n.dataset.file !== undefined ||
              n.dataset.mentionKind !== undefined);

          // Case A: Cursor at start of text node — chip is previous sibling → delete chip
          if (anchor.nodeType === Node.TEXT_NODE && offset === 0) {
            const prev = anchor.previousSibling;
            if (prev && isChipEl(prev)) {
              e.preventDefault();
              const before = prev.previousSibling;
              prev.remove();
              // Position cursor at end of preceding text, or start of container
              if (before && before.nodeType === Node.TEXT_NODE) {
                const r = document.createRange();
                r.setStart(before, (before.textContent || "").length);
                r.collapse(true);
                sel.removeAllRanges();
                sel.addRange(r);
              }
              checkContent();
              return;
            }
          }

          // Case B: Cursor in element node — previous child is chip → delete chip
          if (anchor.nodeType === Node.ELEMENT_NODE && offset > 0) {
            const prevChild = anchor.childNodes[offset - 1];
            if (isChipEl(prevChild)) {
              e.preventDefault();
              const before = prevChild.previousSibling;
              prevChild.remove();
              if (before && before.nodeType === Node.TEXT_NODE) {
                const r = document.createRange();
                r.setStart(before, (before.textContent || "").length);
                r.collapse(true);
                sel.removeAllRanges();
                sel.addRange(r);
              }
              checkContent();
              return;
            }
          }

          // Case C: Cursor in a whitespace-only text node right after a chip
          // (the trailing " " inserted as cursor placeholder after chip creation)
          // Handle deletion ourselves to prevent browser from mangling the DOM
          if (anchor.nodeType === Node.TEXT_NODE && offset > 0) {
            const text = anchor.textContent || "";
            const prev = anchor.previousSibling;
            if (prev && isChipEl(prev) && text.trimEnd().length === 0) {
              e.preventDefault();
              if (text.length <= 1) {
                // Last whitespace char — delete both the padding text node and the chip
                const beforeChip = prev.previousSibling;
                prev.remove();
                anchor.parentNode?.removeChild(anchor);
                if (beforeChip && beforeChip.nodeType === Node.TEXT_NODE) {
                  const r = document.createRange();
                  r.setStart(beforeChip, (beforeChip.textContent || "").length);
                  r.collapse(true);
                  sel.removeAllRanges();
                  sel.addRange(r);
                } else {
                  // No text before chip — position at end of remaining content
                  const el = editableRef.current;
                  if (el) {
                    const r = document.createRange();
                    r.selectNodeContents(el);
                    r.collapse(false);
                    sel.removeAllRanges();
                    sel.addRange(r);
                  }
                }
              } else {
                // Multiple whitespace chars — delete one manually
                anchor.textContent =
                  text.slice(0, offset - 1) + text.slice(offset);
                const r = document.createRange();
                r.setStart(anchor, offset - 1);
                r.collapse(true);
                sel.removeAllRanges();
                sel.addRange(r);
              }
              checkContent();
              return;
            }
          }
        }
      }

      // Shell mode: Backspace on empty input → exit shell mode
      if (isTerminalMode && e.key === "Backspace") {
        const el = editableRef.current;
        if (el && !el.textContent?.trim()) {
          e.preventDefault();
          el.innerHTML = "";
          setIsTerminalMode(false);
          return;
        }
      }
      // Shell mode: Escape → exit shell mode
      if (isTerminalMode && e.key === "Escape") {
        e.preventDefault();
        const el = editableRef.current;
        if (el) {
          // Strip highlight spans, keep plain text
          const raw = el.textContent || "";
          el.textContent = raw;
          el.blur();
        }
        setIsTerminalMode(false);
        return;
      }
      // Expanded input: Escape → collapse
      if (isInputExpanded && e.key === "Escape") {
        e.preventDefault();
        setIsInputExpanded(false);
        editableRef.current?.blur();
        return;
      }
      // Slash menu navigation
      if (showSlashMenu && filteredSlashCommands.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashSelectedIdx(
            (prev) => (prev + 1) % filteredSlashCommands.length,
          );
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashSelectedIdx(
            (prev) =>
              (prev - 1 + filteredSlashCommands.length) %
              filteredSlashCommands.length,
          );
          return;
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
          e.preventDefault();
          insertCommandAtCursor(filteredSlashCommands[slashSelectedIdx].name);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setShowSlashMenu(false);
          return;
        }
      }
      // File menu navigation
      if (showFileMenu && filteredFiles.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setFileSelectedIdx((prev) => (prev + 1) % filteredFiles.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setFileSelectedIdx(
            (prev) => (prev - 1 + filteredFiles.length) % filteredFiles.length,
          );
          return;
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
          e.preventDefault();
          const sel_item = filteredFiles[fileSelectedIdx];
          insertFileAtCursor(
            sel_item.path,
            sel_item.isDir,
            sel_item.displayName,
            sel_item.category,
          );
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setShowFileMenu(false);
          return;
        }
      }
      // Shift+Tab → cycle permission mode
      if (e.key === "Tab" && e.shiftKey && modeOptions.length > 0) {
        e.preventDefault();
        const currentIdx = modeOptions.findIndex(
          (m) => m.value === permissionLevel,
        );
        const nextIdx = (currentIdx + 1) % modeOptions.length;
        const next = modeOptions[nextIdx];
        setPermissionLevel(next.value);
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(
            JSON.stringify({ type: "set_mode", mode_id: next.value }),
          );
        }
        return;
      }
      // Cmd+Option+Backspace → clear pending queue
      if (
        e.key === "Backspace" &&
        e.metaKey &&
        e.altKey &&
        pendingMessages.length > 0
      ) {
        e.preventDefault();
        handleClearPending();
        return;
      }
      // Plain input: Escape → blur editor
      if (e.key === "Escape") {
        e.preventDefault();
        editableRef.current?.blur();
        if (typeof window !== "undefined") {
          window.getSelection()?.removeAllRanges();
        }
        return;
      }
      // Expanded mode: Cmd/Ctrl+Enter → send, plain Enter → newline
      // Inline mode: Enter → send, Shift+Enter → newline
      if (isInputExpanded) {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          handleSend();
        }
      } else {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          handleSend();
        }
      }
    },
    [
      handleSend,
      isTerminalMode,
      isInputExpanded,
      showSlashMenu,
      filteredSlashCommands,
      slashSelectedIdx,
      insertCommandAtCursor,
      showFileMenu,
      filteredFiles,
      fileSelectedIdx,
      insertFileAtCursor,
      pendingMessages,
      handleClearPending,
      modeOptions,
      permissionLevel,
      checkContent,
    ],
  );

  const toggleThinkingCollapse = useCallback((index: number) => {
    setMessages((prev) =>
      prev.map((m, i) =>
        i === index && m.type === "thinking"
          ? { ...m, collapsed: !m.collapsed }
          : m,
      ),
    );
  }, []);

  const renderItems = useMemo(() => buildRenderItems(messages), [messages]);

  // Track the message index where the current busy turn started
  const turnStartIndexRef = useRef(0);
  const wasBusyRef = useRef(false);
  if (isBusy && !wasBusyRef.current) {
    turnStartIndexRef.current = messages.length;
  }
  wasBusyRef.current = isBusy;

  const toggleSection = useCallback((sectionId: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(sectionId)) {
        next.delete(sectionId);
      } else {
        next.add(sectionId);
      }
      return next;
    });
  }, []);

  // ─── Collapsed mode ──────────────────────────────────────────────────────

  if (collapsed) {
    return (
      <motion.div
        layout
        initial={{ width: 48 }}
        animate={{ width: 48 }}
        transition={{ type: "spring", damping: 25, stiffness: 200 }}
        className="h-full flex flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] overflow-hidden cursor-pointer hover:bg-[var(--color-bg)] transition-colors"
        onClick={onExpand}
        title="Expand Chat (t)"
      >
        <div className="flex-1 flex flex-col items-center py-2">
          <div className="p-3 text-[var(--color-text-muted)]">
            {AgentIcon ? (
              <AgentIcon size={20} />
            ) : (
              <MessageSquare className="w-5 h-5" />
            )}
          </div>
          {isConnected && (
            <div className="p-3">
              <div className="w-2.5 h-2.5 rounded-full bg-[var(--color-success)] animate-pulse" />
            </div>
          )}
          <div className="flex-1" />
          <div className="p-3 text-[var(--color-text-muted)]">
            <ChevronRight className="w-5 h-5" />
          </div>
        </div>
      </motion.div>
    );
  }

  // ─── Full chat view ──────────────────────────────────────────────────────

  return (
    <motion.div
      ref={taskChatRootRef}
      tabIndex={-1}
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`flex-1 flex flex-col overflow-hidden relative outline-none ${fullscreen ? "" : "rounded-lg border border-[var(--color-border)]"}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onPointerDown={(e) => {
        // Anchor keyboard focus to the chat panel on any click, so that
        // global Cmd/Ctrl+F handlers (which gate on activeElement) recognize
        // the chat as the focused panel even when the user clicks a plain
        // text region. Form controls still receive focus afterwards because
        // the browser focuses click targets after pointerdown completes.
        const root = taskChatRootRef.current;
        if (!root) return;
        if (root === e.target || !(e.target as Element).closest?.("input,textarea,select,button,a,iframe,[contenteditable=true]")) {
          if (!root.contains(document.activeElement)) {
            root.focus({ preventScroll: true });
          }
        }
      }}
    >
      {/* Full-window drag overlay */}
      {isDragging && (
        <div className="absolute inset-0 bg-[color-mix(in_srgb,var(--color-highlight)_8%,transparent)] border-2 border-dashed border-[var(--color-highlight)] rounded-lg flex items-center justify-center z-50 pointer-events-none">
          <span className="text-[var(--color-highlight)] font-medium text-sm">
            Drop files here
          </span>
        </div>
      )}
      {chatSearchOpen && (
        <PreviewSearchBar
          query={chatSearchQuery}
          onQueryChange={setChatSearchQuery}
          total={chatSearch.total}
          current={chatSearch.current}
          onNext={chatSearch.next}
          onPrev={chatSearch.prev}
          onClose={() => { setChatSearchOpen(false); setChatSearchQuery(""); }}
          className="absolute right-3 top-12 z-[60]"
        />
      )}
      {/* Header */}
      {!hideHeader && sessionRailCollapsed && (
        <div className="relative z-30 border-b border-[color-mix(in_srgb,var(--color-border)_78%,transparent)] bg-[color-mix(in_srgb,var(--color-bg)_88%,transparent)] backdrop-blur-sm select-none">
          <div className="flex w-full items-center justify-between px-3 py-1.5">
            <div className="flex min-w-0 items-center gap-2 text-sm select-none">
              {activeChat ? (
                <div className="relative min-w-0" ref={chatMenuRef}>
                  {editingTitle?.chatId === activeChat.id &&
                  editingTitle.surface === "header" ? (
                    <div className="flex min-w-0 items-center gap-2">
                      {AgentIcon ? (
                        <AgentIcon
                          size={14}
                          className="shrink-0 text-[var(--color-text-muted)]"
                        />
                      ) : (
                        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
                      )}
                      <InlineEditTitle
                        value={editTitleValue}
                        onChange={setEditTitleValue}
                        onSave={handleTitleSave}
                        onCancel={() => setEditingTitle(null)}
                        className="min-w-0 w-48 border-b border-[var(--color-highlight)] bg-transparent px-0 py-0 text-sm text-[var(--color-text)] outline-none"
                      />
                    </div>
                  ) : (
                    <button
                      onClick={() => setShowChatMenu((prev) => !prev)}
                      onDoubleClick={() => {
                        setEditTitleValue(activeChat.title);
                        setEditingTitle({
                          chatId: activeChat.id,
                          surface: "header",
                        });
                        setShowChatMenu(false);
                      }}
                      className="flex min-w-0 items-center gap-2 text-left"
                      title="Double-click to rename"
                    >
                      {AgentIcon ? (
                        <AgentIcon
                          size={14}
                          className="shrink-0 text-[var(--color-text-muted)]"
                        />
                      ) : (
                        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
                      )}
                      <OverflowTitle
                        text={activeChat.title}
                        className="text-[13px] font-medium text-[var(--color-text)]"
                      />
                      <ChevronDown className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" />
                    </button>
                  )}

                  {showChatMenu && (
                    <div className="absolute top-full left-0 z-[80] mt-1 min-w-56 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg">
                      <div className="border-b border-[color-mix(in_srgb,var(--color-border)_72%,transparent)] bg-[var(--color-bg)] px-2 py-1">
                        <button
                          onClick={() => {
                            setShowChatMenu(false);
                            setSessionRailCollapsed(false);
                          }}
                          className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-[12px] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]"
                        >
                          <span>Open Sessions</span>
                          <ChevronRight className="h-3 w-3" />
                        </button>
                      </div>
                      <div className="max-h-64 overflow-y-auto py-1">
                        {orderedChats.map((chat) => {
                          const ChatIcon = getChatIcon(chat.agent);
                          return (
                            <div
                              key={chat.id}
                              className={`group flex cursor-pointer items-center gap-2 px-3 py-2 text-sm transition-colors ${
                                chat.id === activeChatId
                                  ? "bg-[var(--color-bg-tertiary)] text-[var(--color-text)]"
                                  : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]"
                              }`}
                              onClick={() => switchChat(chat.id)}
                            >
                              <ChatIcon className="h-3.5 w-3.5 shrink-0" />
                              <div className="min-w-0 flex-1">
                                <div className="truncate">{chat.title}</div>
                              </div>
                              {chats.length > 1 && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDeleteChat(chat.id);
                                  }}
                                  className="shrink-0 p-0.5 text-[var(--color-text-muted)] opacity-0 transition-all hover:text-[var(--color-error)] group-hover:opacity-100"
                                  title="Delete chat"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <span className="text-[var(--color-text-muted)]">
                  {agentLabel}
                </span>
              )}

              <div className="relative shrink-0" ref={headerAgentPickerRef}>
                <button
                  onClick={(e) => toggleAgentPicker(e.currentTarget)}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-highlight)]"
                  title="New Session"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1.5 select-none">
              <div
                className={`w-2.5 h-2.5 rounded-full ${isConnected ? "bg-[var(--color-success)] animate-pulse" : "bg-[var(--color-warning)]"}`}
              />
              <span className="text-xs text-[var(--color-text-muted)]">
                {isConnected ? "Connected" : "Connecting..."}
              </span>
              {onToggleFullscreen && (
                <button
                  onClick={onToggleFullscreen}
                  className="ml-1 rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]"
                  title={fullscreen ? "Exit Fullscreen" : "Fullscreen"}
                >
                  {fullscreen ? (
                    <Minimize2 className="w-3.5 h-3.5" />
                  ) : (
                    <Maximize2 className="w-3.5 h-3.5" />
                  )}
                </button>
              )}
              {onCollapse && (
                <button
                  onClick={onCollapse}
                  className="ml-1 rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]"
                  title="Minimize Chat"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div
          className={`shrink-0 border-r border-[color-mix(in_srgb,var(--color-border)_72%,transparent)] bg-[color-mix(in_srgb,var(--color-bg-secondary)_20%,transparent)] transition-all duration-200 ${sessionRailCollapsed ? "w-0 overflow-hidden border-r-transparent" : "w-[228px] overflow-hidden"}`}
        >
          <div className="flex h-full flex-col">
            <div className="border-b border-[color-mix(in_srgb,var(--color-border)_68%,transparent)] p-2 space-y-1.5">
              <div className="flex items-center gap-2 px-1">
                <button
                  onClick={() => setSessionRailCollapsed(true)}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)]"
                  title="Back to compact mode"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <div
                  className="min-w-0 flex items-center gap-2"
                  onDoubleClick={() => {
                    if (!activeChat) return;
                    setEditTitleValue(activeChat.title);
                    setEditingTitle({
                      chatId: activeChat.id,
                      surface: "sidebar-header",
                    });
                  }}
                  title="Double-click to rename"
                >
                  {AgentIcon ? (
                    <AgentIcon
                      size={14}
                      className="shrink-0 text-[var(--color-text-muted)]"
                    />
                  ) : (
                    <MessageSquare className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
                  )}
                  {activeChat &&
                  editingTitle?.chatId === activeChat.id &&
                  editingTitle.surface === "sidebar-header" ? (
                    <InlineEditTitle
                      value={editTitleValue}
                      onChange={setEditTitleValue}
                      onSave={handleTitleSave}
                      onCancel={() => setEditingTitle(null)}
                      className="min-w-0 flex-1 bg-transparent text-[13px] font-medium text-[var(--color-text)] outline-none"
                    />
                  ) : (
                    <OverflowTitle
                      text={activeChat?.title ?? "Chats"}
                      className="text-[13px] font-medium text-[var(--color-text)]"
                    />
                  )}
                </div>
              </div>
              <div className="flex items-center justify-between gap-2 px-1">
                <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                  Sessions
                </div>
                <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${isConnected ? "bg-[var(--color-success)]" : "bg-[var(--color-warning)]"}`}
                  />
                  <span>{isConnected ? "Connected" : "Connecting..."}</span>
                </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-none p-1.5">
              <div className="space-y-1">
                <div className="relative" ref={sidebarAgentPickerRef}>
                  <button
                    onClick={(e) => toggleAgentPicker(e.currentTarget)}
                    className="flex w-full items-center gap-2 rounded-md border border-dashed border-[color-mix(in_srgb,var(--color-highlight)_34%,transparent)] bg-transparent px-1.5 py-1 text-[12px] text-[var(--color-highlight)] transition-colors hover:bg-[color-mix(in_srgb,var(--color-bg-secondary)_72%,transparent)]"
                    title="New Session"
                  >
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border border-dashed border-[color-mix(in_srgb,var(--color-highlight)_34%,transparent)] text-[var(--color-highlight)]">
                      <Plus className="h-3 w-3" />
                    </div>
                    <span className="font-medium">New Session</span>
                  </button>
                </div>
                {orderedChats.map((chat) => {
                  const ChatIcon = getChatIcon(chat.agent);
                  const isActive = chat.id === activeChatId;
                  return (
                    <div
                      key={chat.id}
                      className={`group flex items-center gap-1.5 rounded-md border border-transparent px-1.5 py-1 transition-colors ${
                        isActive
                          ? "bg-[color-mix(in_srgb,var(--color-highlight)_9%,transparent)]"
                          : "text-[var(--color-text-muted)] hover:bg-[color-mix(in_srgb,var(--color-bg-secondary)_72%,transparent)] hover:text-[var(--color-text)]"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => switchChat(chat.id)}
                        onDoubleClick={() => {
                          setEditTitleValue(chat.title);
                          setEditingTitle({
                            chatId: chat.id,
                            surface: "sidebar-list",
                          });
                        }}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        title={chat.title}
                      >
                        <div
                          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border ${
                            isActive
                              ? "border-[color-mix(in_srgb,var(--color-highlight)_26%,transparent)] bg-[color-mix(in_srgb,var(--color-highlight)_10%,transparent)] text-[var(--color-highlight)]"
                              : "border-[color-mix(in_srgb,var(--color-border)_72%,transparent)] bg-transparent text-[var(--color-text-muted)]"
                          }`}
                        >
                          <ChatIcon className="h-3 w-3" />
                        </div>
                        <div className="min-w-0 flex-1">
                          {editingTitle?.chatId === chat.id &&
                          editingTitle.surface === "sidebar-list" ? (
                            <InlineEditTitle
                              value={editTitleValue}
                              onChange={setEditTitleValue}
                              onSave={handleTitleSave}
                              onCancel={() => setEditingTitle(null)}
                              className="w-full bg-transparent text-[12px] leading-5 text-[var(--color-text)] outline-none"
                            />
                          ) : (
                            <OverflowTitle
                              text={chat.title}
                              className={`text-[12px] leading-5 ${isActive ? "font-medium text-[var(--color-text)]" : ""}`}
                            />
                          )}
                        </div>
                      </button>
                      {chats.length > 1 &&
                        !(
                          editingTitle?.chatId === chat.id &&
                          editingTitle.surface === "sidebar-list"
                        ) && (
                          <button
                            onClick={() => handleDeleteChat(chat.id)}
                            className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] opacity-0 transition-all hover:text-[var(--color-error)] group-hover:opacity-100"
                            title="Delete chat"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        <div className="relative min-h-0 min-w-0 flex-1">
          {/* Messages */}
          <div
            ref={messagesViewportRef}
            className="relative z-0 h-full min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-none px-4 pt-4"
          >
            <div className="flex w-full flex-col gap-3">
              {hiddenMessageCount > 0 && (
                <div className="mx-auto max-w-[720px] rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-center text-xs text-[var(--color-text-muted)]">
                  {hiddenMessageCount.toLocaleString()} earlier messages are hidden from this view. Full history is still saved.
                </div>
              )}
              {renderItems.map((item, idx) =>
                item.kind === "single" ? (
                  <MessageItem
                    key={`m-${item.index}`}
                    message={item.message}
                    index={item.index}
                    isBusy={isBusy}
                    agentLabel={agentLabel}
                    projectId={projectId}
                    taskId={task.id}
                    isStudio={isStudioProject}
                    resolveSender={resolveSender}
                    onToggleThinkingCollapse={toggleThinkingCollapse}
                    onPermissionResponse={handlePermissionResponse}
                    onFileClick={onNavigateToFile}
                    onImageClick={setLightboxUrl}
                    onMermaidClick={setLightboxSvg}
                    onD2Click={setLightboxSvg}
                    onInsertReference={insertAttachmentReference}
                  />
                ) : (
                  <ToolSectionView
                    key={`ts-${item.sectionId}`}
                    sectionId={item.sectionId}
                    tools={item.tools}
                    expanded={expandedSections.has(item.sectionId)}
                    forceExpanded={false}
                    sectionFinished={idx < renderItems.length - 1 || !isBusy}
                    onToggleSection={toggleSection}
                    onFileClick={onNavigateToFile}
                  />
                ),
              )}
              {isBusy &&
                messages[messages.length - 1]?.type !== "assistant" &&
                messages[messages.length - 1]?.type !== "terminal_output" && (
                  <div className="flex items-center gap-2 py-1 text-sm text-[var(--color-text-muted)]">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Thinking...</span>
                  </div>
                )}
              <div ref={messagesEndRef} className="h-px w-full shrink-0" />
            </div>
          </div>

          {/* Input */}
          <div ref={inputAreaRef} className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-3 pb-4 pt-2">
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-[linear-gradient(to_top,color-mix(in_srgb,var(--color-bg)_96%,transparent),transparent)]" />
            <div className="chatbox-cq-root pointer-events-auto relative mx-auto w-full max-w-[920px]">
              {isRemoteSession && (
                <div className="absolute inset-x-0 bottom-full z-20 mb-3">
                  <div className="flex items-center justify-between gap-3 rounded-[22px] border border-[color-mix(in_srgb,var(--color-warning)_28%,transparent)] bg-[color-mix(in_srgb,var(--color-warning)_8%,transparent)] px-4 py-2.5 shadow-[0_10px_28px_rgba(0,0,0,0.12)] backdrop-blur-md">
                    <div className="flex min-w-0 items-center gap-2 text-xs text-[var(--color-warning)]">
                      <Eye className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">
                        Read-only — controlled by{" "}
                        <strong>{remoteOwnerName}</strong>
                      </span>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={handleTakeControl}
                      disabled={isTakingControl}
                      className="h-7 shrink-0 rounded-full px-3 text-xs text-[var(--color-warning)] hover:bg-[color-mix(in_srgb,var(--color-warning)_10%,transparent)] hover:text-[var(--color-text)]"
                    >
                      {isTakingControl ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : null}
                      Take Control
                    </Button>
                  </div>
                </div>
              )}
              <AnimatePresence initial={false}>
                {composerPanelOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: 10, height: 0 }}
                    animate={{ opacity: 1, y: 0, height: "auto" }}
                    exit={{ opacity: 0, y: 8, height: 0 }}
                    transition={{ duration: 0.2, ease: "easeOut" }}
                    className="mb-3 overflow-hidden rounded-[26px] border border-[color-mix(in_srgb,var(--color-border)_62%,transparent)] bg-[color-mix(in_srgb,var(--color-bg-secondary)_82%,transparent)] shadow-[0_16px_40px_rgba(0,0,0,0.14)] backdrop-blur-md"
                  >
                    <div className="max-h-72 overflow-y-auto px-3 py-3">
                      {activeComposerPanel === "todo" && (
                        <div className="space-y-1">
                          {planEntries.map((entry, i) => (
                            <div
                              key={i}
                              className="flex items-center gap-2 py-0.5 text-sm"
                            >
                              {entry.status === "completed" ? (
                                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[var(--color-success)]" />
                              ) : entry.status === "in_progress" ? (
                                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--color-highlight)]" />
                              ) : (
                                <Circle className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
                              )}
                              <span
                                className={
                                  entry.status === "completed"
                                    ? "text-[var(--color-text-muted)] line-through"
                                    : "text-[var(--color-text)]"
                                }
                              >
                                {entry.content}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}

                      {activeComposerPanel === "plan" && (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <div className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                              {planFilePath.split("/").pop()}
                            </div>
                            <button
                              onClick={handleSavePlanToNote}
                              disabled={isSavingToNote}
                              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--color-highlight)] transition-colors hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50"
                              title="Save plan to task note"
                            >
                              {isSavingToNote ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : saveToNoteDone ? (
                                <CheckCircle2 className="h-3 w-3" />
                              ) : (
                                <Bookmark className="h-3 w-3" />
                              )}
                              <span>{saveToNoteDone ? "Saved" : "Save To Note"}</span>
                            </button>
                          </div>
                          <MarkdownRenderer
                            content={planFileContent}
                            onFileClick={onNavigateToFile}
                            onMermaidClick={setLightboxSvg}
                            onD2Click={setLightboxSvg}
                            onImageClick={setLightboxUrl}
                            sketchContext={isStudioProject ? { projectId, taskId: task.id } : undefined}
                          />
                        </div>
                      )}

                      {activeComposerPanel === "pending" && (
                        <div className="space-y-1">
                          {pendingMessages.map((msg, i) => (
                            <div
                              key={i}
                              className="flex items-center gap-2 py-1 text-sm"
                            >
                              <span className="w-4 shrink-0 text-right text-xs text-[var(--color-text-muted)]">
                                {i + 1}
                              </span>
                              {editingPendingIdx === i ? (
                                <input
                                  autoFocus
                                  value={editingPendingValue}
                                  onChange={(e) =>
                                    setEditingPendingValue(e.target.value)
                                  }
                                  onKeyDown={(e) => {
                                    if (
                                      e.nativeEvent.isComposing ||
                                      e.keyCode === 229
                                    )
                                      return;
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      handleSavePendingEdit();
                                    }
                                    if (e.key === "Escape")
                                      handleCancelPendingEdit();
                                  }}
                                  onBlur={handleSavePendingEdit}
                                  className="flex-1 min-w-0 rounded border border-[var(--color-highlight)] bg-[var(--color-bg-secondary)] px-2 py-0.5 text-sm text-[var(--color-text)] outline-none"
                                />
                              ) : (
                                <>
                                  <span className="flex-1 min-w-0 truncate text-[var(--color-text)]">
                                    {msg}
                                  </span>
                                  <div className="flex items-center gap-1 shrink-0">
                                    {i === 0 && (
                                      <button
                                        onClick={() => handleSendNow()}
                                        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-[var(--color-highlight)] transition-colors hover:bg-[var(--color-bg-tertiary)]"
                                        title="Send Now"
                                      >
                                        <Send className="h-3 w-3" />
                                        <span>Now</span>
                                      </button>
                                    )}
                                    <button
                                      onClick={() => handleEditPending(i)}
                                      className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
                                      title="Edit"
                                    >
                                      <Pencil className="h-3 w-3" />
                                    </button>
                                    <button
                                      onClick={() => handleDeletePending(i)}
                                      className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-error)]"
                                      title="Delete"
                                    >
                                      <Trash2 className="h-3 w-3" />
                                    </button>
                                  </div>
                                </>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {activeComposerPanel === "previewComments" && (
                        <div className="space-y-2.5">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5">
                              <MessageSquarePlus className="h-3.5 w-3.5 text-[var(--color-highlight)]" />
                              <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
                                Preview comments
                              </span>
                              <span className="rounded-full bg-[color-mix(in_srgb,var(--color-highlight)_14%,transparent)] px-1.5 py-px text-[10px] font-medium leading-none text-[var(--color-highlight)]">
                                {taskPreviewCommentDrafts.length}
                              </span>
                            </div>
                            <button
                              onClick={() => sendPreviewComments(taskPreviewCommentDrafts)}
                              className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-semibold text-white shadow-sm transition-transform hover:scale-[1.02]"
                              style={{ background: "var(--color-highlight)" }}
                            >
                              <Send className="h-3 w-3" />
                              Send all
                            </button>
                          </div>
                          <div className="space-y-1.5">
                            {taskPreviewCommentDrafts.map((draft, idx) => {
                              const fileLabel = draft.fileName || draft.filePath.split("/").pop() || draft.filePath;
                              const dir = draft.filePath.slice(0, Math.max(0, draft.filePath.length - fileLabel.length - 1));
                              const crumb = draft.locator.selector || draft.locator.tagName;
                              return (
                                <div
                                  key={draft.id}
                                  className="group relative flex gap-2.5 rounded-xl border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-bg)_75%,transparent)] p-2 pl-2.5 transition-colors hover:border-[color-mix(in_srgb,var(--color-highlight)_40%,var(--color-border))]"
                                >
                                  <div
                                    className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white shadow-sm"
                                    style={{ background: "var(--color-highlight)" }}
                                    title="Marker shown in preview"
                                  >
                                    {idx + 1}
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <div className="line-clamp-2 whitespace-pre-wrap break-words text-[12px] leading-snug text-[var(--color-text)]">
                                      {draft.comment}
                                    </div>
                                    <div className="mt-1 flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
                                      <span className="truncate font-medium text-[var(--color-text)]" title={draft.filePath}>
                                        {fileLabel}
                                      </span>
                                      {dir && (
                                        <span className="truncate opacity-60" title={draft.filePath}>
                                          · {dir}
                                        </span>
                                      )}
                                    </div>
                                    <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--color-text-muted)] opacity-80" title={crumb}>
                                      {crumb}
                                    </div>
                                  </div>
                                  <div className="flex shrink-0 items-start gap-1 opacity-70 transition-opacity group-hover:opacity-100">
                                    <button
                                      onClick={() => sendPreviewComments([draft])}
                                      className="rounded-md p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[color-mix(in_srgb,var(--color-highlight)_12%,transparent)] hover:text-[var(--color-highlight)]"
                                      title="Send this comment"
                                    >
                                      <Send className="h-3 w-3" />
                                    </button>
                                    <button
                                      onClick={() => removePreviewCommentDraft(draft.id)}
                                      className="rounded-md p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[color-mix(in_srgb,var(--color-error)_12%,transparent)] hover:text-[var(--color-error)]"
                                      title="Remove"
                                    >
                                      <X className="h-3 w-3" />
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {activeComposerPanel === "permission" &&
                        activePermissionMessage && (
                          <div className="space-y-3">
                            <div className="flex items-center gap-2">
                              <ShieldCheck className="h-4 w-4 shrink-0 text-[var(--color-warning)]" />
                              <span className="text-sm font-medium text-[var(--color-text)]">
                                {activePermissionMessage.description}
                              </span>
                            </div>
                            <div className="space-y-2">
                              {activePermissionMessage.options.map((opt) => (
                                <button
                                  key={opt.option_id}
                                  onClick={() =>
                                    handlePermissionResponse(
                                      opt.option_id,
                                      activePermissionMessage.id,
                                    )
                                  }
                                  className="flex w-full items-center justify-between rounded-xl border border-[color-mix(in_srgb,var(--color-warning)_18%,transparent)] bg-[color-mix(in_srgb,var(--color-warning)_7%,transparent)] px-3 py-2.5 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--color-warning)_12%,transparent)]"
                                >
                                  <span className="text-sm font-medium text-[var(--color-text)]">
                                    {opt.name}
                                  </span>
                                  <ChevronRight className="h-4 w-4 text-[var(--color-warning)]" />
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <AnimatePresence>
                {showScrollToBottom && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 8 }}
                    transition={{ duration: 0.18, ease: "easeOut" }}
                    className="absolute inset-x-0 top-0 z-20 -translate-y-[118%]"
                  >
                    <button
                      onClick={() => {
                        enableAutoStickToBottom("smooth");
                        setShowScrollToBottom(false);
                      }}
                      className="group relative mx-auto flex items-center gap-2 rounded-full px-3 py-2 text-[15px] font-medium tracking-[0.01em] text-[color-mix(in_srgb,var(--color-highlight)_80%,white_4%)] transition-all duration-200 hover:text-[color-mix(in_srgb,var(--color-highlight)_96%,white_8%)] select-none"
                    >
                      <span className="pointer-events-none absolute inset-0 rounded-full bg-[color-mix(in_srgb,var(--color-highlight)_8%,transparent)] opacity-0 blur-md transition-all duration-200 group-hover:opacity-100" />
                      <span className="relative flex items-center gap-2">
                        <ArrowDown className="h-4 w-4" />
                        <span>Scroll to bottom</span>
                      </span>
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Slash command autocomplete popover */}
              <AnimatePresence>
                {showSlashMenu && filteredSlashCommands.length > 0 && (
                  <motion.div
                    ref={slashMenuRef}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 4 }}
                    transition={{ duration: 0.12 }}
                    className="absolute bottom-full left-3 right-3 mb-1 max-h-56 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg z-50"
                  >
                    {filteredSlashCommands.map((cmd, i) => (
                      <button
                        // Include index because multiple skills may share the
                        // same name (user + plugin /review etc). Duplicate
                        // React keys break reconciliation and leave orphan
                        // DOM nodes that filter can no longer remove.
                        key={`${cmd.name}-${i}`}
                        ref={(el) => {
                          slashItemRefs.current[i] = el;
                        }}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => insertCommandAtCursor(cmd.name)}
                        onMouseEnter={() => setSlashSelectedIdx(i)}
                        className={`flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors ${
                          i === slashSelectedIdx
                            ? "bg-[var(--color-bg-tertiary)]"
                            : "hover:bg-[var(--color-bg-secondary)]"
                        }`}
                      >
                        <Slash className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-highlight)]" />
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-[var(--color-text)]">
                            /{cmd.name}
                          </div>
                          <div className="truncate text-xs text-[var(--color-text-muted)]">
                            {cmd.description}
                          </div>
                        </div>
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* File @ mention autocomplete popover */}
              <FileMentionDropdown
                items={filteredFiles}
                selectedIdx={fileSelectedIdx}
                onSelect={insertFileAtCursor}
                onMouseEnter={setFileSelectedIdx}
                visible={showFileMenu}
                menuRef={fileMenuRef}
              />

              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileSelect}
              />

              <div
                ref={chatboxContainerRef}
                className={`chatbox-bubble relative min-w-0 rounded-[30px] border bg-[color-mix(in_srgb,var(--color-bg-secondary)_78%,transparent)] px-3 pt-2 pb-3 shadow-[0_22px_60px_rgba(0,0,0,0.18)] backdrop-blur-md transition-all ${
                  isBusy
                    ? "chatbox-busy-border border-transparent focus-within:border-transparent"
                    : isTerminalMode
                      ? "focus-within:border-[var(--color-warning)] border-[color-mix(in_srgb,var(--color-border)_62%,transparent)]"
                      : "focus-within:border-[color-mix(in_srgb,var(--color-highlight)_82%,white_8%)] border-[color-mix(in_srgb,var(--color-border)_62%,transparent)]"
                } select-none`}
                style={{ transform: "translateY(-6px)" }}
              >
                <div className="mb-2 flex items-center justify-between gap-2 pr-10 select-none">
                  <div className="flex min-w-0 items-center gap-2 select-none">
                    <div className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-bg)] px-2.5 py-1 text-[11px] text-[var(--color-text)] min-w-0 max-w-full">
                      {AgentIcon ? (
                        <AgentIcon
                          size={12}
                          className="shrink-0 text-[var(--color-highlight)]"
                        />
                      ) : (
                        <Bot className="w-3 h-3 shrink-0 text-[var(--color-highlight)]" />
                      )}
                      <span className="text-[var(--color-text-muted)] shrink-0">
                        Agent
                      </span>
                      <span className="truncate font-medium">{agentLabel}</span>
                      {agentQuota && (
                        <AgentQuotaPopover
                          usage={agentQuota}
                          refreshing={quotaRefreshing}
                          onRefresh={refreshAgentQuota}
                          anchorRef={chatboxContainerRef}
                        >
                          <button
                            type="button"
                            onClick={refreshAgentQuota}
                            disabled={quotaRefreshing}
                            aria-label={`Agent quota: ${Math.round(
                              quotaBadgePercentRemaining ?? 0,
                            )}% remaining${
                              agentQuota.plan ? ` on ${agentQuota.plan}` : ""
                            }${agentQuota.outdated ? ". Data may be outdated." : ""}. Click to refresh.`}
                            title={`${Math.round(
                              quotaBadgePercentRemaining ?? 0,
                            )}% remaining${agentQuota.outdated ? " — outdated" : ""} — click to refresh`}
                            className="shrink-0 rounded-full border px-1.5 text-[10px] font-semibold leading-[16px] transition-opacity hover:opacity-80 disabled:opacity-50"
                            style={{
                              color: quotaHealthColor(quotaBadgePercentRemaining ?? 0),
                              // Subtle health-tinted pill so the status is
                              // legible even at a glance: healthy green,
                              // warning amber, critical red.
                              backgroundColor: `color-mix(in srgb, ${quotaHealthColor(
                                quotaBadgePercentRemaining ?? 0,
                              )} 12%, transparent)`,
                              borderColor: `color-mix(in srgb, ${quotaHealthColor(
                                quotaBadgePercentRemaining ?? 0,
                              )} 40%, transparent)`,
                            }}
                          >
                            {Math.round(quotaBadgePercentRemaining ?? 0)}%
                          </button>
                        </AgentQuotaPopover>
                      )}
                    </div>
                    {isTerminalMode && (
                      <div className="inline-flex items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--color-warning)_10%,transparent)] px-2 py-1 text-[10px] font-medium text-[var(--color-warning)]">
                        <Terminal className="w-3 h-3" />
                        Shell
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 select-none">
                    {hasTodoPanel && (
                      <button
                        onClick={() => {
                          const next = !showPlan;
                          setShowPlan(next);
                          if (next) {
                            setShowPermissionPanel(false);
                            setShowPlanFile(false);
                            setShowPendingQueue(false);
                            setShowPreviewComments(false);
                          }
                        }}
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] transition-colors ${
                          activeComposerPanel === "todo"
                            ? "bg-[color-mix(in_srgb,var(--color-highlight)_14%,transparent)] text-[var(--color-highlight)]"
                            : "bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                        }`}
                      >
                        <ListTodo className="h-3 w-3" />
                        <span>Todo</span>
                        <span className="opacity-70">
                          {
                            planEntries.filter((e) => e.status === "completed")
                              .length
                          }
                          /{planEntries.length}
                        </span>
                      </button>
                    )}
                    {hasPlanPanel && (
                      <button
                        onClick={() => {
                          const next = !showPlanFile;
                          setShowPlanFile(next);
                          if (next) {
                            setShowPermissionPanel(false);
                            setShowPlan(false);
                            setShowPendingQueue(false);
                            setShowPreviewComments(false);
                          }
                        }}
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] transition-colors ${
                          activeComposerPanel === "plan"
                            ? "bg-[color-mix(in_srgb,var(--color-highlight)_14%,transparent)] text-[var(--color-highlight)]"
                            : "bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                        }`}
                      >
                        <BookOpen className="h-3 w-3" />
                        <span>Plan</span>
                      </button>
                    )}
                    {hasPendingPanel && (
                      <button
                        onClick={() => {
                          const next = !showPendingQueue;
                          setShowPendingQueue(next);
                          if (next) {
                            setShowPermissionPanel(false);
                            setShowPlan(false);
                            setShowPlanFile(false);
                            setShowPreviewComments(false);
                          }
                        }}
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] transition-colors ${
                          activeComposerPanel === "pending"
                            ? "bg-[color-mix(in_srgb,var(--color-highlight)_14%,transparent)] text-[var(--color-highlight)]"
                            : "bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                        }`}
                      >
                        <ListPlus className="h-3 w-3" />
                        <span>Pending</span>
                      </button>
                    )}
                    {activePermissionMessage && (
                      <button
                        onClick={() => {
                          const next = !showPermissionPanel;
                          setShowPermissionPanel(next);
                          if (next) {
                            setShowPlan(false);
                            setShowPlanFile(false);
                            setShowPendingQueue(false);
                            setShowPreviewComments(false);
                          }
                        }}
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] transition-colors ${
                          activeComposerPanel === "permission"
                            ? "bg-[color-mix(in_srgb,var(--color-warning)_18%,transparent)] text-[var(--color-warning)]"
                            : "border border-[color-mix(in_srgb,var(--color-warning)_24%,transparent)] bg-[color-mix(in_srgb,var(--color-warning)_6%,transparent)] text-[color-mix(in_srgb,var(--color-warning)_96%,white_8%)] hover:bg-[color-mix(in_srgb,var(--color-warning)_12%,transparent)]"
                        }`}
                      >
                        <ShieldCheck className="h-3 w-3" />
                        <span>Permission Request</span>
                      </button>
                    )}
                    {hasPreviewCommentsPanel && (
                      <button
                        onClick={() => {
                          const next = !showPreviewComments;
                          setShowPreviewComments(next);
                          if (next) {
                            setShowPermissionPanel(false);
                            setShowPlan(false);
                            setShowPlanFile(false);
                            setShowPendingQueue(false);
                          }
                        }}
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] transition-colors ${
                          activeComposerPanel === "previewComments"
                            ? "bg-[color-mix(in_srgb,var(--color-highlight)_14%,transparent)] text-[var(--color-highlight)]"
                            : "bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                        }`}
                      >
                        <MessageSquarePlus className="h-3 w-3" />
                        <span>Preview</span>
                        <span className="opacity-70">{taskPreviewCommentDrafts.length}</span>
                      </button>
                    )}
                  </div>
                </div>

                {attachments.length > 0 && (
                  <div className="mb-2 flex gap-2 flex-wrap select-none">
                    {attachments.map((att, i) => (
                      <div
                        key={i}
                        className="group relative flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 pr-7 max-w-full"
                      >
                        {att.type === "image" && att.previewUrl ? (
                          <img
                            src={att.previewUrl}
                            className="w-8 h-8 object-cover rounded-md border border-[var(--color-border)] shrink-0 cursor-pointer hover:opacity-80 transition-opacity"
                            alt={att.label}
                            title={att.label}
                            onClick={() => setLightboxUrl(att.previewUrl!)}
                          />
                        ) : att.type === "audio" ? (
                          <div className="w-8 h-8 rounded-md border border-[var(--color-border)] flex items-center justify-center bg-[var(--color-bg-tertiary)] shrink-0">
                            <Mic className="w-4 h-4 text-[var(--color-text-muted)]" />
                          </div>
                        ) : att.type === "resource" ? (
                          <div className="w-8 h-8 rounded-md border border-[var(--color-border)] flex items-center justify-center bg-[var(--color-bg-tertiary)] shrink-0">
                            <Paperclip className="w-4 h-4 text-[var(--color-text-muted)]" />
                          </div>
                        ) : null}
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-[var(--color-text)] truncate max-w-40">
                            {att.label}
                          </div>
                          <div className="text-[10px] text-[var(--color-text-muted)] truncate max-w-40">
                            {att.name}
                          </div>
                        </div>
                        <button
                          onClick={() => removeAttachment(i)}
                          className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-[var(--color-error)] text-white flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          &times;
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <button
                  onClick={() => {
                    setIsInputExpanded((v) => {
                      if (!v) {
                        setShowPlan(false);
                        setShowPlanFile(false);
                      }
                      return !v;
                    });
                    setTimeout(() => editableRef.current?.focus(), 0);
                  }}
                  className="absolute right-3 top-2.5 p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] rounded-lg transition-colors z-10"
                  title={
                    isInputExpanded ? "Collapse input (Esc)" : "Expand input"
                  }
                >
                  {isInputExpanded ? (
                    <Minimize2 className="w-3.5 h-3.5" />
                  ) : (
                    <Maximize2 className="w-3.5 h-3.5" />
                  )}
                </button>

                <div
                  className={`relative flex ${isTerminalMode ? "items-start" : ""}`}
                >
                  {isTerminalMode && (
                    <span className="shrink-0 pl-4 pt-2 text-sm leading-7 font-mono text-[var(--color-text-muted)] select-none">
                      $&nbsp;
                    </span>
                  )}
                  <div className="relative flex-1">
                    {!hasContent && !isInputFocused && (
                      <div
                        className={`pointer-events-none absolute top-2 text-sm leading-7 text-[var(--color-text-muted)] select-none ${
                          isTerminalMode ? "left-0 right-4" : "left-4 right-4"
                        }`}
                      >
                        {activePermissionMessage
                          ? "Handle permission above to continue"
                          : !isConnected
                            ? "Waiting for connection..."
                            : isTerminalMode
                              ? "Enter shell command\u2026"
                              : isBusy
                                ? "Queue a message\u2026"
                                : "Ask anything… use @ for mentions, / for commands"}
                      </div>
                    )}
                    <div
                      ref={editableRef}
                      contentEditable={
                        isConnected &&
                        !isRemoteSession &&
                        !activePermissionMessage
                      }
                      suppressContentEditableWarning
                      onInput={handleInput}
                      onKeyDown={handleKeyDown}
                      onMouseDown={handleEditableMouseDown}
                      onFocus={() => setIsInputFocused(true)}
                      onBlur={() => setIsInputFocused(false)}
                      onPaste={handlePaste}
                      onCompositionStart={() => {
                        composingRef.current = true;
                      }}
                      onCompositionEnd={() => {
                        composingRef.current = false;
                        handleInput();
                      }}
                      className={`overflow-y-auto py-2 text-sm leading-6 text-[var(--color-text)] focus:outline-none flex-1 ${
                        isTerminalMode ? "pr-4" : "px-4"
                      } ${
                        isInputExpanded
                          ? "min-h-[32vh] max-h-[56vh]"
                          : "min-h-[56px] max-h-32"
                      } ${!isConnected || isRemoteSession || activePermissionMessage ? "opacity-50 cursor-not-allowed" : ""} ${
                        isTerminalMode ? "font-mono" : ""
                      }`}
                      style={{
                        overflowWrap: "anywhere",
                        whiteSpace: "pre-wrap",
                      }}
                    />
                  </div>
                </div>

                <div className="chatbox-footer mt-2 flex items-center justify-between gap-2 select-none">
                  <div className="chatbox-footer-left flex items-center gap-2 min-w-0 select-none">
                    {!activePermissionMessage &&
                      (promptCaps.image || promptCaps.audio) && (
                        <button
                          onClick={() => fileInputRef.current?.click()}
                          className="h-9 w-9 flex items-center justify-center rounded-xl bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors shrink-0"
                          title="Attach file"
                        >
                          <Paperclip className="w-4 h-4" />
                        </button>
                      )}
                    <span className="truncate text-[10px] text-[var(--color-text-muted)]">
                      {activePermissionMessage
                        ? "Permission required"
                        : !isConnected
                          ? "Offline"
                          : isBusy
                            ? hasContent
                              ? "Ready to queue"
                              : pendingMessages.length > 0
                                ? `${pendingMessages.length} queued`
                                : "Agent running"
                            : isInputExpanded
                              ? "\u2318\u21A9 send \u00b7 \u21A9 newline"
                              : "Enter send"}
                    </span>
                  </div>
                  <div className="chatbox-footer-right flex items-center gap-2 shrink-0 select-none">
                    {!composerNarrow && modelOptions.length > 0 && (
                      <DropdownSelect
                        ref={modelMenuRef}
                        label="Model"
                        options={modelOptions}
                        value={selectedModel}
                        open={showModelMenu}
                        onToggle={() => {
                          setShowModelMenu(!showModelMenu);
                          setShowPermMenu(false);
                          setShowThoughtLevelMenu(false);
                        }}
                        onSelect={(v) => {
                          setSelectedModel(v);
                          setShowModelMenu(false);
                          if (wsRef.current?.readyState === WebSocket.OPEN) {
                            wsRef.current.send(
                              JSON.stringify({
                                type: "set_model",
                                model_id: v,
                              }),
                            );
                          }
                        }}
                      />
                    )}
                    {!composerNarrow && modeOptions.length > 0 && (
                      <DropdownSelect
                        ref={permMenuRef}
                        label="Mode"
                        options={modeOptions}
                        value={permissionLevel}
                        open={showPermMenu}
                        onToggle={() => {
                          setShowPermMenu(!showPermMenu);
                          setShowModelMenu(false);
                          setShowThoughtLevelMenu(false);
                        }}
                        onSelect={(v) => {
                          setPermissionLevel(v);
                          setShowPermMenu(false);
                          if (wsRef.current?.readyState === WebSocket.OPEN) {
                            wsRef.current.send(
                              JSON.stringify({ type: "set_mode", mode_id: v }),
                            );
                          }
                        }}
                      />
                    )}
                    {!composerNarrow && thoughtLevelOptions.length > 0 && thoughtLevelConfigId && (
                      <DropdownSelect
                        ref={thoughtLevelMenuRef}
                        label="Thinking"
                        options={thoughtLevelOptions}
                        value={thoughtLevel}
                        open={showThoughtLevelMenu}
                        onToggle={() => {
                          setShowThoughtLevelMenu(!showThoughtLevelMenu);
                          setShowModelMenu(false);
                          setShowPermMenu(false);
                        }}
                        onSelect={(v) => {
                          setThoughtLevel(v);
                          setShowThoughtLevelMenu(false);
                          if (wsRef.current?.readyState === WebSocket.OPEN) {
                            wsRef.current.send(
                              JSON.stringify({
                                type: "set_thought_level",
                                config_id: thoughtLevelConfigId,
                                value_id: v,
                              }),
                            );
                          }
                        }}
                      />
                    )}
                    {activePermissionMessage && isBusy ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="h-9 w-9 !p-0 rounded-xl"
                        onClick={handleStopAgent}
                      >
                        <Square className="w-3.5 h-3.5" />
                      </Button>
                    ) : !activePermissionMessage && !isBusy && hasContent ? (
                      <Button
                        variant="primary"
                        size="sm"
                        className="h-9 w-9 !p-0 rounded-xl shadow-sm"
                        onClick={handleSend}
                        disabled={!isConnected}
                      >
                        <Send className="w-3.5 h-3.5" />
                      </Button>
                    ) : !activePermissionMessage && isBusy && hasContent ? (
                      <Button
                        variant="primary"
                        size="sm"
                        className="h-9 w-9 !p-0 rounded-xl shadow-sm"
                        onClick={handleSend}
                      >
                        <ListPlus className="w-3.5 h-3.5" />
                      </Button>
                    ) : !activePermissionMessage && isBusy && !hasContent ? (
                      pendingMessages.length > 0 ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          className="h-9 w-9 !p-0 rounded-xl"
                          onClick={handleSendNow}
                        >
                          <Send className="w-3.5 h-3.5" />
                        </Button>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          className="h-9 w-9 !p-0 rounded-xl"
                          onClick={handleStopAgent}
                        >
                          <Square className="w-3.5 h-3.5" />
                        </Button>
                      )
                    ) : (
                      <Button
                        variant="primary"
                        size="sm"
                        className="h-9 w-9 !p-0 rounded-xl shadow-sm"
                        disabled
                      >
                        <Send className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {/* Image / SVG Lightbox */}
      <ImageLightbox
        imageUrl={lightboxUrl}
        svgContent={lightboxSvg}
        onClose={() => { setLightboxUrl(null); setLightboxSvg(null); }}
      />
      {showAgentPicker &&
        agentPickerAnchor &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={agentPickerMenuRef}
            style={{
              position: "fixed",
              top: agentPickerAnchor.top,
              left: agentPickerAnchor.left,
              zIndex: 1000,
            }}
            className="min-w-48 max-h-64 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg py-1"
          >
            {!acpAvailabilityLoaded && (
              <div className="flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-text-muted)]">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking...
              </div>
            )}
            {acpAvailabilityLoaded &&
              acpAgentOptions
                .filter((opt) => !opt.disabled)
                .map((opt) => {
                  const Icon = opt.icon;
                  return (
                    <button
                      key={opt.id}
                      onClick={() => handleNewChatWithAgent(opt.value)}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] transition-colors"
                    >
                      <div className="w-4 h-4 flex items-center justify-center shrink-0">
                        {Icon ? (
                          <Icon size={14} />
                        ) : (
                          <Bot className="w-3.5 h-3.5" />
                        )}
                      </div>
                      <span className="truncate">{opt.label}</span>
                    </button>
                  );
                })}
            {acpAvailabilityLoaded && customAgents.length > 0 && (
              <>
                <div className="my-1 border-t border-[var(--color-border)]" />
                <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                  Custom
                </div>
                {customAgents.map((agent) => (
                  <button
                    key={agent.id}
                    onClick={() => handleNewChatWithAgent(agent.id)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] transition-colors"
                  >
                    <div className="w-4 h-4 flex items-center justify-center shrink-0">
                      {agent.type === "remote" ? (
                        <Globe className="w-3.5 h-3.5 text-[var(--color-info)]" />
                      ) : (
                        <Terminal className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                      )}
                    </div>
                    <span className="truncate">{agent.name}</span>
                  </button>
                ))}
              </>
            )}
          </div>,
          document.body,
        )}
    </motion.div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

/** Reusable dropdown selector for bottom toolbar */
const DropdownSelect = ({
  ref,
  label,
  options,
  value,
  open,
  onToggle,
  onSelect,
}: {
  ref: React.RefObject<HTMLDivElement | null>;
  label: string;
  options: { label: string; value: string }[];
  value: string;
  open: boolean;
  onToggle: () => void;
  onSelect: (value: string) => void;
}) => {
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const enableSearch = options.length > 5;

  useEffect(() => {
    if (open && enableSearch) {
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
      });
    }
  }, [open, enableSearch]);

  useEffect(() => {
    if (!open) {
      setSearchQuery("");
    }
  }, [open]);

  const filteredOptions = useMemo(() => {
    if (!searchQuery || !enableSearch) return options;
    const q = searchQuery.toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, searchQuery, enableSearch]);

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      if (searchQuery) {
        setSearchQuery("");
      } else {
        onToggle();
      }
      e.stopPropagation();
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={onToggle}
        className="inline-flex h-7 items-center gap-1 rounded-full bg-[var(--color-bg)] px-2.5 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
      >
        <span className="chatbox-dropdown-label opacity-70">{label}</span>
        <span className="max-w-40 truncate text-[var(--color-text)]">
          {options.find((o) => o.value === value)?.label ?? "Default"}
        </span>
        <ChevronDown className="w-3 h-3 opacity-70" />
      </button>
      {open && (
        <div className="absolute bottom-full right-0 mb-1 min-w-44 max-h-64 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg py-1 z-50">
          {enableSearch && (
            <div className="px-2 pt-1.5 pb-1 border-b border-[var(--color-border)]">
              <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-[var(--color-bg-secondary)]">
                <Search className="w-3 h-3 text-[var(--color-text-muted)] flex-shrink-0" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder="Search..."
                  className="flex-1 bg-transparent text-xs text-[var(--color-text)] placeholder-[var(--color-text-muted)] outline-none min-w-0"
                />
              </div>
            </div>
          )}
          {filteredOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => onSelect(opt.value)}
              className={`w-full text-left px-3 py-1.5 text-sm flex items-center justify-between hover:bg-[var(--color-bg-tertiary)] transition-colors ${
                value === opt.value
                  ? "text-[var(--color-text)]"
                  : "text-[var(--color-text-muted)]"
              }`}
            >
              <span>{opt.label}</span>
              {value === opt.value && (
                <span className="text-[var(--color-highlight)]">✓</span>
              )}
            </button>
          ))}
          {enableSearch && filteredOptions.length === 0 && (
            <div className="px-3 py-2 text-xs text-[var(--color-text-muted)] text-center">
              No matches
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/** Individual message rendering */
const MessageItem = memo(function MessageItem({
  message,
  index,
  isBusy,
  agentLabel,
  projectId,
  taskId,
  isStudio,
  onToggleThinkingCollapse,
  onPermissionResponse,
  onFileClick,
  onImageClick,
  onMermaidClick,
  onD2Click,
  onInsertReference,
  resolveSender,
}: {
  message: ChatMessage;
  index: number;
  isBusy: boolean;
  agentLabel?: string;
  projectId: string;
  taskId: string;
  isStudio: boolean;
  onToggleThinkingCollapse: (index: number) => void;
  onPermissionResponse?: (optionId: string, requestId: string) => void;
  onFileClick?: (filePath: string, line?: number) => void;
  onImageClick?: (url: string) => void;
  onMermaidClick?: (svg: string) => void;
  onD2Click?: (svg: string) => void;
  onInsertReference?: (label: string) => void;
  resolveSender?: (sender?: string) => {
    label: string;
    Icon: React.ComponentType<{ size?: number; className?: string }>;
  };
}) {
  const sketchContext = isStudio ? { projectId, taskId } : undefined;
  const resolveImageUrl = useCallback((src: string) => {
    if (/^https?:\/\//.test(src)) return src;
    return `/api/v1/projects/${projectId}/tasks/${taskId}/file?path=${encodeURIComponent(src)}`;
  }, [projectId, taskId]);

  switch (message.type) {
    case "user":
      if (message.terminal) {
        // Simple highlight: first token = command (accent), rest = args (normal)
        const parts = message.content.match(/^(\S+)([\s\S]*)$/);
        const cmd = parts ? parts[1] : message.content;
        const args = parts ? parts[2] : "";
        return (
          <div className="flex justify-end">
            <div className="max-w-[85%]">
              <div className="rounded-xl px-3.5 py-2 bg-[var(--color-bg-tertiary)] border border-[color-mix(in_srgb,var(--color-border)_72%,transparent)] shadow-[0_10px_30px_rgba(0,0,0,0.08)]">
                <code className="text-[13px] font-mono whitespace-pre-wrap">
                  <span className="text-[var(--color-text-muted)] select-none">
                    ${" "}
                  </span>
                  <span className="text-[var(--color-accent)] font-semibold">
                    {cmd}
                  </span>
                  <span className="text-[var(--color-text)]">{args}</span>
                </code>
              </div>
            </div>
          </div>
        );
      }
      return (
        <div className="flex justify-end">
          <div className="max-w-[80%]">
            {message.sender && (() => {
              const resolved = resolveSender?.(message.sender) ?? {
                label: message.sender,
                Icon: Bot,
              };
              const SenderIcon = resolved.Icon;
              return (
                <div
                  className="text-[10px] text-[var(--color-text-muted)] text-right mb-0.5 px-1 flex items-center justify-end gap-1"
                  title={message.sender}
                >
                  <SenderIcon size={10} className="shrink-0" />
                  <span className="truncate max-w-[200px]">{resolved.label}</span>
                </div>
              );
            })()}
            <div className="rounded-2xl px-3.5 py-2.5 bg-[color-mix(in_srgb,var(--color-bg-tertiary)_78%,transparent)] border border-[color-mix(in_srgb,var(--color-border)_72%,transparent)] text-sm text-[var(--color-text)] shadow-[0_10px_30px_rgba(0,0,0,0.08)]">
              {message.attachments?.map((att, i) =>
                att.type === "image" && att.previewUrl ? (
                  <div key={i} className="group/img relative mb-2 inline-block max-w-full">
                    <img
                      src={att.previewUrl}
                      className="max-w-full max-h-48 rounded cursor-pointer hover:opacity-90 transition-opacity"
                      onClick={() => onImageClick?.(att.previewUrl!)}
                      alt={att.label}
                    />
                    {att.label && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onInsertReference?.(att.label);
                        }}
                        className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white opacity-0 backdrop-blur-sm transition-opacity group-hover/img:opacity-100 hover:!bg-[var(--color-highlight)] hover:!text-white cursor-pointer select-none"
                        title={`Insert reference to ${att.label}`}
                      >
                        {att.label}
                      </button>
                    )}
                  </div>
                ) : att.type === "audio" ? (
                  <div key={i} className="group/aud relative mb-2 max-w-full">
                    <audio
                      controls
                      src={`data:${att.mimeType};base64,${att.data}`}
                      className="max-w-full"
                    />
                    {att.label && (
                      <button
                        type="button"
                        onClick={() => onInsertReference?.(att.label)}
                        className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white opacity-0 backdrop-blur-sm transition-opacity group-hover/aud:opacity-100 hover:!bg-[var(--color-highlight)] hover:!text-white cursor-pointer select-none"
                        title={`Insert reference to ${att.label}`}
                      >
                        {att.label}
                      </button>
                    )}
                  </div>
                ) : att.type === "resource" ? (
                  <div key={i} className="group/res relative mb-2">
                    <button
                      type="button"
                      onClick={() => att.uri && openExternalUrl(att.uri)}
                      className="flex w-full max-w-[320px] items-center gap-2 rounded-xl border border-[color-mix(in_srgb,var(--color-border)_70%,transparent)] bg-[color-mix(in_srgb,var(--color-bg)_72%,transparent)] px-3 py-2 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--color-bg)_88%,transparent)]"
                      title={att.uri ?? att.name}
                    >
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[color-mix(in_srgb,var(--color-border)_72%,transparent)] bg-[var(--color-bg-secondary)]">
                        <Paperclip className="h-4 w-4 text-[var(--color-text-muted)]" />
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium text-[var(--color-text)]">
                          {att.label || att.name}
                        </div>
                        {att.name !== att.label && (
                          <div className="text-[10px] text-[var(--color-text-muted)]">
                            {att.name}{typeof att.size === "number"
                              ? ` • ${Math.max(1, Math.round(att.size / 1024))} KB`
                              : ""}
                          </div>
                        )}
                      </div>
                    </button>
                    {att.label && (
                      <button
                        type="button"
                        onClick={() => onInsertReference?.(att.label)}
                        className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white opacity-0 backdrop-blur-sm transition-opacity group-hover/res:opacity-100 hover:!bg-[var(--color-highlight)] hover:!text-white cursor-pointer select-none"
                        title={`Insert reference to ${att.label}`}
                      >
                        {att.label}
                      </button>
                    )}
                  </div>
                ) : null,
              )}
              {message.content && (
                <div className="whitespace-pre-wrap break-words">{message.content}</div>
              )}
            </div>
          </div>
        </div>
      );
    case "assistant":
      // Skip empty/whitespace-only assistant messages
      if (!message.content.trim()) return null;
      return (
        <div className="flex justify-start">
          <div className="max-w-[82%] text-sm text-[var(--color-text)]">
            <MarkdownRenderer
              content={message.content}
              onFileClick={onFileClick}
              resolveImageUrl={resolveImageUrl}
              onMermaidClick={onMermaidClick}
              onD2Click={onD2Click}
              onImageClick={onImageClick}
              enableRunCommand
              sketchContext={sketchContext}
            />
            {!message.complete && isBusy && (
              <span className="inline-block w-1.5 h-4 ml-0.5 bg-[var(--color-text-muted)] animate-pulse rounded-sm" />
            )}
          </div>
        </div>
      );
    case "thinking":
      return (
        <div className="flex justify-start" data-grove-search-skip="true">
          <div className="max-w-[82%] w-full">
            <button
              onClick={() => onToggleThinkingCollapse(index)}
              className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors mb-1"
            >
              <Brain className="w-3 h-3" />
              {message.collapsed ? (
                <ChevronRight className="w-3 h-3" />
              ) : (
                <ChevronDown className="w-3 h-3" />
              )}
              <span className="italic">
                {message.complete ? "Thought" : "Thinking"}
              </span>
            </button>
            {!message.collapsed && (
              <div className="ml-5 rounded-lg px-3 py-2 bg-[var(--color-bg-tertiary)] text-xs text-[var(--color-text-muted)] italic whitespace-pre-wrap max-h-40 overflow-y-auto">
                {message.content}
              </div>
            )}
          </div>
        </div>
      );
    case "permission":
      return message.resolved ? (
        <PermissionCard message={message} onRespond={onPermissionResponse} />
      ) : null;
    case "tool":
      // Tools are rendered via ToolSectionView; skip here
      return null;
    case "system": {
      const displayContent =
        message.content === "$$CONNECTED$$"
          ? `Connected to ${agentLabel || "Agent"}`
          : message.content;
      return (
        <div className="text-center text-xs text-[var(--color-text-muted)] py-1">
          {displayContent}
        </div>
      );
    }
    case "terminal_output": {
      const hasExited = message.exitCode !== undefined;
      const isError = hasExited && message.exitCode !== 0;
      const output = message.chunks.join("");
      return (
        <div className="flex justify-start">
          <div className="max-w-[90%] w-full">
            <div
              className={`rounded-xl border overflow-hidden ${
                isError
                  ? "border-[color-mix(in_srgb,var(--color-error)_40%,transparent)]"
                  : "border-[color-mix(in_srgb,var(--color-border)_72%,transparent)]"
              } bg-[var(--color-bg-secondary)]`}
            >
              {output && (
                <pre className="px-3 py-2 text-[12px] font-mono text-[var(--color-text-secondary)] whitespace-pre-wrap overflow-x-auto max-h-[300px] overflow-y-auto">
                  {output}
                </pre>
              )}
              {hasExited && (
                <div
                  className={`flex items-center gap-1.5 px-3 py-1 text-[10px] font-medium border-t ${
                    isError
                      ? "border-[color-mix(in_srgb,var(--color-error)_30%,transparent)] text-[var(--color-error)] bg-[color-mix(in_srgb,var(--color-error)_8%,transparent)]"
                      : "border-[color-mix(in_srgb,var(--color-border)_50%,transparent)] text-[var(--color-text-muted)] bg-[var(--color-bg-tertiary)]"
                  }`}
                >
                  <Terminal className="w-3 h-3" />
                  exit {message.exitCode}
                </div>
              )}
              {!hasExited && (
                <div className="flex items-center gap-1.5 px-3 py-1 text-[10px] text-[var(--color-text-muted)] border-t border-[color-mix(in_srgb,var(--color-border)_50%,transparent)] bg-[var(--color-bg-tertiary)]">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-warning)] animate-pulse" />
                  running...
                </div>
              )}
            </div>
          </div>
        </div>
      );
    }
  }
});

/** Permission request card with action buttons */
function PermissionCard({
  message,
  onRespond,
}: {
  message: PermissionMessage;
  onRespond?: (optionId: string, requestId: string) => void;
}) {
  const isResolved = !!message.resolved;
  const isCancelled =
    isResolved && message.resolved!.toLowerCase() === "cancelled";
  const isAllowed =
    isResolved &&
    (message.resolved!.toLowerCase().includes("allow") ||
      message.resolved!.toLowerCase().includes("yes"));

  if (isResolved) {
    return (
      <div
        className={`flex items-center gap-2 py-1.5 px-3 rounded-lg text-xs border ${
          isCancelled
            ? "bg-[color-mix(in_srgb,var(--color-warning)_8%,transparent)] border-[color-mix(in_srgb,var(--color-warning)_24%,transparent)]"
            : "bg-[var(--color-bg-tertiary)] border-[var(--color-border)]"
        }`}
      >
        {isCancelled ? (
          <AlertTriangle className="w-3.5 h-3.5 text-[var(--color-warning)] shrink-0" />
        ) : isAllowed ? (
          <ShieldCheck className="w-3.5 h-3.5 text-[var(--color-success)] shrink-0" />
        ) : (
          <ShieldX className="w-3.5 h-3.5 text-[var(--color-error)] shrink-0" />
        )}
        <span
          className={
            isCancelled
              ? "text-[color-mix(in_srgb,var(--color-warning)_92%,white_6%)]"
              : "text-[var(--color-text-muted)]"
          }
        >
          {message.description}
        </span>
        <span
          className={`ml-auto text-[10px] ${isCancelled ? "text-[var(--color-warning)]" : "text-[var(--color-text-muted)] opacity-70"}`}
        >
          {message.resolved}
        </span>
      </div>
    );
  }

  const allowOptions = message.options.filter((o) =>
    o.kind.startsWith("allow"),
  );
  const rejectOptions = message.options.filter((o) =>
    o.kind.startsWith("reject"),
  );

  return (
    <div
      className="rounded-lg border-l-3 border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] overflow-hidden"
      style={{ borderLeftColor: "var(--color-warning)", borderLeftWidth: 3 }}
    >
      <div className="px-3 py-2.5">
        <div className="flex items-center gap-2 mb-2">
          <ShieldCheck className="w-4 h-4 text-[var(--color-warning)] shrink-0" />
          <span className="text-sm text-[var(--color-text)]">
            Permission Required
          </span>
        </div>
        <p className="text-xs text-[var(--color-text-muted)] mb-3 ml-6 break-words">
          {message.description}
        </p>
        <div className="flex items-center gap-2 ml-6 flex-wrap">
          {allowOptions.map((opt) => (
            <button
              key={opt.option_id}
              onClick={() => onRespond?.(opt.option_id, message.id)}
              className="px-3 py-1 rounded-md text-xs font-medium transition-colors bg-[var(--color-success)] text-white hover:opacity-80"
              style={{
                backgroundColor:
                  "color-mix(in srgb, var(--color-success) 85%, white)",
              }}
            >
              {opt.name}
            </button>
          ))}
          {rejectOptions.map((opt) => (
            <button
              key={opt.option_id}
              onClick={() => onRespond?.(opt.option_id, message.id)}
              className="px-3 py-1 rounded-md text-xs font-medium transition-colors border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-error)]"
            >
              {opt.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function normalizeToolVerb(title: string): string {
  const lower = title.toLowerCase();
  if (lower.startsWith("read")) return "read";
  if (lower.startsWith("edit") || lower.startsWith("write")) return "edit";
  if (
    lower.startsWith("run") ||
    lower === "terminal" ||
    lower === "exec_command" ||
    lower === "write_stdin"
  )
    return "run";
  if (
    lower.startsWith("search") ||
    lower === "grep" ||
    lower.startsWith("find") ||
    lower === "glob" ||
    lower === "toolsearch"
  )
    return "search";
  if (lower.startsWith("list") || lower.startsWith("ls")) return "list";
  if (lower.startsWith("task") || lower.startsWith("update_plan"))
    return "plan";
  if (lower.includes("permission")) return "permission";
  return "other";
}

function isEditTool(message: ToolMessage): boolean {
  return normalizeToolVerb(message.title) === "edit";
}

/**
 * Finer-grained kind specifically for Action chip rendering.
 * Determines the icon + label-extraction strategy per tool.
 */
type ActionKind =
  | "bash"
  | "bash_output"
  | "skill"
  | "todo"
  | "mcp"
  | "permission"
  | "generic";

function classifyActionKind(title: string): ActionKind {
  const lower = title.toLowerCase().trim();
  // 注：不匹配 "terminal"（会被 isBackgroundAction 先剔掉，走不到这里）。
  if (lower === "bash" || lower.startsWith("run ")) return "bash";
  if (lower === "bash_output") return "bash_output";
  if (lower === "skill" || lower === "skill_use") return "skill";
  if (
    lower === "todo_write" ||
    lower === "todowrite" ||
    lower === "update_plan"
  )
    return "todo";
  if (lower.startsWith("mcp__") || lower.startsWith("mcp_")) return "mcp";
  if (lower.includes("permission")) return "permission";
  return "generic";
}

/**
 * Extract a short, informative label for a non-Edit action chip.
 * Falls back to tool title when nothing better is derivable.
 */
function extractActionChipLabel(
  message: ToolMessage,
  kind: ActionKind,
): string {
  const content = message.content ?? "";
  const locations = message.locations ?? [];
  const firstLoc = locations[0];

  const firstNonEmptyLine = (text: string): string => {
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line) return line;
    }
    return "";
  };

  switch (kind) {
    case "bash":
    case "bash_output": {
      // Content typically starts with the command or its output.
      // If it looks like a shell command (starts with a letter and no obvious
      // error/usage prefix), surface its first line. Otherwise fall back to
      // the tool title so we at least say "bash".
      const first = firstNonEmptyLine(content);
      if (!first) return extractRawActionLabel(message);
      // Heuristic: if first line starts with a known error/usage marker, it's
      // output not the command — fall back to title so we don't mislabel.
      if (/^(error|usage|traceback|panic|command not found)/i.test(first)) {
        return extractRawActionLabel(message);
      }
      return first;
    }
    case "skill": {
      // Skill content usually opens with either YAML frontmatter
      // (--- name: xxx ---) or a JSON-ish `"name": "..."` snippet.
      const fm = /^---\s*[\s\S]*?\bname:\s*([^\n]+)/.exec(content);
      if (fm) return `skill · ${fm[1].trim().replace(/["']/g, "")}`;
      const json = /"name"\s*:\s*"([^"]+)"/.exec(content);
      if (json) return `skill · ${json[1]}`;
      const firstHeading = /^#\s+(.+)$/m.exec(content);
      if (firstHeading) return `skill · ${firstHeading[1]}`;
      return "skill";
    }
    case "todo": {
      // Content is usually JSON with a todos array; extract counts.
      try {
        const parsed = JSON.parse(content);
        const todos = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.todos)
            ? parsed.todos
            : Array.isArray(parsed?.entries)
              ? parsed.entries
              : null;
        if (todos && todos.length > 0) {
          const inProgress = todos.find(
            (t: { status?: string }) => t?.status === "in_progress",
          );
          const active = inProgress?.content ?? inProgress?.title ?? null;
          return active
            ? `${todos.length} todos · ${String(active).slice(0, 40)}`
            : `${todos.length} todos`;
        }
      } catch {
        /* fall through */
      }
      return extractRawActionLabel(message);
    }
    case "mcp": {
      // Title like "mcp__grove__grove_list_projects" → "grove · list_projects"
      const t = message.title;
      const parts = t.split("__").filter(Boolean);
      if (parts.length >= 3 && parts[0].toLowerCase() === "mcp") {
        const server = parts[1];
        const fn = parts.slice(2).join("_");
        // Strip redundant `<server>_` prefix if backend double-namespaces it.
        const fnPretty = fn.startsWith(`${server}_`)
          ? fn.slice(server.length + 1)
          : fn;
        return `${server} · ${fnPretty}`;
      }
      return t;
    }
    case "permission":
      return "Permission request";
    case "generic":
    default: {
      if (firstLoc?.path) {
        const base = firstLoc.path.split("/").pop() || firstLoc.path;
        return base;
      }
      return extractRawActionLabel(message);
    }
  }
}

function renderActionKindIcon(
  kind: ActionKind,
  className = "h-3 w-3 shrink-0",
) {
  switch (kind) {
    case "bash":
    case "bash_output":
      return <Terminal className={className} />;
    case "skill":
      return <Sparkles className={className} />;
    case "todo":
      return <ListTodo className={className} />;
    case "mcp":
      return <Plug className={className} />;
    case "permission":
      return <ShieldCheck className={className} />;
    default:
      return <Wrench className={className} />;
  }
}

function isBackgroundAction(message: ToolMessage): boolean {
  const verb = normalizeToolVerb(message.title);
  // Generic "Terminal" events often lack the actual command text and only provide
  // broad shell output. Treat them as background exploration instead of a primary
  // action so the UI does not surface a low-signal "Terminal" action chip.
  return (
    verb === "read" ||
    verb === "search" ||
    verb === "list" ||
    message.title.toLowerCase() === "terminal"
  );
}

function getToolNavMode(message: ToolMessage): "diff" | "full" {
  return isEditTool(message) ? "diff" : "full";
}

type ToolLocationChip = {
  key: string;
  label: string;
  path: string;
  line?: number;
  isDirectory: boolean;
  status?: string;
  mode: "diff" | "full";
};

const KNOWN_FILE_BASENAMES = new Set([
  "makefile",
  "dockerfile",
  "license",
  "readme",
  "procfile",
  "gemfile",
  "rakefile",
  "justfile",
  "brewfile",
  ".gitignore",
  ".gitattributes",
  ".gitmodules",
  ".env",
  ".editorconfig",
  ".npmrc",
  ".nvmrc",
  ".prettierrc",
  ".eslintrc",
  ".clang-format",
  ".dockerignore",
]);

function getLocationLabel(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || normalized;
}

function isIgnorableLocationLabel(label: string): boolean {
  return label === "" || label === "." || label === "..";
}

function looksLikeFileLabel(label: string): boolean {
  const lower = label.toLowerCase();
  if (KNOWN_FILE_BASENAMES.has(lower)) return true;
  if (label.startsWith(".") && label.length > 1) return true;
  if (label.includes(".")) return true;
  if (/[A-Z]/.test(label)) return true;
  return false;
}

function isDirectoryLocation(
  message: ToolMessage,
  location: NonNullable<ToolMessage["locations"]>[number],
): boolean {
  const label = getLocationLabel(location.path);
  if (isIgnorableLocationLabel(label)) return true;
  if (location.line != null) return false;
  if (location.path.endsWith("/")) return true;
  if (isEditTool(message)) return false;
  const verb = normalizeToolVerb(message.title);
  if (verb === "read") return false;
  if (looksLikeFileLabel(label)) return false;
  return verb === "search" || verb === "list" || verb === "run";
}

function collectLocationChips(
  tools: ToolSectionItem[],
  predicate: (message: ToolMessage) => boolean,
): ToolLocationChip[] {
  const seen = new Set<string>();
  const chips: ToolLocationChip[] = [];

  for (const tool of tools) {
    if (!predicate(tool.message)) continue;
    for (const loc of tool.message.locations ?? []) {
      const label = getLocationLabel(loc.path);
      if (isIgnorableLocationLabel(label)) continue;
      const isDirectory = isDirectoryLocation(tool.message, loc);
      const key = `${isDirectory ? "dir" : "file"}:${label}:${loc.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      chips.push({
        key,
        label,
        path: loc.path,
        line: loc.line,
        isDirectory,
        status: tool.message.status,
        mode: getToolNavMode(tool.message),
      });
    }
  }

  return chips;
}

function parseDiffStat(
  content?: string,
): { additions: number; deletions: number } | null {
  if (!content) return null;
  const lines = content.split("\n");
  const looksLikeDiff = lines.some(
    (line) =>
      line.startsWith("@@ ") ||
      line.startsWith("@@") ||
      line.startsWith("diff --git ") ||
      line.startsWith("+++ ") ||
      line.startsWith("--- "),
  );
  if (!looksLikeDiff) return null;
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (
      line.startsWith("+++ ") ||
      line.startsWith("--- ") ||
      line.startsWith("@@") ||
      line.startsWith("diff --git ") ||
      line.startsWith("index ")
    )
      continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  if (additions === 0 && deletions === 0) return null;
  return { additions, deletions };
}

function formatActionCount(count: number): string | null {
  if (count <= 0) return null;
  return `${count} action${count !== 1 ? "s" : ""}`;
}

function formatInspectionCount(count: number): string | null {
  if (count <= 0) return null;
  return `${count} inspection step${count !== 1 ? "s" : ""}`;
}

function truncateChipLabel(label: string, maxLength = 72): string {
  const singleLine = label.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function extractRawActionLabel(message: ToolMessage): string {
  const title = message.title.replace(/^Run\s+/i, "");
  const verb = normalizeToolVerb(message.title);
  if (verb === "run") return title;
  if (verb === "permission") return "Permission request";
  if (verb === "plan") return "Plan update";
  return title;
}

/** Strip outermost code fence wrapper (```lang\n...\n```) if present */
function stripWrappingFence(raw: string): string {
  const lines = raw.split("\n");
  if (
    lines.length >= 3 &&
    /^```\w*$/.test(lines[0].trim()) &&
    lines[lines.length - 1].trim() === "```"
  ) {
    return lines.slice(1, -1).join("\n");
  }
  return raw;
}

function extractFailureReason(tools: ToolSectionItem[]): string | null {
  for (const tool of tools) {
    const m = tool.message;
    if (m.status !== "error" && m.status !== "failed") continue;
    const content = m.content?.trim();
    if (!content) return `Failed during ${extractRawActionLabel(m)}`;
    const stripped = stripWrappingFence(content)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!stripped) return `Failed during ${extractRawActionLabel(m)}`;
    return stripped.slice(0, 180);
  }
  return null;
}

function summarizeToolSection(tools: ToolSectionItem[], sectionFinished: boolean) {
  const running = tools.filter((t) => t.message.status === "running").length;
  const failed = tools.filter(
    (t) => t.message.status === "error" || t.message.status === "failed",
  ).length;
  const cancelled = tools.filter(
    (t) => t.message.status === "cancelled",
  ).length;
  const total = tools.length;
  const succeeded = total - running - failed - cancelled;
  // Only compute terminal statuses when the section is truly finished
  // (i.e. a new message/thinking/turn-end appeared after this tool section, or chat is idle)
  const settled = sectionFinished && running === 0;
  const allFailed = settled && failed > 0 && succeeded === 0;
  const partialFailed = settled && failed > 0 && !allFailed;

  // statusLabel: only show when it adds info beyond the title
  const statusLabel =
    !settled
      ? ""
      : partialFailed
        ? `${failed} failed`
        : cancelled > 0 && succeeded > 0
          ? `${cancelled} cancelled`
          : "";
  const edits = tools.filter((t) => isEditTool(t.message));
  const foregroundActions = tools.filter(
    (t) => !isEditTool(t.message) && !isBackgroundAction(t.message),
  );
  const backgroundActions = tools.filter((t) => isBackgroundAction(t.message));

  let title = "Working";
  if (allFailed) title = "Action failed";
  else if (partialFailed) title = "Completed with errors";
  else if (
    tools.some((t) => normalizeToolVerb(t.message.title) === "permission")
  )
    title = "Waiting for permission";
  else if (edits.length > 0)
    title = running > 0 || !settled ? "Editing files" : "Edits applied";
  else if (foregroundActions.length > 0)
    title = running > 0 || !settled ? "Running actions" : "Actions complete";
  else if (backgroundActions.length > 0)
    title = running > 0 || !settled ? "Inspecting code" : "Inspection complete";

  // Merge edits on the same file: accumulate +/- and keep the latest tool id/status
  const editItems = (() => {
    const merged = new Map<string, { key: string; toolId: string; label: string; fullPath: string; additions: number; deletions: number; status: string }>();
    for (const tool of edits) {
      const loc = tool.message.locations?.[0];
      const fullPath = loc?.path ?? "";
      const label =
        fullPath.split("/").pop() ||
        tool.message.title.replace(/^(Edit|Write)\s+/i, "");
      const stat = parseDiffStat(tool.message.content);
      const existing = merged.get(label);
      if (existing) {
        existing.additions += stat?.additions ?? 0;
        existing.deletions += stat?.deletions ?? 0;
        existing.toolId = tool.message.id;
        existing.status = tool.message.status;
        // Use the longest (most specific) full path
        if (fullPath.length > existing.fullPath.length) existing.fullPath = fullPath;
      } else {
        merged.set(label, {
          key: `${tool.message.id}:${label}`,
          toolId: tool.message.id,
          label,
          fullPath,
          additions: stat?.additions ?? 0,
          deletions: stat?.deletions ?? 0,
          status: tool.message.status,
        });
      }
    }
    return Array.from(merged.values());
  })();

  const actionItems = foregroundActions.map((tool) => {
    const kind = classifyActionKind(tool.message.title);
    const derived = extractActionChipLabel(tool.message, kind);
    return {
      key: tool.message.id,
      kind,
      label: truncateChipLabel(derived),
      rawTitle: tool.message.title,
      content: tool.message.content ?? "",
      locations: tool.message.locations ?? [],
      status: tool.message.status,
    };
  });

  const inspectionEntries = collectLocationChips(tools, isBackgroundAction);
  const inspectionFiles = inspectionEntries.filter(
    (entry) => !entry.isDirectory,
  );
  const actionEntries = collectLocationChips(
    tools,
    (message) => !isBackgroundAction(message) && !isEditTool(message),
  );
  const actionFiles = actionEntries.map((entry) => entry.label);

  const totalActionCount = edits.length + actionItems.length;
  const inspectionSectionSummary =
    inspectionFiles.length > 0
      ? `Reviewed ${inspectionFiles.length} file${inspectionFiles.length > 1 ? "s" : ""}`
      : null;
  const totalAffectedFiles = new Set([...actionFiles, ...editItems.map((e) => e.label)]).size;
  const actionSectionSummary =
    totalAffectedFiles > 0
      ? `Action on ${totalAffectedFiles} file${totalAffectedFiles > 1 ? "s" : ""}`
      : formatActionCount(totalActionCount);
  const headerSummary =
    backgroundActions.length > 0 &&
    edits.length === 0 &&
    foregroundActions.length === 0
      ? (inspectionSectionSummary ??
        formatInspectionCount(backgroundActions.length))
      : (actionSectionSummary ?? formatActionCount(totalActionCount));

  // Determine dominant section type for icon selection
  const sectionType: "inspection" | "edit" | "action" =
    edits.length > 0
      ? "edit"
      : backgroundActions.length > 0 &&
          foregroundActions.length === 0
        ? "inspection"
        : "action";

  return {
    title,
    statusLabel,
    sectionType,
    headerSummary,
    actionSectionSummary,
    editItems,
    actionItems,
    visibleActionItems: actionItems.slice(0, 4),
    actionItemOverflow: Math.max(0, actionItems.length - 4),
    inspectionSectionSummary,
    inspectionEntries,
    inspectionVisibleEntries: inspectionEntries.slice(0, 3),
    inspectionOverflow: Math.max(0, inspectionEntries.length - 3),
    actionEntries,
    actionVisibleEntries: actionEntries.slice(0, 3),
    actionOverflow: Math.max(0, actionEntries.length - 3),
    failureReason: extractFailureReason(tools),
    running,
    failed,
    cancelled,
  };
}

function getStatusChipClasses(status: string, muted = false): string {
  if (status === "error" || status === "failed") {
    return "bg-[color-mix(in_srgb,var(--color-warning)_16%,var(--color-bg))] text-[color-mix(in_srgb,var(--color-warning)_92%,white_8%)] border border-[color-mix(in_srgb,var(--color-warning)_28%,transparent)]";
  }
  if (status === "running") {
    return muted
      ? "bg-[color-mix(in_srgb,var(--color-highlight)_10%,var(--color-bg))] text-[color-mix(in_srgb,var(--color-highlight)_80%,white_8%)] border border-[color-mix(in_srgb,var(--color-highlight)_18%,transparent)]"
      : "bg-[color-mix(in_srgb,var(--color-highlight)_12%,var(--color-bg))] text-[var(--color-text)] border border-[color-mix(in_srgb,var(--color-highlight)_18%,transparent)]";
  }
  if (status === "cancelled") {
    return "bg-[color-mix(in_srgb,var(--color-text-muted)_10%,var(--color-bg))] text-[var(--color-text-muted)] border border-[color-mix(in_srgb,var(--color-text-muted)_18%,transparent)]";
  }
  return muted
    ? "bg-[color-mix(in_srgb,var(--color-bg-secondary)_78%,var(--color-bg))] text-[var(--color-text-muted)] border border-[color-mix(in_srgb,var(--color-border)_65%,transparent)]"
    : "bg-[color-mix(in_srgb,var(--color-bg-secondary)_88%,var(--color-bg))] text-[var(--color-text)] border border-[color-mix(in_srgb,var(--color-border)_70%,transparent)]";
}

type ActionChipItem = {
  key: string;
  kind: ActionKind;
  label: string;
  rawTitle: string;
  content: string;
  locations: { path: string; line?: number }[];
  status: string;
};

/** Single clickable / expandable action chip. */
function ActionChip({
  item,
  expanded,
  onToggleExpand,
  onFileClick,
}: {
  item: ActionChipItem;
  expanded: boolean;
  onToggleExpand: () => void;
  onFileClick?: (
    filePath: string,
    line?: number,
    mode?: "diff" | "full",
  ) => void;
}) {
  const hasContent = item.content.trim().length > 0;
  const hasLocation = item.locations.length > 0;
  // Click priority: navigate to first location if one exists; otherwise
  // toggle inline expand. If neither exists, the chip is still a button
  // (keeps UI consistent) but click is a no-op.
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (hasLocation) {
      const loc = item.locations[0];
      onFileClick?.(loc.path, loc.line, "full");
      return;
    }
    if (hasContent) onToggleExpand();
  };
  const isInteractive = hasLocation || hasContent;
  // chip 尾部提示：有 location → 箭头出链（可跳文件）；有 content → Chevron
  // 指示可展开/已展开；无交互 → 不显示，避免骗点击。
  const trailingHint = hasLocation ? (
    <ExternalLink className="h-3 w-3 shrink-0 text-[var(--color-text-muted)] opacity-70" />
  ) : hasContent ? (
    expanded ? (
      <ChevronUp className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" />
    ) : (
      <ChevronDown className="h-3 w-3 shrink-0 text-[var(--color-text-muted)] opacity-70" />
    )
  ) : null;
  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={!isInteractive}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] transition-colors ${
        isInteractive
          ? "cursor-pointer hover:brightness-110"
          : "cursor-default"
      } ${getStatusChipClasses(item.status)}`}
    >
      {item.status === "running" ? (
        <Loader2 className="h-3 w-3 animate-spin text-[var(--color-highlight)] shrink-0" />
      ) : (
        renderActionKindIcon(item.kind)
      )}
      <span className="truncate max-w-[280px]">{item.label}</span>
      {trailingHint}
    </button>
  );
}

/**
 * List of action chips plus per-chip expanded detail panels.
 * Keeps chips in a flex-wrap row; expanded content panels render below in
 * insertion order (so visual grouping stays tight).
 */
function ActionChipList({
  items,
  overflowCount,
  onShowMore,
  expandedKeys,
  onToggleExpand,
  onFileClick,
}: {
  items: ActionChipItem[];
  overflowCount: number;
  onShowMore: () => void;
  expandedKeys: Set<string>;
  onToggleExpand: (key: string) => void;
  onFileClick?: (
    filePath: string,
    line?: number,
    mode?: "diff" | "full",
  ) => void;
}) {
  const expandedItems = items.filter((it) => expandedKeys.has(it.key));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <ActionChip
            key={item.key}
            item={item}
            expanded={expandedKeys.has(item.key)}
            onToggleExpand={() => onToggleExpand(item.key)}
            onFileClick={onFileClick}
          />
        ))}
        {overflowCount > 0 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onShowMore();
            }}
            className="inline-flex items-center rounded-full border border-[color-mix(in_srgb,var(--color-border)_65%,transparent)] bg-[color-mix(in_srgb,var(--color-bg-secondary)_80%,var(--color-bg))] px-2.5 py-1 text-[11px] text-[var(--color-text-muted)] hover:bg-[color-mix(in_srgb,var(--color-bg-secondary)_95%,var(--color-bg))] hover:text-[var(--color-text)] cursor-pointer transition-colors"
          >
            +{overflowCount} more actions
          </button>
        )}
      </div>
      {expandedItems.length > 0 && (
        <div className="space-y-2">
          {expandedItems.map((item) => {
            const renderMarkdown =
              item.kind === "skill" ||
              item.kind === "todo" ||
              item.kind === "mcp";
            return (
              <div
                key={`${item.key}:expanded`}
                className="rounded-lg border border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-[color-mix(in_srgb,var(--color-bg-secondary)_58%,transparent)] px-3 py-2"
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                    {item.rawTitle || "action"}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleExpand(item.key);
                    }}
                    className="ml-auto text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] cursor-pointer transition-colors"
                  >
                    collapse
                  </button>
                </div>
                {renderMarkdown ? (
                  <div className="text-[12px] leading-[1.45]">
                    <MarkdownRenderer content={item.content} />
                  </div>
                ) : (
                  <pre className="text-[11px] leading-[1.45] font-mono whitespace-pre-wrap break-all text-[var(--color-text)] m-0">
                    {item.content || "(no output)"}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ExpandableFileChipGroup({
  title,
  summary,
  visibleEntries,
  allEntries,
  expanded,
  onToggleExpanded,
  onFileClick,
  muted = true,
}: {
  title: string;
  summary?: string | null;
  visibleEntries: ToolLocationChip[];
  allEntries: ToolLocationChip[];
  expanded: boolean;
  onToggleExpanded: () => void;
  onFileClick?: (
    filePath: string,
    line?: number,
    mode?: "diff" | "full",
  ) => void;
  muted?: boolean;
}) {
  const overflow = Math.max(0, allEntries.length - visibleEntries.length);
  const renderEntry = (entry: ToolLocationChip) => (
    <button
      key={entry.key}
      type="button"
      disabled={entry.isDirectory}
      onClick={() => {
        if (!entry.isDirectory)
          onFileClick?.(entry.path, entry.line, entry.mode);
      }}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] ${
        entry.isDirectory
          ? "bg-[color-mix(in_srgb,var(--color-bg-secondary)_80%,var(--color-bg))] text-[var(--color-text-muted)] border border-[color-mix(in_srgb,var(--color-border)_65%,transparent)] disabled:cursor-default disabled:opacity-85"
          : getStatusChipClasses(entry.status ?? "completed", muted)
      }`}
    >
      <VSCodeIcon
        filename={entry.label}
        size={13}
        isFolder={entry.isDirectory}
      />
      {entry.label}
    </button>
  );

  return (
    <div className="space-y-2">
      <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
        {title}
        {summary ? (
          <span className="ml-2 normal-case tracking-normal text-[11px] opacity-80">
            {summary}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {visibleEntries.map(renderEntry)}
        {overflow > 0 && (
          <button
            type="button"
            onClick={onToggleExpanded}
            className="inline-flex items-center rounded-full border border-[color-mix(in_srgb,var(--color-border)_65%,transparent)] bg-[color-mix(in_srgb,var(--color-bg-secondary)_80%,var(--color-bg))] px-2.5 py-1 text-[11px] text-[var(--color-text-muted)]"
          >
            {expanded ? "Show less" : `+${overflow} more`}
          </button>
        )}
      </div>
      {expanded && overflow > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {allEntries.slice(visibleEntries.length).map(renderEntry)}
        </div>
      )}
    </div>
  );
}

/** Collapsible section that groups consecutive tool calls */
const ToolSectionView = memo(function ToolSectionView({
  sectionId,
  tools,
  expanded,
  forceExpanded,
  sectionFinished,
  onToggleSection,
  onFileClick,
}: {
  sectionId: string;
  tools: ToolSectionItem[];
  expanded: boolean;
  forceExpanded: boolean;
  sectionFinished: boolean;
  onToggleSection: (sectionId: string) => void;
  onFileClick?: (
    filePath: string,
    line?: number,
    mode?: "diff" | "full",
  ) => void;
}) {
  const sectionExpanded = forceExpanded || expanded;
  const summary = useMemo(() => summarizeToolSection(tools, sectionFinished), [tools, sectionFinished]);
  const [inspectionExpanded, setInspectionExpanded] = useState(false);
  const [actionExpanded, setActionExpanded] = useState(false);
  const [actionItemsExpanded, setActionItemsExpanded] = useState(false);
  const [expandedActionKeys, setExpandedActionKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const hasDetails =
    summary.inspectionEntries.length > 0 ||
    summary.editItems.length > 0 ||
    summary.actionItems.length > 0 ||
    summary.actionEntries.length > 0;
  const DoneIcon =
    summary.sectionType === "edit"
      ? Pencil
      : summary.sectionType === "inspection"
        ? Eye
        : Terminal;
  const summaryIcon =
    summary.running > 0 ? (
      <Loader2 className="w-3.5 h-3.5 text-[var(--color-highlight)] animate-spin shrink-0" />
    ) : summary.failed > 0 || summary.cancelled > 0 ? (
      <DoneIcon className="w-3.5 h-3.5 text-[var(--color-warning)] shrink-0" />
    ) : (
      <DoneIcon className="w-3.5 h-3.5 text-[var(--color-success)] shrink-0" />
    );
  const collapsedSecondaryText = summary.failureReason ?? summary.headerSummary;
  return (
    <motion.div
      layout
      transition={{ duration: 0.2, ease: "easeOut" }}
      className={`rounded-xl border border-[color-mix(in_srgb,var(--color-border)_72%,transparent)] transition-colors ${
        sectionExpanded
          ? "bg-[color-mix(in_srgb,var(--color-bg-secondary)_72%,transparent)] px-3 py-3"
          : `bg-[color-mix(in_srgb,var(--color-bg-secondary)_62%,transparent)] px-3 py-2.5${hasDetails ? " hover:bg-[color-mix(in_srgb,var(--color-bg-secondary)_82%,transparent)]" : ""}`
      }`}
    >
      <div
        role={hasDetails ? "button" : undefined}
        onClick={hasDetails ? () => onToggleSection(sectionId) : undefined}
        className={`flex gap-2.5${sectionExpanded ? " items-start" : " items-center"}${hasDetails ? " cursor-pointer" : ""}`}
      >
        <div className={sectionExpanded ? "pt-0.5" : ""}>{summaryIcon}</div>
        <div className="min-w-0 flex-1">
          {!sectionExpanded ? (
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-sm font-medium text-[var(--color-text)]">
                {summary.title}
              </span>
              {summary.statusLabel ? (
                <span className="shrink-0 text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                  {summary.statusLabel}
                </span>
              ) : null}
              {collapsedSecondaryText ? (
                <span
                  className={`min-w-0 truncate text-xs ${summary.failureReason ? "text-[color-mix(in_srgb,var(--color-warning)_95%,white_4%)]" : "text-[var(--color-text-muted)]"}`}
                  title={collapsedSecondaryText}
                >
                  <span className="mr-1 text-[var(--color-text-muted)]">·</span>
                  {collapsedSecondaryText}
                </span>
              ) : null}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-[var(--color-text)]">
                  {summary.title}
                </span>
                {summary.statusLabel ? (
                  <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                    {summary.statusLabel}
                  </span>
                ) : null}
              </div>
              {summary.failureReason && (
                <div className="mt-1 rounded-lg border border-[color-mix(in_srgb,var(--color-warning)_20%,transparent)] bg-[color-mix(in_srgb,var(--color-warning)_8%,transparent)] px-2.5 py-2 text-xs text-[color-mix(in_srgb,var(--color-warning)_95%,white_4%)]">
                  {summary.failureReason}
                </div>
              )}
              {!summary.failureReason && (
                <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                  {summary.headerSummary}
                </div>
              )}
            </>
          )}
        </div>
        {hasDetails ? (
          <motion.div
            animate={{ rotate: sectionExpanded ? 90 : 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className={`shrink-0 ${sectionExpanded ? "mt-0.5" : ""}`}
          >
            <ChevronRight className="w-3 h-3 text-[var(--color-text-muted)]" />
          </motion.div>
        ) : null}
      </div>

      <AnimatePresence initial={false}>
        {sectionExpanded && hasDetails && (
          <motion.div
            key="tool-section-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="mt-3 border-t border-[color-mix(in_srgb,var(--color-border)_62%,transparent)] pt-3 space-y-3">
              {summary.inspectionEntries.length > 0 && (
                <ExpandableFileChipGroup
                  title="Inspection"
                  summary={summary.inspectionSectionSummary}
                  visibleEntries={summary.inspectionVisibleEntries}
                  allEntries={summary.inspectionEntries}
                  expanded={inspectionExpanded}
                  onToggleExpanded={() => setInspectionExpanded((v) => !v)}
                  onFileClick={onFileClick}
                  muted
                />
              )}

              {summary.editItems.length > 0 && (
                <div className="space-y-2">
                  <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                    Edit
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {summary.editItems.map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        onClick={() => {
                          const tool = tools.find(
                            (t) => t.message.id === item.toolId,
                          )?.message;
                          const path = item.fullPath || tool?.locations?.[0]?.path;
                          if (path && tool)
                            onFileClick?.(
                              path,
                              undefined,
                              getToolNavMode(tool),
                            );
                        }}
                        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] ${getStatusChipClasses(item.status)}`}
                      >
                        <VSCodeIcon filename={item.label} size={13} />
                        <span>{item.label}</span>
                        {(item.additions > 0 || item.deletions > 0) && (
                          <span className="text-[10px]">
                            <span className="text-[var(--color-success)]">
                              +{item.additions}
                            </span>
                            <span className="mx-0.5 text-[var(--color-text-muted)]">
                              /
                            </span>
                            <span className="text-[var(--color-error)]">
                              -{item.deletions}
                            </span>
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {(summary.actionItems.length > 0 ||
                summary.actionEntries.length > 0) && (
                <div className="space-y-2">
                  {summary.actionEntries.length > 0 && (
                    <ExpandableFileChipGroup
                      title="Action"
                      summary={summary.actionSectionSummary}
                      visibleEntries={summary.actionVisibleEntries}
                      allEntries={summary.actionEntries}
                      expanded={actionExpanded}
                      onToggleExpanded={() => setActionExpanded((v) => !v)}
                      onFileClick={onFileClick}
                      muted
                    />
                  )}
                  {(summary.visibleActionItems.length > 0 ||
                    summary.actionItemOverflow > 0) && (
                    <ActionChipList
                      items={
                        actionItemsExpanded
                          ? summary.actionItems
                          : summary.visibleActionItems
                      }
                      overflowCount={
                        actionItemsExpanded ? 0 : summary.actionItemOverflow
                      }
                      onShowMore={() => setActionItemsExpanded(true)}
                      expandedKeys={expandedActionKeys}
                      onToggleExpand={(key) =>
                        setExpandedActionKeys((prev) => {
                          const next = new Set(prev);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })
                      }
                      onFileClick={onFileClick}
                    />
                  )}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
});
