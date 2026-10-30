import type { ChatMessage } from "./TaskChat";
import type { ToolCallMessage as ToolMessage } from "./toolCallReducer";
import { classifyActionKind, isBackgroundAction, isEditTool, toolDisplayName, toolVerb } from "./toolCallIdentity";
import { extractDiffForEditPath, extractEditToolPaths } from "./editToolPaths";

export type ToolSectionItem = { message: ToolMessage; index: number };
export type WorkSummaryItem = {
  message: Extract<ChatMessage, { type: "assistant" | "thinking" | "tool" }>;
  index: number;
};
export type RenderItem =
  | { kind: "single"; message: ChatMessage; index: number; sourceIndex?: number }
  | { kind: "tool-section"; sectionId: string; tools: ToolSectionItem[]; lastToolId?: string }
  | {
      kind: "work-summary";
      sectionId: string;
      items: WorkSummaryItem[];
      durationSeconds?: number;
      lastToolId?: string;
    };

export function shouldRenderTimelineTool(message: ToolMessage): boolean {
  return message.kind !== "think" || ["failed", "error", "cancelled"].includes(message.status);
}

/** Group consecutive tool messages into sections; everything else is a single item */
export function buildSequentialRenderItems(
  messages: ChatMessage[],
  startIndex = 0,
  lastToolId?: string | null,
): RenderItem[] {
  const items: RenderItem[] = [];
  let toolBuf: ToolSectionItem[] = [];
  const turnLastToolIds: Array<string | undefined> = [];
  let turnLastToolId: string | undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.type === "user") turnLastToolId = undefined;
    else if (message.type === "tool" && message.kind !== "think" && !turnLastToolId) turnLastToolId = message.id;
    turnLastToolIds[i] = turnLastToolId;
  }

  const flush = () => {
    if (toolBuf.length > 0) {
      items.push({
        kind: "tool-section",
        sectionId: toolBuf[0].message.id,
        tools: [...toolBuf],
        lastToolId: lastToolId === null ? undefined : lastToolId ?? turnLastToolIds[toolBuf[0].index - startIndex],
      });
      toolBuf = [];
    }
  };

  messages.forEach((msg, offset) => {
    const i = startIndex + offset;
    if (msg.type === "plan_document") return;
    if (msg.type === "tool" && !shouldRenderTimelineTool(msg)) return;
    if (msg.type === "thinking" && msg.complete) {
      // Keep completed reasoning in history but out of the transcript.
      return;
    } else if (msg.type === "tool") {
      toolBuf.push({ message: msg, index: i });
    } else if (msg.type === "auth_required") {
      // 不进消息流 — 由 composer panel 统一渲染(同 PermissionRequest)。
      // 留在 messages 数组里只为方便用 useMemo 派生 activeAuthMessage。
      flush();
    } else {
      flush();
      items.push({ kind: "single", message: msg, index: i });
    }
  });
  flush();
  return items;
}

/**
 * Keep the live turn chronological, then compact completed turns in the same
 * way command-oriented agents do: everything through the final tool call is
 * one expandable work record, while the answer emitted after that boundary
 * remains fully visible.
 */
export function buildRenderItems(messages: ChatMessage[], isBusy = false): RenderItem[] {
  const items: RenderItem[] = [];
  let cursor = 0;

  while (cursor < messages.length) {
    let userIndex = cursor;
    while (userIndex < messages.length && messages[userIndex].type !== "user") {
      userIndex += 1;
    }
    if (userIndex >= messages.length) {
      const remaining = messages.slice(cursor);
      const live = isBusy || remaining.some((message) => (message.type === "assistant" || message.type === "thinking") && !message.complete);
      items.push(...buildSequentialRenderItems(remaining, cursor, live ? null : undefined));
      break;
    }

    items.push(...buildSequentialRenderItems(messages.slice(cursor, userIndex), cursor));
    items.push({ kind: "single", message: messages[userIndex], index: userIndex });

    let nextUserIndex = userIndex + 1;
    while (
      nextUserIndex < messages.length &&
      messages[nextUserIndex].type !== "user"
    ) {
      nextUserIndex += 1;
    }
    const isLatestTurn = nextUserIndex === messages.length;
    const turnEntries = messages.slice(userIndex + 1, nextUserIndex);
    const lastToolId = lastToolCallId(turnEntries);
    const hasStreamingEntry = turnEntries.some(
      (message) =>
        (message.type === "assistant" || message.type === "thinking") &&
        !message.complete,
    );

    if ((isLatestTurn && isBusy) || hasStreamingEntry) {
      items.push(
        ...buildSequentialRenderItems(turnEntries, userIndex + 1, null),
      );
      cursor = nextUserIndex;
      continue;
    }

    // Compaction dividers and rich assistant content are hard boundaries.
    // Notices and subagent anchors remain outside the work summary, but must
    // not disable compaction of the rest of this turn.
    let segmentStart = 0;
    turnEntries.forEach((message, offset) => {
      const boundary = message.type === "compaction" ||
        (message.type === "assistant" && message.blocks?.some((block) => block.type !== "text"));
      if (!boundary) return;
      items.push(...compactCompletedSegment(turnEntries.slice(segmentStart, offset), userIndex + 1 + segmentStart, lastToolId));
      items.push({ kind: "single", message, index: userIndex + 1 + offset });
      segmentStart = offset + 1;
    });
    items.push(...compactCompletedSegment(turnEntries.slice(segmentStart), userIndex + 1 + segmentStart, lastToolId));
    cursor = nextUserIndex;
  }
  return items;
}

/** Fold ordinary process content together; keep operational entries outside in order. */
function compactCompletedSegment(turnEntries: ChatMessage[], startIndex: number, lastToolId?: string): RenderItem[] {
  const items: RenderItem[] = [];
    let processEndOffset = -1;
    for (let i = turnEntries.length - 1; i >= 0; i -= 1) {
      const message = turnEntries[i];
      if (message.type === "tool" && message.kind !== "think") {
        processEndOffset = i;
        break;
      }
    }
    if (processEndOffset >= 0) {
      const processItems: WorkSummaryItem[] = [];
      for (let i = 0; i < turnEntries.length; i += 1) {
        const message = turnEntries[i];
        if (
          (message.type === "assistant" && i <= processEndOffset) ||
          message.type === "thinking" ||
          (message.type === "tool" && i <= processEndOffset && shouldRenderTimelineTool(message))
        ) {
          processItems.push({ message, index: startIndex + i });
        }
      }
      if (processItems.length > 0) {
        const timedAssistants = turnEntries.filter(
          (message): message is Extract<ChatMessage, { type: "assistant" }> =>
            message.type === "assistant",
        );
        const starts = timedAssistants
          .map((message) => message.startTs)
          .filter((value): value is number => typeof value === "number");
        const ends = timedAssistants
          .map((message) => message.endTs)
          .filter((value): value is number => typeof value === "number");
        items.push({
          kind: "work-summary",
          sectionId: `work-${startIndex}-${processItems.at(-1)!.index}`,
          items: processItems,
          lastToolId,
          durationSeconds:
            starts.length > 0 && ends.length > 0
              ? Math.max(0, Math.max(...ends) - Math.min(...starts))
              : undefined,
        });
      }
      // Preserve uncommon inline messages (permission/system/etc.) that are
      // not part of the compactable agent process.
      const passthrough = turnEntries
        .slice(0, processEndOffset + 1)
        .map((message, offset) => ({ message, index: startIndex + offset }))
        .filter(
          ({ message }) =>
            message.type !== "assistant" &&
            message.type !== "thinking" &&
            message.type !== "tool" &&
            message.type !== "plan_document",
        );
      passthrough.forEach(({ message, index }) =>
        items.push({ kind: "single", message, index }),
      );
      const trailingStart = startIndex + processEndOffset + 1;
      items.push(
        ...buildSequentialRenderItems(
          turnEntries.slice(processEndOffset + 1),
          trailingStart,
          lastToolId,
        ).filter(
          (item) =>
            item.kind !== "single" || item.message.type !== "thinking",
        ),
      );
    } else {
      items.push(...buildSequentialRenderItems(turnEntries, startIndex, lastToolId));
    }
  return items;
}

function lastToolCallId(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.type === "tool" && message.kind !== "think") return message.id;
  }
}

export type ToolTimelineRow = {
  key: string;
  kind: "background" | "file" | "tool";
  tools: ToolSectionItem[];
  path?: string;
  additions: number;
  deletions: number;
  hasDiffStat: boolean;
};

function timelineToolPaths(message: ToolMessage): string[] {
  const diffPaths = message.output?.flatMap((output) => output.type === "diff" ? [{ path: output.path }] : []) ?? [];
  return extractEditToolPaths({
    ...message,
    locations: [...(message.locations ?? []), ...diffPaths],
    input: message.input?.flatMap((field) => {
      if (!/^(paths?|files?|file_?paths?|source_?path|destination_?path|old_?path|new_?path)$/i.test(field.label)) return [field];
      try {
        const paths: unknown = JSON.parse(field.value);
        if (Array.isArray(paths) && paths.every((path) => typeof path === "string")) {
          return paths.map((path: string) => ({ label: "path", value: path }));
        }
      } catch {
        // Ordinary path strings do not need JSON decoding.
      }
      return [{ label: "path", value: field.value }];
    }),
  });
}

function isUnifiedDiff(diff: string): boolean {
  return /^(?:@@|diff --git |\+\+\+ |--- )/m.test(diff);
}

/** Extract only file-attributable legacy diffs, never shell or MCP output. */
export function toolTimelineLegacyDiff(message: ToolMessage, path?: string): string | undefined {
  if (classifyActionKind(message) === "mcp" || !["edit", "delete", "move"].includes(toolVerb(message))) return undefined;
  const paths = timelineToolPaths(message);
  const targets = paths.length > 0 ? paths : [""];
  const diffs = (path === undefined ? targets : [path])
    .map((target) => extractDiffForEditPath(message.content, target, targets))
    .filter(isUnifiedDiff);
  return diffs.length > 0 ? diffs.join("\n\n") : undefined;
}

/** Group only declared capabilities; shell payloads never determine the row type. */
export function buildToolTimelineRows(tools: ToolSectionItem[]): ToolTimelineRow[] {
  const rows: ToolTimelineRow[] = [];
  let background: ToolTimelineRow | undefined;
  const files = new Map<string, ToolTimelineRow>();
  for (const tool of tools) {
    const message = tool.message;
    if (!shouldRenderTimelineTool(message)) continue;
    const verb = toolVerb(message);
    const action = classifyActionKind(message);
    if (message.kind !== "think" && action !== "mcp" && verb !== "run" && isBackgroundAction(message)) {
      if (!background) {
        background = { key: `background-${message.id}`, kind: "background", tools: [], additions: 0, deletions: 0, hasDiffStat: false };
        rows.push(background);
      }
      background.tools.push(tool);
    } else if (message.kind !== "think" && action !== "mcp" && (isEditTool(message) || verb === "delete" || verb === "move")) {
      const paths = timelineToolPaths(message);
      for (const path of paths.length > 0 ? paths : [""]) {
        const fileKey = `${verb}:${path || message.id}`;
        let row = files.get(fileKey);
        if (!row) {
          row = { key: `${message.id}:${fileKey}`, kind: "file", path, tools: [], additions: 0, deletions: 0, hasDiffStat: false };
          files.set(fileKey, row);
          rows.push(row);
        }
        row.tools.push(tool);
        const structuredDiff = message.output?.find((output) => output.type === "diff" && output.path === path);
        const diff = structuredDiff?.type === "diff"
          ? structuredDiff.display_text
          : extractDiffForEditPath(message.content, path, paths);
        if (isUnifiedDiff(diff)) row.hasDiffStat = true;
        for (const line of isUnifiedDiff(diff) ? diff.split("\n") : []) {
          if (line.startsWith("+") && !line.startsWith("+++")) row.additions += 1;
          if (line.startsWith("-") && !line.startsWith("---")) row.deletions += 1;
        }
      }
    } else {
      rows.push({ key: message.id, kind: "tool", tools: [tool], additions: 0, deletions: 0, hasDiffStat: false });
    }
  }
  const merged: ToolTimelineRow[] = [];
  for (const row of rows) {
    const previous = merged.at(-1);
    const message = row.tools[0].message;
    const previousMessage = previous?.tools[0].message;
    const action = classifyActionKind(message);
    if (row.kind === "tool" && previous?.kind === "tool" && previousMessage
      && action !== "todo" && action !== "switch_mode"
      && (message.kind === "think") === (previousMessage.kind === "think")
      && action === classifyActionKind(previousMessage)
      && timelineToolLabel(message) === timelineToolLabel(previousMessage)) {
      previous.tools.push(...row.tools);
    } else {
      merged.push(row);
    }
  }
  return merged;
}

export function backgroundToolLabel(tools: ToolSectionItem[]): string {
  const readPaths = new Set<string>();
  let readsWithoutPaths = 0;
  const counts = { search: 0, list: 0, fetch: 0 };
  for (const { message } of tools) {
    const verb = toolVerb(message);
    if (verb === "read") {
      const paths = timelineToolPaths({ ...message, content: undefined, output: undefined });
      if (paths.length === 0) readsWithoutPaths += 1;
      paths.forEach((path) => readPaths.add(path));
    } else if (verb === "search" || verb === "list" || verb === "fetch") {
      counts[verb] += 1;
    }
  }
  const reads = readPaths.size + readsWithoutPaths;
  return [
    reads > 0 ? `Read ${reads} file${reads === 1 ? "" : "s"}` : "",
    counts.search > 0 ? `${counts.search} search${counts.search === 1 ? "" : "es"}` : "",
    counts.list > 0 ? `${counts.list} directory listing${counts.list === 1 ? "" : "s"}` : "",
    counts.fetch > 0 ? `${counts.fetch} fetch${counts.fetch === 1 ? "" : "es"}` : "",
  ].filter(Boolean).join(", ");
}

/** Preserve the complete command. Truncation belongs to the rendered line. */
export function timelineToolLabel(message: ToolMessage): string {
  const action = classifyActionKind(message);
  if (action === "mcp") {
    const identity = toolDisplayName(message).replace(/^mcp(?:__|[_.:/])+/i, "");
    const separator = identity.includes("__") ? "__" : /[.:/]/;
    const [server, ...tool] = identity.split(separator);
    return tool.length > 0 ? `${server} · ${tool.join(typeof separator === "string" ? separator : ".")}` : identity;
  }
  if (toolVerb(message) === "run") {
    const command = message.input?.find((field) => /^(command|cmd)$/i.test(field.label))?.value;
    if (command?.trim()) return command;
    const terminal = message.output?.find((output) => output.type === "terminal" && output.command);
    if (terminal?.type === "terminal" && terminal.command) return terminal.command;
    return message.title || toolDisplayName(message);
  }
  if (isBackgroundAction(message)) {
    const paths = timelineToolPaths({ ...message, content: undefined, output: undefined });
    if (paths.length > 0) return `${toolDisplayName(message)} · ${paths.join(", ")}`;
  }
  return toolDisplayName(message);
}

export function finalFailedTool(tools: ToolSectionItem[], lastToolId?: string): ToolMessage | undefined {
  return tools.find(({ message }) => message.kind !== "think" && message.id === lastToolId && (message.status === "failed" || message.status === "error"))?.message;
}

export function toolTimelineRowState(row: ToolTimelineRow, lastToolId?: string) {
  const running = row.tools.some(({ message }) => message.kind !== "think" && ["running", "in_progress"].includes(message.status));
  return {
    running,
    failed: running ? undefined : finalFailedTool(row.tools, lastToolId),
    hasFailure: row.tools.some(({ message }) => ["failed", "error"].includes(message.status)),
    cancelled: row.tools.some(({ message }) => message.kind === "think" && message.status === "cancelled"),
  };
}

/** Simplify shell syntax for display only. Identity and input retain the source. */
export function shellTimelineDisplay(command: string): { text: string; additionalLines: number } {
  const wrapper = /^(?:\S*\/)?(?:sh|bash|zsh)\s+-(?:l?c|cl)\s+(?:'([^']*)'|"((?:[^"\\]|\\[\s\S])*)")$/.exec(command);
  const display = wrapper ? wrapper[1] ?? wrapper[2] : command;
  const lines = display.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return { text: lines[0] ?? display, additionalLines: Math.max(0, lines.length - 1) };
}

export function toolTimelineWindow(rows: ToolTimelineRow[], expanded: boolean) {
  const steps = rows.filter((row) => row.tools[0].message.kind !== "think");
  // Aggregated background/file rows can own the latest running call while
  // retaining an earlier position. Keep those rows in the visible allowance.
  const running = steps.filter((row) => toolTimelineRowState(row).running);
  const settled = steps.filter((row) => !toolTimelineRowState(row).running);
  const remaining = Math.max(0, 5 - running.length);
  const collapsed = [...(remaining > 0 ? settled.slice(-remaining) : []), ...running];
  const earlierCount = Math.max(0, steps.length - collapsed.length);
  const visibleSteps = new Set((expanded ? steps : collapsed).map((row) => row.key));
  return { earlierCount, rows: rows.filter((row) => row.tools[0].message.kind === "think" || visibleSteps.has(row.key)) };
}

/** Namespace disclosures independently of the legacy auto-expanded section ID. */
export function toolTimelineExpansionKey(sectionId: string, kind: "files" | "background" | "detail" | "earlier", rowKey = ""): string {
  return JSON.stringify(["tool-timeline", sectionId, kind, rowKey]);
}

export function toggleToolTimelineDetail(sections: Set<string>, sectionId: string, rowKey: string): Set<string> {
  const key = toolTimelineExpansionKey(sectionId, "detail", rowKey);
  const prefix = JSON.stringify(["tool-timeline", sectionId, "detail"]).slice(0, -1) + ",";
  const next = new Set(sections);
  for (const previous of sections) {
    if (previous.startsWith(prefix)) next.delete(previous);
  }
  if (!sections.has(key)) next.add(key);
  return next;
}
