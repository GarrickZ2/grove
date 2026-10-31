import { useCallback, useEffect, useState } from "react";
import { Calendar, Lock, Pencil, Play, Plus, Trash2 } from "lucide-react";
import type { Buddy } from "../../../api/buddies";
import type { Automation } from "../../../api/automations";
import { listBuddyRoutines, runBuddyRoutine, setBuddyRoutineEnabled, saveBuddyRoutine, deleteBuddyRoutine } from "../../../api/buddyResources";
import { useBuddyResource } from "../../../hooks/useBuddyResource";
import { errorMessage } from "../../../utils/errorMessage";
import { describeSchedule, formatRelative } from "../../Automation/automationFormat";
import { ToggleSwitch } from "../../Automation/ToggleSwitch";
import { AutomationDialog } from "../../Automation/AutomationDialog";
import { ConfirmDialog } from "../../Dialogs";

function RoutineDescription({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return <div><p className={expanded ? "whitespace-pre-wrap" : "line-clamp-3"}>{text}</p>{(text.length > 140 || text.split("\n").length > 3) && <button type="button" className="buddy-muted" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : "Show more"}</button>}</div>;
}
export function BuddyRoutines({ buddy, onMemory }: { buddy: Buddy; onMemory?: () => void }) {
  const load = useCallback(() => listBuddyRoutines(buddy), [buddy]);
  const { data, loading, error, refresh } = useBuddyResource(load);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [editing, setEditing] = useState<Automation | "new" | null>(null);
  const [deleting, setDeleting] = useState<Automation | null>(null);
  const [, tick] = useState(0);
  useEffect(() => { const timer = setInterval(() => tick(value => value + 1), 60000); return () => clearInterval(timer); }, []);
  const perform = async (routine: Automation, action: "run" | "toggle" | "delete") => {
    if (busy) return; setBusy(routine.id); setFailure(null); setFeedback(null);
    try {
      if (action === "run") { const result = await runBuddyRoutine(buddy, routine.id); if (result.error || result.status === "failed") throw new Error(result.error || "Could not run routine"); setFeedback("Routine started."); }
      else if (action === "delete") { await deleteBuddyRoutine(buddy, routine.id); setDeleting(null); }
      else await setBuddyRoutineEnabled(buddy, routine, !routine.enabled);
      await refresh();
    } catch (reason) { setFailure(errorMessage(reason)); }
    finally { setBusy(null); }
  };
  return <section className="buddy-panel-section" aria-label="Routines">
    {loading && !data && <p className="buddy-muted">Loading routines…</p>}
    {(error || failure) && <p role="alert">{error || failure}<button type="button" onClick={() => void refresh()}>Retry</button></p>}{feedback && <p role="status" className="buddy-muted">{feedback}</p>}
    {data?.map(routine => routine.handler_key !== "builtin.task_prompt" ? <div className="buddy-system-routine" key={routine.id}><Lock size={14} /><div><strong>Memory organization</strong><p>{describeSchedule(routine.schedule_cron)} · {routine.enabled ? "Enabled" : "Paused"}</p></div><button type="button" onClick={onMemory}>Memory tab</button></div> : <article className="buddy-routine-card" key={routine.id}><div className="buddy-routine-heading"><ToggleSwitch value={routine.enabled} onChange={() => void perform(routine, "toggle")} disabled={busy !== null} label={`Enable ${routine.name}`} /><h3>{routine.name}</h3></div>
      <p className="buddy-muted"><Calendar size={13} /> {describeSchedule(routine.schedule_cron)} · {routine.enabled ? routine.next_run_at ? `next ${formatRelative(new Date(routine.next_run_at * 1000))}` : "No next run scheduled" : "paused"}{routine.event_triggers?.length ? ` · On event: ${routine.event_triggers.join(", ")}` : ""}</p><RoutineDescription text={routine.prompt} />
      <div className="buddy-routine-actions"><button type="button" className="orbit-icon-button" aria-label={`Run ${routine.name} now`} disabled={busy !== null} onClick={() => void perform(routine, "run")}><Play size={15} /></button><button type="button" className="orbit-icon-button" aria-label={`Edit ${routine.name}`} onClick={() => setEditing(routine)}><Pencil size={15} /></button><button type="button" className="orbit-icon-button" aria-label={`Delete ${routine.name}`} onClick={() => setDeleting(routine)}><Trash2 size={15} /></button></div>
    </article>)}
    {data?.length === 0 && <p className="buddy-muted">No routines yet.</p>}
    <button type="button" className="buddy-button" onClick={() => setEditing("new")}><Plus size={15} />New routine</button><p className="buddy-muted">or ask in chat</p>
    {editing && <AutomationDialog key={editing === "new" ? "new" : editing.id} isOpen buddy={buddy} projectId={buddy.project_hash} initial={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onSubmit={async input => { await saveBuddyRoutine(buddy, input, editing === "new" ? undefined : editing.id); await refresh(); }} />}
    <ConfirmDialog isOpen={!!deleting} title="Delete routine?" message={`Delete ${deleting?.name ?? "this routine"}?`} variant="danger" confirmLabel="Delete" actionsDisabled={busy !== null} onCancel={() => setDeleting(null)} onConfirm={() => { if (deleting) void perform(deleting, "delete"); }} />
  </section>;
}
