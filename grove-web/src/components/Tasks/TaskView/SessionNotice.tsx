import { AlertCircle, AlertTriangle, Info } from "lucide-react";
import type { SessionNoticeMessage } from "./sessionNotices";

export function SessionNotice({ message }: { message: SessionNoticeMessage }) {
  const severity = message.severity;
  const Icon = severity === "error" ? AlertCircle : severity === "warning" ? AlertTriangle : Info;
  const color = severity === "error"
    ? "var(--color-error)"
    : severity === "warning"
      ? "var(--color-warning)"
      : severity === "info" ? "var(--color-highlight)" : "var(--color-text-muted)";
  const label = severity === "error" ? "Error" : severity === "warning" ? "Warning" : severity === "info" ? "Info" : "Notice";
  return (
    <div
      role="note"
      aria-label={label}
      className="flex min-w-0 items-start gap-2 rounded-lg border-l-2 px-3 py-2 text-xs"
      style={{ borderColor: color, background: `color-mix(in srgb, ${color} 6%, transparent)` }}
    >
      <Icon aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color }} />
      <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">
        <div className="font-medium text-[var(--color-text)]">{message.title}</div>
        {message.description && (
          <div className="mt-1 text-[var(--color-text-muted)]">{message.description}</div>
        )}
      </div>
    </div>
  );
}
