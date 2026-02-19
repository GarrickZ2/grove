// Config (used by App.tsx as fallback)
export const mockConfig = {
  agent: {
    command: "claude",
  },
  layout: {
    default: "agent-shell",
    presets: [
      { id: "single", name: "Single", description: "Default shell only" },
      { id: "agent", name: "Agent", description: "Auto-start agent" },
      { id: "agent-shell", name: "Agent + Shell", description: "Agent (60%) + Shell (40%)" },
      { id: "agent-grove-shell", name: "Agent + Grove + Shell", description: "Three pane layout" },
      { id: "grove-agent", name: "Grove + Agent", description: "Grove (40%) + Agent (60%)" },
    ],
    customLayout: null,
  },
  hooks: {
    enabled: true,
    scriptPath: "~/.grove/hooks/notify.sh",
    levels: ["notice", "warn", "critical"],
  },
  mcp: {
    name: "grove",
    type: "stdio",
    command: "grove",
    args: ["mcp"],
  },
};
