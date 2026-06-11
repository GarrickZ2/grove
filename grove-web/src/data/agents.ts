/**
 * Agent option catalog — UI metadata for the agent picker.
 *
 * After the backend ACP refactor, "is this agent available?" comes
 * exclusively from the marketplace endpoint (`listMarketplace()` →
 * `install_state`). This file is now a *static metadata-only* catalog
 * for icon + label fallback used by surfaces that don't fetch
 * marketplace data directly (e.g. tray popover label resolution,
 * AgentPicker dropdown icons).
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
} from "../components/ui/AgentIcons";

export interface AgentOption {
  id: string;
  label: string;
  value: string;
  icon?: React.ComponentType<{ size?: number; className?: string }>;
  disabled?: boolean;
  disabledReason?: string;
}

export const agentOptions: AgentOption[] = [
  { id: "claude-acp", label: "Claude Code", value: "claude-acp", icon: Claude.Color },
  { id: "codex-acp", label: "CodeX", value: "codex-acp", icon: OpenAI },
  { id: "cursor", label: "Cursor", value: "cursor", icon: Cursor },
  { id: "gemini", label: "Gemini", value: "gemini", icon: Gemini.Color },
  { id: "github-copilot-cli", label: "GitHub Copilot", value: "github-copilot-cli", icon: Copilot.Color },
  { id: "hermes", label: "Hermes", value: "hermes", icon: Hermes },
  { id: "junie", label: "Junie", value: "junie", icon: Junie.Color },
  { id: "kimi", label: "Kimi", value: "kimi", icon: Kimi.Color },
  { id: "kiro", label: "Kiro", value: "kiro", icon: Kiro },
  { id: "openclaw", label: "OpenClaw", value: "openclaw", icon: OpenClaw.Color },
  { id: "opencode", label: "OpenCode", value: "opencode", icon: OpenCode },
  { id: "qwen-code", label: "Qwen", value: "qwen-code", icon: Qwen.Color },
  { id: "traecli", label: "Trae", value: "traecli", icon: Trae.Color },
];
