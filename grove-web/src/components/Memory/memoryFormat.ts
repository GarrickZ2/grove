export function errorMessage(reason: unknown) { if (reason instanceof Error) return reason.message; if (typeof reason === "object" && reason && "message" in reason) return String(reason.message); return "Something went wrong."; }

export function formatNumber(value: number) { return new Intl.NumberFormat().format(value); }

export function formatDate(value: string | number) { const date = typeof value === "number" ? new Date(value) : new Date(value); return Number.isNaN(date.getTime()) ? "Unknown" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date); }

export function relativeDate(value: string | number) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

export function plural(value: number, singular: string, pluralValue: string) { return value === 1 ? singular : pluralValue; }

export function humanize(value: string) { return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }

export function shortId(value: string) { return value.length > 10 ? `${value.slice(0, 8)}…` : value; }
