/**
 * Agent option catalog — single source of truth for agent metadata.
 *
 * Lives in `data/` (not `components/ui/`) so lightweight surfaces like the
 * menubar tray popover can import the catalog without dragging in the
 * `AgentPicker` UI tree (lucide barrel, framer-motion, etc.).
 */

import {
  Claude,
  Gemini,
  Copilot,
  Cursor,
  Trae,
  Qwen,
  Kimi,
  OpenAI,
  Junie,
  OpenCode,
  OpenClaw,
  Hermes,
  Kiro,
  Windsurf,
} from "../components/ui/AgentIcons";

export interface AgentOption {
  id: string;
  label: string;
  value: string;
  icon?: React.ComponentType<{ size?: number; className?: string }>;
  disabled?: boolean;
  disabledReason?: string;
  /** Command to check in terminal mode (defaults to first word of value) */
  terminalCheck?: string;
  /** Command to check in chat/ACP mode */
  acpCheck?: string;
  /** Fallback ACP command (deprecated, still functional) */
  acpFallback?: string;
  /** npm package for npx fallback when acpCheck not on PATH */
  npxPackage?: string;
}

export const agentOptions: AgentOption[] = [
  { id: "claude", label: "Claude Code", value: "claude", icon: Claude.Color, terminalCheck: "claude", acpCheck: "claude-agent-acp", acpFallback: "claude-code-acp", npxPackage: "@agentclientprotocol/claude-agent-acp" },
  { id: "codex", label: "CodeX", value: "codex", icon: OpenAI, terminalCheck: "codex", acpCheck: "codex-acp", npxPackage: "@zed-industries/codex-acp" },
  { id: "cursor-agent", label: "Cursor", value: "cursor", icon: Cursor, terminalCheck: "cursor-agent", acpCheck: "cursor-agent" },
  { id: "gemini", label: "Gemini", value: "gemini", icon: Gemini.Color, terminalCheck: "gemini", acpCheck: "gemini" },
  { id: "gh-copilot", label: "GitHub Copilot", value: "copilot", icon: Copilot.Color, terminalCheck: "copilot", acpCheck: "copilot" },
  { id: "hermes", label: "Hermes", value: "hermes", icon: Hermes, terminalCheck: "hermes", acpCheck: "hermes acp" },
  { id: "junie", label: "Junie", value: "junie", icon: Junie.Color, terminalCheck: "junie", acpCheck: "junie" },
  { id: "kimi", label: "Kimi", value: "kimi", icon: Kimi.Color, terminalCheck: "kimi", acpCheck: "kimi" },
  { id: "kiro", label: "Kiro", value: "kiro", icon: Kiro, terminalCheck: "kiro-cli", acpCheck: "kiro-cli acp" },
  { id: "openclaw", label: "OpenClaw", value: "openclaw", icon: OpenClaw.Color, terminalCheck: "openclaw", acpCheck: "openclaw acp" },
  { id: "opencode", label: "OpenCode", value: "opencode", icon: OpenCode, terminalCheck: "opencode", acpCheck: "opencode" },
  { id: "qwen", label: "Qwen", value: "qwen", icon: Qwen.Color, terminalCheck: "qwen", acpCheck: "qwen" },
  { id: "traecli", label: "Trae", value: "traecli", icon: Trae.Color, terminalCheck: "traecli", acpCheck: "traecli" },
  { id: "windsurf", label: "Windsurf", value: "windsurf", icon: Windsurf, terminalCheck: "windsurf", acpCheck: "windsurf" },
];
