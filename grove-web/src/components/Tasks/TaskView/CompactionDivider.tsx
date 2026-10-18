import type { ReactNode } from "react";
import { AlertCircle, Check, ChevronDown, Loader2, Minus } from "lucide-react";
import type { CompactionMessage } from "./compactionReducer";

export function CompactionDivider({ message, children }: { message: CompactionMessage; children?: ReactNode }) {
  const active = message.status === "in_progress";
  const failed = message.status === "failed";
  const label = active ? "Compacting" : message.status === "completed" ? "Compacted"
    : failed ? "Compaction failed" : message.status === "cancelled" ? "Compaction cancelled" : message.status === "interrupted" ? "Compaction interrupted" : `Compaction · ${message.status}`;
  const Icon = active ? Loader2 : failed ? AlertCircle : message.status === "completed" ? Check : Minus;
  const hasDetails = message.summary.length > 0 || Boolean(message.error);
  const divider = (
    <>
      <span aria-hidden="true" className="min-w-4 flex-1 border-t border-[var(--color-border)]" />
      <span className={`inline-flex shrink-0 items-center gap-1.5 text-xs ${failed ? "text-[var(--color-error)]" : "text-[var(--color-text-muted)]"}`}>
        <Icon aria-hidden="true" className={`h-3.5 w-3.5${active ? " motion-safe:animate-spin" : ""}`} />
        <span role="status">{label}</span>
        {hasDetails && <ChevronDown aria-hidden="true" className="h-3 w-3 transition-transform group-open:rotate-180" />}
      </span>
      <span aria-hidden="true" className="min-w-4 flex-1 border-t border-[var(--color-border)]" />
    </>
  );
  if (!hasDetails) return <div className="my-3 flex items-center gap-3" aria-label="Context compaction">{divider}</div>;
  return (
    <details className="group my-3" aria-label="Context compaction">
      <summary className="flex cursor-pointer list-none items-center gap-3 rounded focus-visible:outline focus-visible:outline-[var(--color-highlight)] [&::-webkit-details-marker]:hidden">
        {divider}
      </summary>
      <div className="mt-3 min-w-0 space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-3 text-xs">
        {message.error && <div className="whitespace-pre-wrap break-words text-[var(--color-error)]">{message.error}</div>}
        {message.summary.length > 0 && (
          <div>
            <div className="mb-2 text-[var(--color-text-muted)]">Retained context</div>
            <div className="min-w-0 text-[var(--color-text)]">{children}</div>
          </div>
        )}
      </div>
    </details>
  );
}
