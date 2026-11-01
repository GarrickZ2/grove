import { ChevronRight } from "lucide-react";
import type { BuddyDelegation } from "../../../api/buddies";
import { delegationStatusLabel, useNow } from "../delegations/delegationFormat";
import type { DelegationRow } from "./buddyTimelineState";

export function DelegationCard({ row, delegation, onOpen }: { row: DelegationRow; delegation?: BuddyDelegation; onOpen: (id: string) => void }) {
  const now = useNow(delegation?.status === "running");
  const status = delegation?.status ?? (row.failed ? "failed" : "running");
  const label = delegation ? delegationStatusLabel(delegation, now) : row.failed ? "Could not start" : "Starting subagent…";
  const content = <><span className={`buddy-delegation-dot is-${status}`} aria-hidden="true" /><span className="buddy-delegation-title">{delegation?.title || row.title}</span><span className={`buddy-delegation-status is-${status}${status === "running" ? " buddy-working" : ""}`}>{label}</span>{delegation && <ChevronRight size={14} aria-hidden="true" />}</>;
  return delegation
    ? <button type="button" className="buddy-card buddy-delegation-card" aria-label={`${delegation.title}: ${label}. Show delegation`} onClick={() => onOpen(delegation.id)}>{content}</button>
    : <div className="buddy-card buddy-delegation-card" role="status">{content}</div>;
}
