import { Bot } from "lucide-react";
import { Claude, Gemini, Copilot, Cursor, Trae, Qwen, Kimi, OpenAI, Windsurf, OpenCode, Junie, OpenClaw, Hermes, Kiro } from "../ui/AgentIcons";

const ICON_MAP: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  claude: Claude.Color,
  cursor: Cursor,
  copilot: Copilot.Color,
  gemini: Gemini.Color,
  trae: Trae.Color,
  qwen: Qwen.Color,
  kimi: Kimi.Color,
  openai: OpenAI,
  opencode: OpenCode,
  windsurf: Windsurf,
  junie: Junie.Color,
  openclaw: OpenClaw.Color,
  hermes: Hermes,
  kiro: Kiro,
};

interface AgentIconProps {
  iconId: string | null;
  size?: number;
  className?: string;
}

export function AgentIcon({ iconId, size = 20, className }: AgentIconProps) {
  const Icon = iconId ? ICON_MAP[iconId] : null;

  if (Icon) {
    return <Icon size={size} className={className} />;
  }

  return <Bot size={size} className={`text-[var(--color-text-muted)] ${className || ""}`} />;
}
