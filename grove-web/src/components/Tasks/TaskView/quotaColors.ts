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

function isFiveHourWindow(label: string): boolean {
  return /\b5\s*(?:h|hours?)\b/i.test(label);
}

/**
 * Chat badge display policy: prefer the short-term 5-hour token budget when it
 * exists, otherwise fall back to the backend aggregate.
 */
export function quotaBadgePercent(usage: AgentUsage): number {
  const fiveHourWindows = usage.windows.filter((window) => {
    if (window.total_window_seconds === FIVE_HOUR_SECONDS) {
      return true;
    }
    return isFiveHourWindow(window.label);
  });
  const preferred =
    fiveHourWindows.find((window) => /\btokens?\b/i.test(window.label)) ?? fiveHourWindows[0];
  return preferred?.percentage_remaining ?? usage.percentage_remaining;
}
