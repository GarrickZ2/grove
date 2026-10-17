import { ArrowLeft, ArrowUpRight, Check, ChevronRight, LoaderCircle, Square, X } from "lucide-react";
import type { ReactNode } from "react";
import { SubagentAvatar } from "./SubagentAvatar";
import { flattenSubagentMessages, subagentPreview, subagentStatus, type SubagentMessage } from "./subagents";

export function SubagentsPanel({ agents, selectedId, connected, onSelect, onClose, onCancel, onOpenRequest, renderActivity }: {
  agents: SubagentMessage[];
  selectedId?: string;
  connected: boolean;
  onSelect: (id?: string) => void;
  onClose: () => void;
  onCancel?: (id: string) => void;
  onOpenRequest: (kind: "permission" | "elicitation") => void;
  renderActivity: (agent: SubagentMessage) => ReactNode;
}) {
  const selected = agents.find((agent) => agent.sessionId === selectedId);
  const running = agents.filter((agent) => subagentStatus(agent, connected) === "Running").length;
  const status = selected ? subagentStatus(selected, connected) : undefined;
  const request = selected && flattenSubagentMessages(selected.messages).find((message) => (message.type === "permission" || (message.type === "elicitation" && !message.snapshot.opened)) && !message.resolved);
  const canCancel = selected && onCancel && connected && selected.capabilities?.cancel != null && !["idle", "_completed", "_failed", "_cancelled"].includes(selected.state?.state ?? "");
  return (
    <div className="text-[var(--color-text)]">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-[color-mix(in_srgb,var(--color-border)_55%,transparent)] bg-[var(--color-bg-secondary)] px-3 py-2.5">
        {selected ? <button type="button" onClick={() => onSelect()} aria-label="All subagents" className="rounded-md p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg)]"><ArrowLeft size={15} /></button> : <div className="flex -space-x-1.5 pr-1">{agents.slice(0, 3).map((agent) => <SubagentAvatar key={agent.sessionId} sessionId={agent.sessionId} size={22} />)}</div>}
        {selected && <SubagentAvatar sessionId={selected.sessionId} size={26} />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{selected ? selected.title || "Subagent" : "Subagents"}</div>
          <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">{selected ? status : `${agents.length} agents${running ? ` · ${running} running` : ""}`}</div>
        </div>
        {status === "Running" && <LoaderCircle size={13} className="animate-spin text-[var(--color-text-muted)] motion-reduce:animate-none" />}
        {canCancel && <button type="button" onClick={() => onCancel?.(selected.sessionId)} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-error)]"><Square size={10} />Stop</button>}
        <button type="button" onClick={onClose} aria-label="Close subagents panel" className="rounded-md p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg)]"><X size={14} /></button>
      </div>
      {selected ? (
        <div className="px-3 pb-3 pt-2">
          {selected.description && !selected.description.startsWith("Delegated task for ") && <p className="mb-3 line-clamp-2 text-xs leading-relaxed text-[var(--color-text-muted)]" title={selected.description}>{selected.description}</p>}
          {request && <button type="button" onClick={() => onOpenRequest(request.type === "permission" ? "permission" : "elicitation")} className="mb-3 flex w-full items-center justify-between rounded-lg bg-[color-mix(in_srgb,var(--color-highlight)_9%,transparent)] px-3 py-2 text-xs text-[var(--color-highlight)]"><span>{request.type === "permission" ? "Permission requested" : "Your response is needed"}</span><ArrowUpRight size={14} /></button>}
          {selected.messages.length ? renderActivity(selected) : <p className="py-8 text-center text-xs text-[var(--color-text-muted)]">Waiting for the first update…</p>}
        </div>
      ) : (
        <div className="space-y-0.5 p-1.5">
          {agents.map((agent) => {
            const state = subagentStatus(agent, connected);
            return <button key={agent.sessionId} type="button" onClick={() => onSelect(agent.sessionId)} className="group flex w-full items-center gap-3 rounded-xl px-2.5 py-3 text-left transition-colors hover:bg-[var(--color-bg)]">
              <div className="relative"><SubagentAvatar sessionId={agent.sessionId} size={34} />{state === "Running" && <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--color-bg-secondary)] bg-[var(--color-highlight)]" />}</div>
              <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{agent.title || "Subagent"}</span><span className="mt-1 block truncate text-[11px] text-[var(--color-text-muted)]">{subagentPreview(agent)}</span></span>
              <span className={`inline-flex shrink-0 items-center gap-1 text-[10px] ${state === "Needs your input" ? "text-[var(--color-highlight)]" : "text-[var(--color-text-muted)]"}`}>{state === "Completed" && <Check size={11} />}{state}</span>
              <ChevronRight size={13} className="shrink-0 text-[var(--color-text-muted)] opacity-35 group-hover:opacity-80" />
            </button>;
          })}
        </div>
      )}
    </div>
  );
}
