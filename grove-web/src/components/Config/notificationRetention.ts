export const RETENTION_MIN = 1;
export const RETENTION_MAX = 365;

/** Whole number of hours/days for "Done" chat retention, or null to ignore the input. */
export function clampRetentionValue(raw: string): number | null {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return null;
  return Math.min(RETENTION_MAX, Math.max(RETENTION_MIN, n));
}
