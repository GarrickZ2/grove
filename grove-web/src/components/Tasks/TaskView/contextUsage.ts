export interface ContextUsageData {
  used: number;
  size: number;
  cost: { amount: number; currency: string } | null;
}

export function contextUsagePercent(usage: ContextUsageData): number {
  return usage.size > 0 ? Math.max(0, Math.min(100, Math.round((usage.used / usage.size) * 100))) : 0;
}
