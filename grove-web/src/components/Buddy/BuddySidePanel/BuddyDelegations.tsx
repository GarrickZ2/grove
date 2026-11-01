import { useContext, useState } from "react";
import type { Buddy, BuddyDelegation } from "../../../api/buddies";
import { useProject } from "../../../context";
import { errorMessage } from "../../../utils/errorMessage";
import { MarkdownRenderer } from "../../ui/MarkdownRenderer";
import { ConfirmDialog } from "../../Dialogs";
import { formatRelative } from "../../Automation/automationFormat";
import { BuddyNavigationContext } from "../buddyNavigation";
import { useBuddyDelegationsContext } from "../delegations/buddyDelegationsContext";
import { elapsedLabel, useNow } from "../delegations/delegationFormat";
import { DelegationRequestCards } from "../delegations/DelegationRequestCards";

const GROUPS: { label: string; match: (item: BuddyDelegation) => boolean }[] = [
  { label: "Needs you", match: item => item.status === "waiting" },
  { label: "Running", match: item => item.status === "running" },
  { label: "Done", match: item => item.status === "done" || item.status === "failed" || item.status === "cancelled" },
];

// Briefs are full hand-off documents; show a peek and let the user expand it.
const LONG_BRIEF_CHARS = 240;
const LONG_BRIEF_LINES = 6;

function DelegationBrief({ brief }: { brief: string }) {
  const [open, setOpen] = useState(false);
  const long = brief.length > LONG_BRIEF_CHARS || brief.split("\n").length > LONG_BRIEF_LINES;
  return <section>
    <h4>Brief</h4>
    <div className={`buddy-delegation-brief${long && !open ? " is-clamped" : ""}`}><MarkdownRenderer content={brief} /></div>
    {long && <button type="button" className="buddy-delegation-more" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Show less" : "Show full brief"}</button>}
  </section>;
}

const PILL: Record<BuddyDelegation["status"], string> = { waiting: "Waiting", running: "Running", done: "Done", failed: "Failed", cancelled: "Cancelled" };

/** Running work shows how long it has been going; finished work shows when it ended. */
function delegationTime(delegation: BuddyDelegation, now: number): string {
  if (delegation.status === "running" || delegation.status === "waiting") return elapsedLabel(delegation.created_at, now);
  const ended = new Date(delegation.completed_at ?? delegation.updated_at);
  return ended.toDateString() === new Date(now).toDateString() ? ended.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : formatRelative(ended);
}

function DelegationItem({ buddy, delegation, expanded, onToggle, onCancel, now }: { buddy: Buddy; delegation: BuddyDelegation; expanded: boolean; onToggle: () => void; onCancel: () => void; now: number }) {
  const { projects } = useProject();
  const { interfaceName, navigate } = useContext(BuddyNavigationContext);
  const [error, setError] = useState<string | null>(null);
  const own = delegation.target_project === buddy.project_hash;
  const project = projects.find(item => item.id === delegation.target_project);
  const task = delegation.target_task === buddy.local_task_id || delegation.target_task === project?.localTask?.id ? "Local" : project?.tasks?.find(item => item.id === delegation.target_task)?.name ?? delegation.target_task;
  const meta = [own ? buddy.name : project?.name ?? "Another project", own ? null : task, delegationTime(delegation, now)].filter(Boolean).join(" · ");
  const waiting = delegation.status === "waiting";
  const open = delegation.status === "running" || waiting;
  const canOpen = !own;
  // Waiting work keeps its request and actions in view; everything else opens on click.
  const footer = (expanded || waiting) && (open || canOpen);
  return <li className={`buddy-delegation is-${delegation.status}${expanded ? " is-expanded" : ""}`}>
    <button type="button" className="buddy-delegation-row" aria-expanded={expanded} onClick={onToggle}>
      <span className="buddy-delegation-copy"><span className="buddy-delegation-title">{delegation.title}</span><span className="buddy-muted">{meta}</span></span>
      <span className={`buddy-delegation-pill is-${delegation.status}`}>{PILL[delegation.status]}</span>
    </button>
    {(expanded || waiting) && <div className="buddy-delegation-detail">
      {expanded && delegation.brief && <DelegationBrief brief={delegation.brief} />}
      <DelegationRequestCards delegation={delegation} compact />
      {expanded && delegation.last_result && <section><h4>Result</h4><div className="buddy-delegation-result"><MarkdownRenderer content={delegation.last_result} /></div></section>}
      {error && <p role="alert">{error}</p>}
      {footer && <div className="buddy-delegation-actions">
        {canOpen && <button type="button" className="buddy-delegation-link" onClick={() => { setError(null); void navigate({ projectId: delegation.target_project, taskId: delegation.target_task, chatId: delegation.target_session }).catch(reason => setError(errorMessage(reason))); }}>Open in {interfaceName}</button>}
        {open && <button type="button" className="buddy-delegation-link is-danger" onClick={onCancel}>Cancel</button>}
      </div>}
    </div>}
  </li>;
}

export function BuddyDelegations({ buddy }: { buddy: Buddy }) {
  const { items, error, focused, cancel } = useBuddyDelegationsContext();
  const [expanded, setExpanded] = useState<string | null>(focused);
  const [handledFocus, setHandledFocus] = useState(focused);
  if (focused !== handledFocus) { setHandledFocus(focused); if (focused) setExpanded(focused); }
  const [cancelling, setCancelling] = useState<BuddyDelegation | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const now = useNow(items.some(item => item.status === "running"));
  return <div className="buddy-panel-section">
    {(error || failure) && <p role="alert">{failure || error}</p>}
    {!items.length && <p className="buddy-muted">No delegations yet. When {buddy.name} hands a bigger job to a subagent, it shows up here.</p>}
    {GROUPS.map(group => {
      const members = items.filter(group.match);
      return members.length ? <section key={group.label} aria-label={group.label}><h3 className="buddy-delegation-group">{group.label}</h3>
        <ul className="buddy-delegation-list">{members.map(item => <DelegationItem key={item.id} buddy={buddy} delegation={item} now={now} expanded={expanded === item.id} onToggle={() => setExpanded(expanded === item.id ? null : item.id)} onCancel={() => setCancelling(item)} />)}</ul>
      </section> : null;
    })}
    <ConfirmDialog isOpen={cancelling !== null} title="Cancel delegation?" message={`The subagent working on "${cancelling?.title ?? ""}" stops its current turn. Its session and history are kept.`} confirmLabel="Cancel delegation" cancelLabel="Keep running" variant="danger"
      onCancel={() => setCancelling(null)} onConfirm={() => { const target = cancelling; setCancelling(null); setFailure(null); if (target) void cancel(target.id).catch(reason => setFailure(errorMessage(reason))); }} />
  </div>;
}
