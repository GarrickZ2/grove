/**
 * Thin shim around the project-wide `agentIcon` util kept so existing
 * Skills code calling `<AgentIcon iconId="claude" />` keeps compiling.
 * All icon-table data lives in `utils/agentIcon.ts` — the previous local
 * `ICON_MAP` duplicated entries and missed aliases (traex, claude-acp,
 * etc.), surfacing as "right ID, wrong fallback Bot" bugs.
 */
import { createElement } from "react";
import { agentIconComponent } from "../../utils/agentIcon";

interface AgentIconProps {
  iconId: string | null;
  size?: number;
  className?: string;
}

export function AgentIcon({ iconId, size = 20, className }: AgentIconProps) {
  // `createElement` (not JSX) so `react-hooks/static-components` doesn't
  // flag the dynamic component. agentIconComponent returns stable refs.
  return createElement(agentIconComponent(iconId), { size, className });
}
