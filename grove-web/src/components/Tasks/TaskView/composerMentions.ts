import type { FilteredMentionItem, MentionItem } from "../../../utils/fileMention";
import { filterMentionItems } from "../../../utils/fileMention";
import { buildGroveMetaTag } from "../../../utils/groveMeta";
import { agentIconUrl } from "../../../utils/agentIcon";
import type { ProjectListItem } from "../../../api/projects";
import type { ProjectMentionContent } from "./projectMentions";
import { mentionStatus, projectMentionItems } from "./projectMentions";
import { createFileChip } from "./fileMentionChip";

/*
 * The composer's @-mention pieces, shared by TaskChat and Orbit's New page:
 * chip DOM, how chips serialize into the prompt, the `@category:` trigger,
 * and what the picker lists for a query.
 */

/** Categories reachable with `@category:`; Sketches only in Studio projects. */
export type MentionCategory = "conversation" | "file" | "agent" | "project" | "browsertabs" | "sketch";

export function mentionCategories(studio: boolean): MentionCategory[] {
  return studio
    ? ["conversation", "file", "agent", "project", "browsertabs", "sketch"]
    : ["conversation", "file", "agent", "project", "browsertabs"];
}

/** The category rows shown for a bare `@`. */
export function mentionCategorySelectors(options: { studio: boolean; browserTabs: boolean }): MentionItem[] {
  const base: MentionItem[] = [
    { path: "conversation", displayName: "Conversation", category: "category_selector", kind: "chat_history", isDir: false },
    { path: "file", displayName: "Files", category: "category_selector", kind: "file", isDir: true },
    { path: "agent", displayName: "Agents", category: "category_selector", kind: "agent_spawn", isDir: false },
    { path: "project", displayName: "Projects", category: "category_selector", kind: "file", isDir: true },
  ];
  if (options.studio) {
    base.push({ path: "sketch", displayName: "Sketches", category: "category_selector", kind: "file", isDir: true });
  }
  if (options.browserTabs) {
    base.push({ path: "browsertabs", displayName: "Browser Tabs", category: "category_selector", kind: "browsertabs", isDir: false });
  }
  return base;
}

/** Index of the `@` that starts the mention being typed at `offset`, or -1. */
export function mentionStartIndex(text: string, offset: number, studio: boolean): number {
  const lastAt = text.lastIndexOf("@", offset - 1);
  if (lastAt < 0 || (lastAt > 0 && !/\s/.test(text[lastAt - 1]))) return -1;
  const segment = text.slice(lastAt, offset);
  const hasCategory = mentionCategories(studio).some((category) => segment.startsWith(`@${category}:`));
  return hasCategory || !/\s/.test(segment) ? lastAt : -1;
}

/** The mention being typed at `offset`: its `@` index, `@category:` and query. */
export function parseMentionQuery(text: string, offset: number, studio: boolean): { atIdx: number; category: MentionCategory | null; filter: string } | null {
  const atIdx = mentionStartIndex(text, offset, studio);
  if (atIdx < 0) return null;
  const mentionText = text.slice(atIdx + 1, offset);
  const colonIdx = mentionText.indexOf(":");
  if (colonIdx >= 0) {
    const possible = mentionText.slice(0, colonIdx).toLowerCase() as MentionCategory;
    if (mentionCategories(studio).includes(possible)) {
      return { atIdx, category: possible, filter: mentionText.slice(colonIdx + 1) };
    }
  }
  return { atIdx, category: null, filter: mentionText };
}

export interface MentionFilterInput {
  /** Agent-graph and chat-history candidates followed by the task's files. */
  items: MentionItem[];
  browserTabs: MentionItem[];
  selectors: MentionItem[];
  activeCategory: string | null;
  /** The live query, used where a stale list would act on the wrong project. */
  filter: string;
  /** The deferred query, for the heavier lists. */
  deferredFilter: string;
  projects: ProjectListItem[];
  projectContents: Record<string, ProjectMentionContent | undefined>;
  projectsLoading: boolean;
  projectsError: boolean;
}

/** What the @ picker lists for the current category and query. */
export function filterComposerMentions(input: MentionFilterInput): FilteredMentionItem[] {
  const { items, browserTabs, selectors, activeCategory, filter, deferredFilter, projects, projectContents, projectsLoading, projectsError } = input;
  const conversationItems = items.filter((item) => item.kind === "chat_history");
  const agentItems = items.filter((item) =>
    item.kind === "agent_spawn" || item.kind === "agent_send" || item.kind === "agent_reply");
  const fileItems = items.filter((item) => !conversationItems.includes(item) && !agentItems.includes(item));

  if (activeCategory === "conversation") return filterMentionItems(conversationItems, deferredFilter, 20);
  if (activeCategory === "agent") return filterMentionItems(agentItems, deferredFilter, 20);
  if (activeCategory === "file") return filterMentionItems(fileItems, deferredFilter, 20);
  if (activeCategory === "browsertabs") return filterMentionItems(browserTabs, deferredFilter, 20);
  if (activeCategory === "sketch") {
    return filterMentionItems(fileItems.filter((item) => item.category === "Sketch"), deferredFilter, 20);
  }
  if (activeCategory === "project") {
    // Use the current input here so Enter immediately after choosing a project
    // cannot act on the previous, deferred project list.
    const slashIdx = filter.indexOf("/");
    if (slashIdx >= 0) {
      const projectName = filter.slice(0, slashIdx).toLowerCase();
      const project = projects.find((p) => p.name.toLowerCase() === projectName);
      if (project) return projectMentionItems(project, projectContents[project.id], filter.slice(slashIdx + 1));
    }
    // No project chosen yet: list the matching projects.
    const projectItems: MentionItem[] = projects.map((p) => ({
      path: p.name, // path holds project name for Category trigger
      isDir: p.project_type === "studio",
      displayName: p.name,
      category: p.project_type === "studio" ? "Studio Project" : "Coding Project",
      kind: p.project_type === "studio" ? "agent_spawn" : "file",
      sessionId: p.id,
    }));
    const listed = filterMentionItems(projectItems, filter, 20);
    if (projectsLoading) listed.push(mentionStatus("loading-projects", "Refreshing projects…"));
    else if (projectsError) listed.push(mentionStatus("error-projects", "Could not refresh projects. Reopen Projects to retry.", "Error"));
    return listed;
  }

  // Aggregated search (no category yet).
  if (!deferredFilter) {
    // Empty query: the category rows first, then a few quick picks.
    const unscored = (item: MentionItem): FilteredMentionItem => ({ ...item, score: 0, indices: [] });
    return [
      ...selectors.map(unscored),
      ...conversationItems.slice(0, 3).map(unscored),
      ...agentItems.slice(0, 3).map(unscored),
    ];
  }
  // Non-empty query: search every category, with files capped to avoid noise.
  const matchedSelectors = filterMentionItems(selectors, deferredFilter, 4);
  const combined = [
    ...filterMentionItems(conversationItems, deferredFilter, 20),
    ...filterMentionItems(agentItems, deferredFilter, 20),
    ...filterMentionItems(fileItems, deferredFilter, 20),
  ].sort((a, b) => b.score - a.score);
  return [...matchedSelectors, ...combined];
}

/** The chip for a picked mention: browser tab, agent-graph / history, or file. */
export function createMentionChip(
  matched: MentionItem | undefined,
  path: string,
  isDir: boolean | undefined,
  displayLabel: string | undefined,
  category: string | undefined,
  accentPalette?: string[],
): HTMLSpanElement {
  if (matched?.kind === "browsertabs") {
    return createBrowserTabChip(path, displayLabel || path, matched.sessionId ? Number(matched.sessionId) : undefined);
  }
  if (matched?.kind && matched.kind !== "file") return createAgentMentionChip(matched);
  return createFileChip(
    path,
    isDir,
    displayLabel || (matched?.displayName ?? ""),
    category,
    matched?.favIconUrl,
    matched?.category === "Project Root" ? matched.sessionId : undefined,
    accentPalette,
  );
}

/** True for a chip element (command, file or mention) inside the composer. */
export function isComposerChip(node: Node | null | undefined): node is HTMLElement {
  return node instanceof HTMLElement &&
    (node.dataset.command !== undefined || node.dataset.file !== undefined || node.dataset.mentionKind !== undefined);
}

/** Create a dynamic browser tab mention pill DOM element.
 *
 * `tabId` is the Chrome tab id (when known); stored on the chip so that
 * `getPromptFromEditable` can serialize it into a `<grove-meta>` envelope —
 * giving downstream agents enough info to drive the tab via the
 * `grove_browser_*` MCP tools.
 */
export function createBrowserTabChip(url: string, title: string, tabId?: number): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.mentionKind = "browsertabs";
  chip.dataset.tabUrl = url;
  chip.dataset.tabTitle = title;
  if (typeof tabId === "number" && Number.isFinite(tabId)) {
    chip.dataset.tabId = String(tabId);
  }
  chip.title = `${title} (${url})`;

  chip.style.cssText =
    "display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:9999px;" +
    "background:color-mix(in srgb,var(--color-bg-secondary) 80%,var(--color-bg));" +
    "border:1px solid color-mix(in srgb,var(--color-border) 65%,transparent);" +
    "font-size:12px;font-weight:500;color:var(--color-accent);" +
    "margin:0 2px;user-select:none;vertical-align:baseline;line-height:1.5;";

  let faviconUrl = "";
  try {
    const domain = new URL(url).hostname;
    faviconUrl = `https://www.google.com/s2/favicons?sz=32&domain=${domain}`;
  } catch {
    // Bad URL — leave favicon empty; the chip stays readable without an icon.
  }

  if (faviconUrl) {
    const img = document.createElement("img");
    img.src = faviconUrl;
    img.alt = "";
    img.width = 13;
    img.height = 13;
    img.style.cssText =
      "display:inline-block;vertical-align:middle;flex-shrink:0;border-radius:2px;";
    img.onerror = () => {
      img.style.display = "none";
    };
    chip.appendChild(img);
  }

  const label = document.createElement("span");
  // Long titles (e.g. an Open Graph description scraped from <meta>) blow
  // up the chat input box and the chip itself. Truncate visually while
  // keeping the full title in dataset.tabTitle for serialization.
  const MAX_CHIP_TITLE = 40;
  label.textContent =
    title.length > MAX_CHIP_TITLE ? `${title.slice(0, MAX_CHIP_TITLE).trimEnd()}…` : title;
  label.style.cssText = "max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
  chip.appendChild(label);

  const closeBtn = document.createElement("span");
  closeBtn.dataset.chipClose = "true";
  closeBtn.textContent = "\u00d7";
  closeBtn.style.cssText =
    "margin-left:2px;cursor:pointer;opacity:0.6;font-size:13px;line-height:1;color:var(--color-accent);";
  chip.appendChild(closeBtn);

  return chip;
}

/**
 * Create an agent-graph @-mention pill. Three kinds, all rendered as a single
 * non-editable inline atom. Metadata is stored on dataset attrs and consumed
 * by `getPromptFromEditable` at send time to expand into the spec §6 template
 * string.
 */
export function createAgentMentionChip(item: MentionItem): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.mentionKind = item.kind ?? "file";
  // Per-kind metadata; absent fields are simply not serialized.
  if (item.sessionId) chip.dataset.sessionId = item.sessionId;
  if (item.msgId) chip.dataset.msgId = item.msgId;
  if (item.duty != null) chip.dataset.duty = item.duty;
  if (item.agentName) chip.dataset.agentName = item.agentName;
  if (item.displayName) chip.dataset.displayName = item.displayName;
  if (item.historyPath) chip.dataset.historyPath = item.historyPath;

  // Neutral surface — readable in any theme. Type is conveyed by the brand
  // icon + the optional ↩ glyph for reply, not by tinted color.
  chip.style.cssText =
    "display:inline-flex;align-items:center;gap:4px;padding:1px 6px;border-radius:4px;" +
    "background:var(--color-bg-tertiary);" +
    "border:1px solid var(--color-border);" +
    "font-size:12px;font-weight:500;color:var(--color-text);" +
    "margin:0 2px;user-select:none;vertical-align:baseline;line-height:1.5;";
  if (item.kind === "agent_send" && item.duty) {
    chip.title = `${item.displayName ?? ""} — ${item.duty}`;
  }
  if (item.kind === "agent_reply" && item.msgId) {
    chip.title = `Reply to ${item.displayName ?? ""} (msg ${item.msgId})`;
  }
  if (item.kind === "chat_history" && item.historyPath) {
    chip.title = `Share history of "${item.displayName ?? ""}" — ${item.historyPath}`;
  }

  // Layout: <verb> <agent_icon> <name>
  //   - mention_spawn        → "Spawn  <icon> <agent>"
  //   - mention_send         → "Send To <icon> <session>"
  //   - mention_reply        → "Reply To <icon> <session>"
  //   - mention_chat_history → "Share History <icon> <chat>"
  const name = item.displayName ?? item.agentName ?? "";
  const action =
    item.kind === "agent_spawn"
      ? "Spawn"
      : item.kind === "agent_send"
        ? "Send To"
        : item.kind === "chat_history"
          ? "Share History"
          : "Reply To";
  const verb = document.createElement("span");
  verb.textContent = action;
  verb.style.cssText = "opacity:0.7;font-weight:500;";
  chip.appendChild(verb);

  const iconUrl = agentIconUrl(item.agentName);
  if (iconUrl) {
    const img = document.createElement("img");
    img.src = iconUrl;
    img.alt = "";
    img.style.cssText =
      "width:12px;height:12px;flex-shrink:0;display:inline-block;vertical-align:-2px;";
    chip.appendChild(img);
  }

  const label = document.createElement("span");
  label.textContent = name;
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
 * Expand an agent-graph @-mention chip into a `<grove-meta>` envelope. The
 * envelope's `system-prompt` field carries the spec §6 instruction text the AI
 * reads; the `data` field carries the rendering metadata the receiving chat's
 * frontend uses to draw a pill. Grove never calls the underlying
 * `grove_agent_*` tools itself — the AI decides whether to act on the hint.
 */
function expandAgentMentionChip(node: HTMLElement): string {
  const kind = node.dataset.mentionKind;
  if (kind === "agent_spawn") {
    const agent = node.dataset.agentName ?? node.dataset.displayName ?? "";
    return buildGroveMetaTag(
      "mention_spawn",
      { agent },
      `@[agent=${agent} · use grove_agent_graph_spawn to create a Session, then grove_agent_graph_send to dispatch]`,
    );
  }
  if (kind === "agent_send") {
    const id = node.dataset.sessionId ?? "";
    const name = node.dataset.displayName ?? "";
    const duty = node.dataset.duty ?? "";
    const agent = node.dataset.agentName ?? "";
    const data: Record<string, unknown> = { sid: id, name };
    if (duty) data.duty = duty;
    if (agent) data.agent = agent;
    return buildGroveMetaTag(
      "mention_send",
      data,
      `@[session id=${id}, name=${name}, duty="${duty}" · use grove_agent_graph_send(to="${id}") to dispatch]`,
    );
  }
  if (kind === "agent_reply") {
    const id = node.dataset.sessionId ?? "";
    const name = node.dataset.displayName ?? "";
    const msg = node.dataset.msgId ?? "";
    const agent = node.dataset.agentName ?? "";
    const data: Record<string, unknown> = { sid: id, name, msg_id: msg };
    if (agent) data.agent = agent;
    return buildGroveMetaTag(
      "mention_reply",
      data,
      `@[session id=${id}, name=${name}, pending_msg=${msg} · use grove_agent_graph_reply(msg_id="${msg}") to respond]`,
    );
  }
  if (kind === "chat_history") {
    const cid = node.dataset.sessionId ?? "";
    const name = node.dataset.displayName ?? "";
    const file = node.dataset.historyPath ?? "";
    const agent = node.dataset.agentName ?? "";
    const data: Record<string, unknown> = { chat_id: cid, name, file };
    if (agent) data.agent = agent;
    return buildGroveMetaTag(
      "mention_chat_history",
      data,
      `@[chat_history name="${name}" file="${file}" · this is another chat's history.jsonl in the same task; read the file to see the conversation]`,
    );
  }
  return "";
}

/** Extract prompt text from a contentEditable element, converting chips to /command */
export function getPromptFromEditable(el: HTMLElement): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent || "");
    } else if (node instanceof HTMLElement) {
      if (node.dataset.mentionKind === "browsertabs") {
        const url = node.dataset.tabUrl || "";
        const title = node.dataset.tabTitle || "";
        const tabIdRaw = node.dataset.tabId;
        const tabId = tabIdRaw ? Number(tabIdRaw) : undefined;
        if (url) {
          // Standard <grove-meta v=1> envelope:
          // - `type` dispatches to a frontend renderer (browser_tab → pill chip)
          // - `data` carries the machine-readable payload
          // - `system-prompt` is the human-readable fallback used by the agent
          //   AND by the UI when the renderer is missing / errors
          const data: { url: string; title: string; tab_id?: number } = {
            url,
            title,
          };
          if (typeof tabId === "number" && Number.isFinite(tabId)) {
            data.tab_id = tabId;
          }
          const tabIdHint =
            typeof tabId === "number" && Number.isFinite(tabId)
              ? ` Use this tab_id (${tabId}) with the grove_browser_* MCP tools to drive the tab.`
              : "";
          const envelope = {
            v: 1,
            type: "browser_tab",
            data,
            "system-prompt": `Browser tab reference: ${title || url} (${url}).${tabIdHint}`,
          };
          // Encode `<` / `>` as unicode escapes so a title containing
          // `</grove-meta>` doesn't accidentally close the envelope tag
          // (the receiver's non-greedy regex matches the first
          // `</grove-meta>` and would feed truncated JSON to JSON.parse).
          const safeJson = JSON.stringify(envelope)
            .replace(/</g, "\\u003c")
            .replace(/>/g, "\\u003e");
          parts.push(`<grove-meta>${safeJson}</grove-meta>`);
        }
      } else if (node.dataset.mentionKind && node.dataset.mentionKind !== "file") {
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
