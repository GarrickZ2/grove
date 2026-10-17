import type { ChatMessage } from "./TaskChat";
import type { ToolCallMessage as ToolMessage } from "./toolCallReducer";
import { isEditTool } from "./toolCallIdentity";

export type ToolSectionItem = { message: ToolMessage; index: number };
export type WorkSummaryItem = {
  message: Extract<ChatMessage, { type: "assistant" | "thinking" | "tool" }>;
  index: number;
};
export type RenderItem =
  | { kind: "single"; message: ChatMessage; index: number; sourceIndex?: number }
  | { kind: "tool-section"; sectionId: string; tools: ToolSectionItem[] }
  | {
      kind: "work-summary";
      sectionId: string;
      items: WorkSummaryItem[];
      durationSeconds?: number;
    }
  | { kind: "file-change-summary"; sectionId: string; tools: ToolSectionItem[] };

/** Group consecutive tool messages into sections; everything else is a single item */
export function buildSequentialRenderItems(
  messages: ChatMessage[],
  startIndex = 0,
): RenderItem[] {
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

  messages.forEach((msg, offset) => {
    const i = startIndex + offset;
    if (msg.type === "plan_document") return;
    if (msg.type === "thinking" && msg.complete) {
      // Keep completed reasoning in history but out of the transcript.
      flush();
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
      items.push(...buildSequentialRenderItems(messages.slice(cursor), cursor));
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
    const hasStreamingEntry = turnEntries.some(
      (message) =>
        (message.type === "assistant" || message.type === "thinking") &&
        !message.complete,
    );

    if ((isLatestTurn && isBusy) || hasStreamingEntry) {
      items.push(
        ...buildSequentialRenderItems(turnEntries, userIndex + 1),
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
      items.push(...compactCompletedSegment(turnEntries.slice(segmentStart, offset), userIndex + 1 + segmentStart));
      items.push({ kind: "single", message, index: userIndex + 1 + offset });
      segmentStart = offset + 1;
    });
    items.push(...compactCompletedSegment(turnEntries.slice(segmentStart), userIndex + 1 + segmentStart));
    cursor = nextUserIndex;
  }
  return items;
}

/** Fold ordinary process content together; keep operational entries outside in order. */
function compactCompletedSegment(turnEntries: ChatMessage[], startIndex: number): RenderItem[] {
  const items: RenderItem[] = [];
    let processEndOffset = -1;
    for (let i = turnEntries.length - 1; i >= 0; i -= 1) {
      if (turnEntries[i].type === "tool") {
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
          message.type === "tool"
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
        ).filter(
          (item) =>
            item.kind !== "single" || item.message.type !== "thinking",
        ),
      );
      const editedTools = processItems.flatMap(({ message, index }) =>
        message.type === "tool" && isEditTool(message)
          ? [{ message, index }]
          : [],
      );
      if (editedTools.length > 0) {
        items.push({
          kind: "file-change-summary",
          sectionId: `files-${startIndex}`,
          tools: editedTools,
        });
      }
    } else {
      items.push(...buildSequentialRenderItems(turnEntries, startIndex));
    }
  return items;
}
