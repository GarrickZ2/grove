/** Build display string from agent + role. Model is rendered separately by callers. */
export function formatAgentDisplay(agent: string, role: string): string {
  const name = agent || 'Unknown';
  return role ? `${name} (${role})` : name;
}
