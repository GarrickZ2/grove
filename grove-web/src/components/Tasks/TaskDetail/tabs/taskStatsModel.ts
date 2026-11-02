// Calculate active time from activity timeline: every minute bucket with at
// least one edit counts as an active minute. "—" when there are none.
export function calculateActiveTime(hourlyActivity: Array<{ buckets: number[] }>): string {
  if (!hourlyActivity || hourlyActivity.length === 0) {
    return "—";
  }

  // Count all minutes with activity (buckets > 0)
  let activeMinutes = 0;
  for (const hourEntry of hourlyActivity) {
    if (Array.isArray(hourEntry.buckets)) {
      activeMinutes += hourEntry.buckets.filter(count => count > 0).length;
    }
  }

  if (activeMinutes === 0) {
    return "—";
  }

  const hours = Math.floor(activeMinutes / 60);
  const minutes = activeMinutes % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}
