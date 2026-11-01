import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { formatDuration, formatTokens } from "../../Stats/formatters";

/** Hover row under a chat message: relative time, token usage, turn duration (seconds) and copy. Shared by TaskChat and Buddy. */
export function MessageActions({ text, timestamp, usage, startTs, endTs, now, alignRight = false }: {
  text: string; timestamp?: number; usage?: { inputTokens: number; outputTokens: number; totalTokens: number }; startTs?: number; endTs?: number; now: number; alignRight?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const date = timestamp == null ? undefined : new Date(timestamp);
  const minutes = date ? Math.max(0, Math.floor((now - date.getTime()) / 60000)) : 0;
  const sameDay = date?.toDateString() === new Date(now).toDateString();
  const time = date && (sameDay && minutes < 1 ? "just now" : sameDay && minutes < 60 ? `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago` : date.toLocaleString(undefined, sameDay ? { hour: "numeric", minute: "2-digit" } : { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }));
  const duration = startTs != null && endTs != null && endTs >= startTs ? formatDuration(endTs - startTs) : undefined;
  const copy = async () => {
    let success = false;
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); success = true; } catch { /* Try selection-based copying. */ }
    }
    if (!success) {
      const textarea = document.createElement("textarea");
      const focused = document.activeElement as HTMLElement | null;
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.top = "-9999px";
      document.body.appendChild(textarea);
      try { textarea.select(); success = document.execCommand("copy"); } catch { success = false; } finally { textarea.remove(); focused?.focus({ preventScroll: true }); }
    }
    if (success) { setCopied(true); window.setTimeout(() => setCopied(false), 2000); }
  };
  return <div className={`mt-1 flex min-h-6 items-center gap-2 text-xs text-[var(--color-text-muted)] opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100 ${alignRight ? "justify-end" : "justify-start"}`}>
    {time && <span title={date?.toLocaleString()}>{time}</span>}
    {usage && <span title={`Input ${usage.inputTokens.toLocaleString()}, output ${usage.outputTokens.toLocaleString()} tokens`}>{formatTokens(usage.totalTokens)} tokens</span>}
    {duration && <span>{duration}</span>}
    <button type="button" title={copied ? "Copied" : "Copy message"} aria-label={copied ? "Copied" : "Copy message"} className="rounded p-1 hover:text-[var(--color-text)] focus-visible:opacity-100" onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
  </div>;
}
