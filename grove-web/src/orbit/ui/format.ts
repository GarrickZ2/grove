// Orbit's date and time wording. The UI is English, so dates are formatted
// in en-US whatever the machine's locale is (a zh-CN system would otherwise
// show "10月26日" inside English sentences). Times use the local zone unless a
// caller passes `timeZone`.

export const LOCALE = "en-US";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

type DateInput = number | string | Date;

function toMs(value: DateInput): number {
  return value instanceof Date ? value.getTime() : typeof value === "number" ? value : new Date(value).getTime();
}

/** Compact age: "now", "4m", "3h", "2d". */
export function shortAgo(at: number, now: number): string {
  const seconds = Math.floor((now - at) / 1000);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Age as a phrase: "just now", "4m ago", "3h ago", "2d ago". */
export function agoText(at: number, now: number): string {
  const short = shortAgo(at, now);
  return short === "now" ? "just now" : `${short} ago`;
}

/** Signed distance from now: "in 4m", "12m ago", "in 3h"; past a day, the date and time. */
export function relativeText(at: DateInput, now: number = Date.now()): string {
  const ms = toMs(at);
  if (Number.isNaN(ms)) return "Unknown";
  const diff = ms - now;
  const abs = Math.abs(diff);
  const future = diff > 0;
  if (abs < MIN) return future ? "in <1m" : "<1m ago";
  if (abs < HOUR) {
    const m = Math.round(abs / MIN);
    return future ? `in ${m}m` : `${m}m ago`;
  }
  if (abs < DAY) {
    const h = Math.round(abs / HOUR);
    return future ? `in ${h}h` : `${h}h ago`;
  }
  return `${formatDay(ms, { now })} ${formatClock(ms)}`;
}

/** "Oct 26", or "Oct 26, 2025" outside the current year. */
export function formatDay(at: DateInput, { now = Date.now(), timeZone }: { now?: number; timeZone?: string } = {}): string {
  const date = new Date(toMs(at));
  if (Number.isNaN(date.getTime())) return "Unknown";
  const year = (d: Date) => Number(d.toLocaleDateString(LOCALE, { year: "numeric", timeZone }));
  const sameYear = year(date) === year(new Date(now));
  return date.toLocaleDateString(LOCALE, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone });
}

/** 24-hour clock: "09:05", "23:40". */
export function formatClock(at: DateInput, timeZone?: string): string {
  return new Date(toMs(at)).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });
}

/** "Oct 26, 2026, 14:05" — tooltips and full timestamps. */
export function formatDateTime(at: DateInput): string {
  const date = new Date(toMs(at));
  if (Number.isNaN(date.getTime())) return "Unknown";
  return `${date.toLocaleDateString(LOCALE, { month: "short", day: "numeric", year: "numeric" })}, ${formatClock(date)}`;
}

/** Any other date shape, in English. */
export function formatDate(at: DateInput, options: Intl.DateTimeFormatOptions): string {
  return new Date(toMs(at)).toLocaleDateString(LOCALE, options);
}
