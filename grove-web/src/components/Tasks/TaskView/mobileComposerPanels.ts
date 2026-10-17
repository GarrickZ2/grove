export type MobileComposerPanel = "pending" | "subagents" | "todo" | "quota" | "context" | "memory" | "plan" | "previewComments";

export const mobileComposerPanelTitles: Record<MobileComposerPanel, string> = {
  pending: "Pending messages",
  subagents: "Subagents",
  todo: "Todo",
  quota: "Agent quota",
  context: "Context usage",
  memory: "Read memory",
  plan: "Plan",
  previewComments: "Preview comments",
};
