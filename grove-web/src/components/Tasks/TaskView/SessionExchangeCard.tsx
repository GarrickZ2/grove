import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { sessionExchangeLabel, sessionExchangePreview, type SessionExchangeMessage } from "./subagents";

/** Agent-to-agent traffic stays one line in the timeline; the full text is a click away. */
export function SessionExchangeCard({ message, expanded, onToggle, children }: {
  message: SessionExchangeMessage;
  expanded: boolean;
  onToggle?: () => void;
  children?: ReactNode;
}) {
  const preview = sessionExchangePreview(message);
  return (
    <div className="min-w-0 text-sm">
      <button type="button" onClick={onToggle} aria-expanded={expanded} className="flex w-full min-w-0 items-center gap-1.5 rounded py-0.5 text-left text-xs text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]">
        <ChevronRight aria-hidden="true" size={12} className={`shrink-0 transition-transform motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`} />
        <span className="max-w-[50%] shrink-0 truncate font-medium">{sessionExchangeLabel(message)}</span>
        {!expanded && preview && <span className="min-w-0 flex-1 truncate opacity-70">{preview}</span>}
      </button>
      {expanded && <div className="mt-1 space-y-2 border-l-2 border-[var(--color-border)] pl-3">{children}</div>}
    </div>
  );
}
