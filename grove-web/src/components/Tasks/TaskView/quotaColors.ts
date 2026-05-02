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

const FIVE_HOUR_SECONDS = 5 * 60 * 60;

/**
 * Chat badge display policy: prefer the short-term 5-hour token budget when it
 * exists, otherwise fall back to the backend aggregate.
 */
export function quotaBadgePercent(usage: AgentUsage): number {
  const preferred = usage.windows.find(
    (window) => window.total_window_seconds === FIVE_HOUR_SECONDS,
  );
  return preferred?.percentage_remaining ?? usage.percentage_remaining;
}
