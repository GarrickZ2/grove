import type { ComboboxOption } from "../ui";
import type { AppInfo } from "../../api";
import type { PaneType } from "./LayoutEditor";

export const MCP_CONNECTION = { name: "grove", type: "stdio", command: "grove", args: ["mcp"] };

export const CLAUDE_CODE_MCP_CONFIG = JSON.stringify(
  {
    mcpServers: {
      grove: {
        type: MCP_CONNECTION.type,
        command: MCP_CONNECTION.command,
        args: MCP_CONNECTION.args,
      },
    },
  },
  null,
  2
);

export const CODEX_MCP_CONFIG = `[mcp_servers.grove]
command = "${MCP_CONNECTION.command}"
args = ${JSON.stringify(MCP_CONNECTION.args)}
env_vars = [
  "GROVE_TASK_ID",
  "GROVE_TASK_NAME",
  "GROVE_BRANCH",
  "GROVE_TARGET",
  "GROVE_WORKTREE",
  "GROVE_PROJECT_NAME",
  "GROVE_PROJECT"
]`;

export interface LayoutPreset {
  id: string;
  name: string;
  description: string;
  panes: string[];
  layout?: "horizontal" | "left-right-split"; // for special layouts
}

export const layoutPresets: LayoutPreset[] = [
  { id: "single", name: "Single", description: "Shell only", panes: ["shell"] },
  { id: "agent", name: "Agent", description: "Agent only", panes: ["agent"] },
  { id: "agent-shell", name: "Agent + Shell", description: "60% + 40%", panes: ["agent", "shell"] },
  { id: "agent-grove-shell", name: "3 Panes", description: "Left + Right split", panes: ["agent", "grove", "shell"], layout: "left-right-split" },
  { id: "grove-agent", name: "Grove + Agent", description: "40% + 60%", panes: ["grove", "agent"] },
  { id: "custom", name: "Custom", description: "Configure your own", panes: [] },
];

// Map pane type to display info
export const paneTypeColors: Record<PaneType | string, { bg: string; text: string }> = {
  agent: { bg: "var(--color-highlight)", text: "var(--color-highlight)" },
  grove: { bg: "var(--color-info)", text: "var(--color-info)" },
  "file-picker": { bg: "var(--color-accent)", text: "var(--color-accent)" },
  shell: { bg: "var(--color-text-muted)", text: "var(--color-text-muted)" },
  custom: { bg: "var(--color-warning)", text: "var(--color-warning)" },
};

export const paneTypeLabels: Record<PaneType, string> = {
  agent: "Agent",
  grove: "Grove",
  "file-picker": "FP",
  shell: "Shell",
  custom: "Cmd",
};

// Sound options for hooks (macOS system sounds)
export const soundOptions: ComboboxOption[] = [
  { id: "none", label: "NONE", value: "none" },
  { id: "Basso", label: "Basso", value: "Basso" },
  { id: "Blow", label: "Blow", value: "Blow" },
  { id: "Bottle", label: "Bottle", value: "Bottle" },
  { id: "Frog", label: "Frog", value: "Frog" },
  { id: "Funk", label: "Funk", value: "Funk" },
  { id: "Glass", label: "Glass", value: "Glass" },
  { id: "Hero", label: "Hero", value: "Hero" },
  { id: "Morse", label: "Morse", value: "Morse" },
  { id: "Ping", label: "Ping", value: "Ping" },
  { id: "Pop", label: "Pop", value: "Pop" },
  { id: "Purr", label: "Purr", value: "Purr" },
  { id: "Sosumi", label: "Sosumi", value: "Sosumi" },
  { id: "Submarine", label: "Submarine", value: "Submarine" },
  { id: "Tink", label: "Tink", value: "Tink" },
];

// Dependency display info
export const dependencyInfo: Record<string, { name: string; description: string; docsUrl?: string }> = {
  git: { name: "Git", description: "Version control system", docsUrl: "https://git-scm.com/doc" },
  tmux: { name: "tmux", description: "Terminal multiplexer", docsUrl: "https://github.com/tmux/tmux/wiki" },
  zellij: { name: "Zellij", description: "Terminal multiplexer", docsUrl: "https://zellij.dev/documentation/" },
  fzf: { name: "fzf", description: "Fuzzy finder for file picker", docsUrl: "https://github.com/junegunn/fzf" },
};

export const AUTOLINK_PRESETS = [
  "**/node_modules",
  "target",
  "build",
  "dist",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "vendor",
  "**/venv",
  "**/__pycache__",
];

/** Whether the server can list installed IDEs and terminals. */
export const hasAppDetection = (platform: string | null) =>
  platform === "macos" || platform === "windows";

/** Installed apps offered as IDEs (common IDEs/editors). */
export const isIdeApp = (app: AppInfo) =>
  /code|studio|idea|storm|rider|cursor|zed|sublime|atom|vim|emacs|nova|bbedit|textmate|xcode/i.test(app.name) ||
  /com\.(microsoft|jetbrains|apple|sublimehq|github)/i.test(app.bundle_id || "");

/** Installed apps offered as terminals. */
export const isTerminalApp = (app: AppInfo) =>
  /terminal|powershell|command prompt|iterm|warp|ghostty|kitty|alacritty|hyper|konsole|tilix|wezterm|cmux/i.test(app.name) ||
  /com\.(apple\.Terminal|googlecode\.iterm|warp|kovidgoyal|wez|feh)|io\.github\.mlfwka/i.test(app.bundle_id || "");
