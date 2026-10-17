import { AgentAvatar } from "../../Review/AgentAvatar";

/** A session's randomly generated ID seeds a distinct face that survives reloads. */
export function SubagentAvatar({ sessionId, size = 28 }: { sessionId: string; size?: number }) {
  return <AgentAvatar agent={`subagent:${sessionId}`} size={size} className="ring-1 ring-[color-mix(in_srgb,var(--color-border)_55%,transparent)]" />;
}
