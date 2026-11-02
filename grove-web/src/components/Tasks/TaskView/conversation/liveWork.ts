import type { WorkSummaryItem } from "../chatRenderItems";
import { shellTimelineDisplay, timelineToolLabel } from "../chatRenderItems";
import { extractThoughtStatus } from "../thoughtStatus";
import { classifyActionKind, toolDisplayName, toolVerb } from "../toolCallIdentity";
import type { ToolCallMessage } from "../toolCallReducer";

export type LiveStepKind = "run" | "read" | "edit" | "search" | "fetch" | "mcp" | "thinking" | "tool";

/** What the live work group names as "now". */
export type LiveWorkStep = {
  kind: LiveStepKind;
  /** Short verb phrase, e.g. "Running", "Edited". Empty for thinking. */
  verb: string;
  /** The step's subject: a file name, command, query or thought heading. */
  subject: string;
  /** Monospace subject (commands, paths). */
  mono: boolean;
  running: boolean;
  failed: boolean;
};

export type LiveWorkSummary = {
  /** Tool calls so far (thinking excluded). */
  steps: number;
  failedSteps: number;
  current: LiveWorkStep | null;
};

const RUNNING = new Set(["running", "in_progress", "pending"]);
const FAILED = new Set(["failed", "error"]);
const PATH_FIELD = /^(paths?|files?|file_?paths?|source_?path|target_?file|notebook_?path)$/i;
const QUERY_FIELD = /^(pattern|query|q|regex|search|glob)$/i;
const URL_FIELD = /^(url|uri)$/i;

function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash >= 0 ? trimmed.slice(slash + 1) || trimmed : trimmed;
}

function inputValue(message: ToolCallMessage, pattern: RegExp): string | undefined {
  const value = message.input?.find((field) => pattern.test(field.label))?.value?.trim();
  if (!value) return undefined;
  // Path lists arrive JSON-encoded; name the first.
  if (value.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed) && typeof parsed[0] === "string") return parsed[0];
    } catch {
      // A literal value that merely starts with a bracket.
    }
  }
  return value;
}

function toolPath(message: ToolCallMessage): string | undefined {
  return message.locations?.[0]?.path || inputValue(message, PATH_FIELD);
}

function host(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Name one tool call as a step, in the present while it runs, else the past. */
export function liveToolStep(message: ToolCallMessage): LiveWorkStep {
  const running = RUNNING.has(message.status);
  const failed = FAILED.has(message.status);
  const tense = (present: string, past: string) => (running ? present : past);
  const action = classifyActionKind(message);
  const verb = toolVerb(message);
  const base = { running, failed };
  if (action === "mcp") {
    return { ...base, kind: "mcp", verb: tense("Calling", "Called"), subject: timelineToolLabel(message), mono: false };
  }
  if (verb === "run") {
    const command = shellTimelineDisplay(timelineToolLabel(message)).text;
    return { ...base, kind: "run", verb: tense("Running", "Ran"), subject: command, mono: true };
  }
  if (verb === "read" || verb === "list") {
    const path = toolPath(message);
    if (path) return { ...base, kind: "read", verb: tense(verb === "list" ? "Listing" : "Reading", verb === "list" ? "Listed" : "Read"), subject: baseName(path), mono: true };
  }
  if (verb === "edit" || verb === "delete" || verb === "move") {
    const path = toolPath(message);
    const [present, past] = verb === "delete" ? ["Deleting", "Deleted"] : verb === "move" ? ["Moving", "Moved"] : ["Editing", "Edited"];
    if (path) return { ...base, kind: "edit", verb: tense(present, past), subject: baseName(path), mono: true };
  }
  if (verb === "search") {
    const query = inputValue(message, QUERY_FIELD);
    if (query) return { ...base, kind: "search", verb: tense("Searching", "Searched"), subject: query, mono: true };
  }
  if (verb === "fetch") {
    const url = inputValue(message, URL_FIELD);
    if (url) return { ...base, kind: "fetch", verb: tense("Fetching", "Fetched"), subject: host(url), mono: false };
  }
  // Agents title unknown tools descriptively ("Read src/a.ts"); keep that.
  const title = message.title?.trim();
  return { ...base, kind: "tool", verb: "", subject: title || toolDisplayName(message), mono: false };
}

/**
 * Summarize a running turn's grouped work. The current step is the latest
 * running tool; else unfinished thinking; else, when nothing follows the
 * group, the agent is between steps ("Thinking"); else the latest tool.
 */
export function summarizeLiveWork(
  items: readonly WorkSummaryItem[],
  atTail: boolean,
  /** Ids of permission requests still awaiting the user (ACP tool-call ids). */
  awaitingApproval: readonly string[] = [],
): LiveWorkSummary {
  let steps = 0;
  let failedSteps = 0;
  let latestTool: ToolCallMessage | undefined;
  let latestRunning: ToolCallMessage | undefined;
  let latestThinking: { content: string; index: number } | undefined;
  let latestToolIndex = -1;
  let awaitingTool: ToolCallMessage | undefined;
  for (const { message, index } of items) {
    if (message.type === "tool") {
      if (message.kind === "think") continue;
      steps += 1;
      if (FAILED.has(message.status)) failedSteps += 1;
      latestTool = message;
      latestToolIndex = index;
      if (RUNNING.has(message.status)) latestRunning = message;
      if (awaitingApproval.includes(message.id)) awaitingTool = message;
    } else if (message.type === "thinking" && !message.complete) {
      latestThinking = { content: message.content, index };
    }
  }
  const thinking = (subject: string): LiveWorkStep => ({ kind: "thinking", verb: "", subject, mono: false, running: true, failed: false });
  let current: LiveWorkStep | null = null;
  // A request the user must answer blocks the turn; name it first. Id-less
  // (legacy) requests fall back to the latest running tool.
  const blocked = awaitingTool ?? (awaitingApproval.length > 0 ? latestRunning : undefined);
  if (blocked) current = { ...liveToolStep(blocked), verb: "Waiting for approval", running: true };
  else if (latestRunning) current = liveToolStep(latestRunning);
  else if (latestThinking && latestThinking.index > latestToolIndex) current = thinking(extractThoughtStatus(latestThinking.content));
  else if (atTail) current = thinking("Thinking");
  else if (latestTool) current = liveToolStep(latestTool);
  return { steps, failedSteps, current };
}

type TailItem = { kind: string; live?: boolean; message?: { type: string } };

/**
 * Where the running turn's live group is, and whether it is the turn's
 * visible tail: nothing the agent is producing (text, thinking, tools)
 * follows it. Records and pending asks after it (a resolved permission, a
 * notice, a request docked in the composer) leave it the tail, so the group
 * names "Thinking" itself instead of the transcript's generic indicator.
 */
export function liveGroupTail(items: readonly TailItem[]): { index: number; atTail: boolean } {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "work-summary" && item.live) {
      const atTail = items.slice(index + 1).every((later) =>
        later.kind === "single" && later.message?.type !== "assistant" && later.message?.type !== "thinking");
      return { index, atTail };
    }
  }
  return { index: -1, atTail: false };
}
