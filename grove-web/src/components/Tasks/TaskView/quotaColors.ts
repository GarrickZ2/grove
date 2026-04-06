import type { AgentUsage } from "../../../api/agentUsage";

/**
 * Health-based color mapping for an agent quota percentage (remaining).
 *
 * Uses the theme's semantic CSS tokens so the same function drives both
 * the popover content and the badge number in the chatbox, keeping colors
 * consistent across themes.
 *
 *   ≥ 50 %  →  success  (healthy)
 *   20-50 % →  warning  (getting low)
 *   < 20 %  →  error    (critical)
 */
export function quotaHealthColor(percentRemaining: number): string {
  if (percentRemaining < 20) return "var(--color-error)";
  if (percentRemaining < 50) return "var(--color-warning)";
  return "var(--color-success)";
}

/**
 * Chat badge display policy: prefer the short-term "5h limit" window when it
 * exists, otherwise fall back to the backend aggregate.
 */
export function quotaBadgePercent(usage: AgentUsage): number {
  const preferred = usage.windows.find((window) => window.label === "5h limit");
  return preferred?.percentage_remaining ?? usage.percentage_remaining;
}
