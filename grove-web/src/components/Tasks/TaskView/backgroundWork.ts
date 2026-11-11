/** One piece of work an ACP v2 Agent keeps running outside the conversation. */
export interface BackgroundWorkItem {
  /** `terminal`, `tool_call`, `subagent`, or a type Grove does not know. */
  kind: string;
  id: string;
  /** The command, tool title or subagent title. */
  label?: string;
  cwd?: string;
  /** Unix seconds when Grove first saw it in the background. */
  started_at: number;
  cancellable: boolean;
}

export function normalizeBackgroundWork(items: unknown): BackgroundWorkItem[] {
  if (!Array.isArray(items)) return [];
  return items.filter((item): item is BackgroundWorkItem =>
    !!item && typeof item === "object" && typeof (item as BackgroundWorkItem).kind === "string" && typeof (item as BackgroundWorkItem).id === "string");
}

const KIND_LABEL: Record<string, string> = { terminal: "Terminal", tool_call: "Tool call", subagent: "Subagent" };

/** What a row is called: its command or title, else its kind. */
export function backgroundWorkLabel(item: BackgroundWorkItem): string {
  return item.label?.trim() || KIND_LABEL[item.kind] || item.kind;
}
