import { useContext } from "react";
import { ChevronRight } from "lucide-react";
import { SubagentAvatar } from "./SubagentAvatar";
import { SubagentLinkContext } from "./SubagentLinkContext";

/** A tool call's reference to the child session it works with. */
export function SubagentLink({ sessionId }: { sessionId: string }) {
  const link = useContext(SubagentLinkContext);
  const title = link?.titles.get(sessionId);
  const label = <><SubagentAvatar sessionId={sessionId} size={18} /><span className="min-w-0 truncate">{title || "Subagent"}</span></>;
  // Only a child the Agent announced can be opened.
  if (!link || title === undefined) return <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">{label}</div>;
  return (
    <button type="button" onClick={() => link.open(sessionId)} className="flex max-w-full items-center gap-2 rounded-md px-1.5 py-1 text-xs text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] focus-visible:outline-2 focus-visible:outline-[var(--color-highlight)]">
      {label}<ChevronRight size={13} className="shrink-0 text-[var(--color-text-muted)]" />
    </button>
  );
}
