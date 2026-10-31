import { useState } from "react";
import { Check, X } from "lucide-react";
import type { Approval } from "./buddyTimelineState";
export function ApprovalCard({ approval, connected, onRespond }: { approval: Approval; connected: boolean; onRespond: (id: string, option: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<Approval | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = approval.options.find(option => option.option_id === approval.resolved);
  const rejected = selected?.kind.startsWith("reject");
  if (approval.resolved) return <p className="buddy-resolved">{rejected ? <X size={14} className="text-[var(--color-error)]" /> : <Check size={14} className="text-[var(--color-success)]" />}{selected?.name || approval.resolved} · {approval.title}</p>;
  const lines = approval.detail.split("\n");
  return <section className="buddy-card buddy-approval" aria-label="Approval request"><div className="buddy-approval-label"><span />Needs your approval</div><h3>{approval.title}</h3>
    {approval.detail && <><pre>{(expanded ? lines : lines.slice(0, 6)).map((line, index) => <span key={index} className={line.startsWith("+") ? "is-addition" : line.startsWith("-") ? "is-deletion" : ""}>{line}{"\n"}</span>)}</pre>{lines.length > 6 && <button type="button" onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : "Show more"}</button>}</>}
    {error && <p role="alert">{error}</p>}<div className="buddy-approval-actions">{[...approval.options].sort((a, b) => Number(b.kind.startsWith("reject")) - Number(a.kind.startsWith("reject"))).map(option => <button type="button" key={option.option_id} className={`buddy-button${option.kind === "allow_once" ? " is-primary" : ""}`} disabled={!connected || pending === approval} onClick={() => { try { onRespond(approval.id, option.option_id); setPending(approval); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not respond."); } }}>{option.name}</button>)}</div>
  </section>;
}
