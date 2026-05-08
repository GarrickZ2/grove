import {
  BatteryFull,
  BatteryLow,
  BatteryMedium,
  BatteryWarning,
} from "lucide-react";
import type { ComponentType } from "react";
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

/**
 * Health-based color for context window *used* percentage.
 *
 *   0-50  %  →  success  (plenty of room)
 *   50-70 %  →  warning  (filling up)
 *   ≥ 70 %  →  error    (consider compact / new chat)
 */
export function contextHealthColor(percentUsed: number): string {
  if (percentUsed >= 70) return "var(--color-error)";
  if (percentUsed >= 50) return "var(--color-warning)";
  return "var(--color-success)";
}

type IconComponent = ComponentType<{ size?: number; className?: string }>;

/**
 * Pick a Battery lucide icon based on quota *remaining* percentage.
 * Mirrors device battery semantics — full → warning as the bar drains.
 */
export function quotaBatteryIcon(percentRemaining: number): IconComponent {
  if (percentRemaining < 20) return BatteryWarning;
  if (percentRemaining < 50) return BatteryLow;
  if (percentRemaining < 80) return BatteryMedium;
  return BatteryFull;
}
