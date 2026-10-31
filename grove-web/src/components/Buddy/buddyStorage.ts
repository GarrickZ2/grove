export function readBuddyPreference(key: string, fallback = ""): string {
  try { return localStorage.getItem(`grove-buddy-${key}`) ?? fallback; } catch { return fallback; }
}
export function writeBuddyPreference(key: string, value: string): void {
  try { localStorage.setItem(`grove-buddy-${key}`, value); } catch { /* Optional viewer preference. */ }
}
