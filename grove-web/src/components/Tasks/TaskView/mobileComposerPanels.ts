export type MobileComposerPanel = "pending" | "todo" | "quota" | "context" | "memory" | "plan" | "previewComments";

export const mobileComposerPanelTitles: Record<MobileComposerPanel, string> = {
  pending: "Pending messages",
  todo: "Todo",
  quota: "Agent quota",
  context: "Context usage",
  memory: "Read memory",
  plan: "Plan",
  previewComments: "Preview comments",
};
