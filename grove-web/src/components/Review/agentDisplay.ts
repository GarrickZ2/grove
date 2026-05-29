import { resolveAgentIcon } from "../../utils/agentIcon";

/** Build display string from agent + role + model. */
export function formatAgentDisplay(agent: string, role: string, model?: string): string {
  const info = resolveAgentIcon(agent);
  const name = info.label || agent || 'Unknown';
  
  const parts = [name];
  if (model) parts.push(`(${model})`);
  if (role) parts.push(`(${role})`);
  
  return parts.join(' ');
}
