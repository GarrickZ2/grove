import { resolveAgentIcon, usePersonaRegistry } from "../../utils/agentIcon";

/**
 * Render "Name (role)" at the host font size, with the model as a smaller,
 * dimmed, non-bold suffix so it reads as a subtitle rather than competing with
 * the primary title. Sizing is relative (em) so it adapts to whatever
 * font-size each caller's container uses.
 */
export function AgentDisplay({ agent, role, model }: { agent: string; role: string; model?: string }) {
  usePersonaRegistry();
  const info = resolveAgentIcon(agent);
  const name = info.label || agent || 'Unknown';

  return (
    <span>
      {name}{role ? ` (${role})` : ''}
      {model ? (
        <span style={{ fontSize: '0.82em', fontWeight: 400, opacity: 0.6 }}> · {model}</span>
      ) : null}
    </span>
  );
}
