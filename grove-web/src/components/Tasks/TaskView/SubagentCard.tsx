import { ChevronRight, LoaderCircle } from "lucide-react";
import { SubagentAvatar } from "./SubagentAvatar";
import { subagentPreview, subagentStatus, type SubagentMessage } from "./subagents";

/** A bounded timeline entry; detailed activity lives in the Subagents panel. */
export function SubagentCard({ message, connected, onOpen }: {
  message: SubagentMessage;
  connected: boolean;
  onOpen?: (sessionId: string) => void;
}) {
  const status = subagentStatus(message, connected);
  return (
    <button type="button" onClick={() => onOpen?.(message.sessionId)} aria-label={`View ${message.title || "Subagent"}`} className="group flex w-full items-center gap-3 rounded-xl border border-[color-mix(in_srgb,var(--color-border)_72%,transparent)] bg-[color-mix(in_srgb,var(--color-bg-secondary)_62%,transparent)] px-3 py-3 text-left transition-colors hover:border-[color-mix(in_srgb,var(--color-highlight)_35%,var(--color-border))] hover:bg-[color-mix(in_srgb,var(--color-bg-secondary)_82%,transparent)] focus-visible:outline-2 focus-visible:outline-[var(--color-highlight)] focus-visible:outline-offset-2">
      <SubagentAvatar sessionId={message.sessionId} size={30} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-xs"><span className="truncate font-medium text-[var(--color-text)]">{message.title || "Subagent"}</span><span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{status}</span></span>
        <span className="mt-0.5 block truncate text-xs text-[var(--color-text-muted)]">{subagentPreview(message)}</span>
      </span>
      {status === "Running" && <LoaderCircle size={13} className="shrink-0 animate-spin text-[var(--color-text-muted)] motion-reduce:animate-none" />}
      <ChevronRight size={14} className="shrink-0 text-[var(--color-text-muted)] opacity-45 transition-opacity group-hover:opacity-100" />
    </button>
  );
}
