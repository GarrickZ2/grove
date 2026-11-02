import { useState } from "react";
import { ArrowUpRight, Brain, Clock4, Loader2, Pencil, Play, RotateCcw, Settings2, Trash2, X, Zap } from "lucide-react";
import type { Automation, AutomationRun, AutomationUpsert } from "../../api/automations";
import { formatDuration, isRunInFlight } from "../../components/Automation/automationModel";
import { useAutomationRuns } from "../../components/Automation/useAutomations";
import { resolveAgentIcon } from "../../utils/agentIcon";
import { Button, Card, StatusDot, Toggle, relativeText, useNow } from "../ui";
import {
  RUN_DOT, agentKeyOf, footLine, runExcerpt, runLabel, runTone, scheduleText, sessionTargetText, taskTargetText, triggerText,
} from "./automationView";
import { useTargetChat } from "./useAutomationContext";

interface AutomationDetailProps {
  projectId: string;
  automation: Automation;
  /** Owning feature for a system-managed row ("Memory"), else null. */
  managedBy: string | null;
  refreshTick: number;
  triggering: boolean;
  busy: boolean;
  taskName: (id: string) => string | undefined;
  onPatch: (changes: Partial<AutomationUpsert>) => void;
  onEdit: () => void;
  onDelete: () => void;
  onRun: () => void;
  onCancelRun: (runId: string) => void;
  onOpenChat?: (taskId: string, chatId: string) => void;
  onOpenOwner?: () => void;
  /** A run finished: the row's last-run state is stale. */
  onSettle: () => void;
}

/** Right card: the selected Automation. Name and prompt edit in place;
 *  schedule and targets open the full editor dialog. */
export function AutomationDetail({
  projectId, automation: a, managedBy, refreshTick, triggering, busy, taskName,
  onPatch, onEdit, onDelete, onRun, onCancelRun, onOpenChat, onOpenOwner, onSettle,
}: AutomationDetailProps) {
  const now = useNow(60_000);
  const editable = managedBy === null;
  const { runs, error } = useAutomationRuns(projectId, a.id, refreshTick, { onSettle });
  const chat = useTargetChat(projectId, a);
  // Drafts exist only while a field has focus; otherwise the server row shows.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [promptDraft, setPromptDraft] = useState<string | null>(null);
  const running = triggering || (runs?.some(isRunInFlight) ?? false);

  const commitName = () => {
    const next = nameDraft?.trim();
    setNameDraft(null);
    if (next && next !== a.name) onPatch({ name: next });
  };
  const commitPrompt = () => {
    const next = promptDraft?.trim();
    setPromptDraft(null);
    if (next && next !== a.prompt.trim()) onPatch({ prompt: next });
  };

  const agentKey = agentKeyOf(a, chat?.agent ?? null);
  const agent = agentKey ? resolveAgentIcon(agentKey) : null;
  const AgentIcon = agent?.Component;
  const triggers = a.event_triggers ?? [];

  return (
    <Card className="oau-detail oui-rise" style={{ animationDelay: "140ms" }} aria-label={a.name}>
      <div className="oau-edit oui-scroll">
        <div className="oau-sec oau-title-row">
          {editable ? (
            <input
              className="oau-title-in"
              type="text"
              aria-label="Automation name"
              value={nameDraft ?? a.name}
              onFocus={() => setNameDraft(a.name)}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") { setNameDraft(null); requestAnimationFrame(() => (e.target as HTMLInputElement).blur()); }
              }}
            />
          ) : (
            <h2 className="oau-title-in">{a.name}</h2>
          )}
          {editable ? (
            <>
              <Button variant="ghost" iconOnly size="sm" aria-label="Edit automation" title="Edit" onClick={onEdit}><Pencil /></Button>
              <Button variant="ghost" iconOnly size="sm" danger aria-label="Delete automation" title="Delete" onClick={onDelete}><Trash2 /></Button>
            </>
          ) : null}
        </div>

        {managedBy ? (
          <div className="oau-sec oau-managed">
            <Brain aria-hidden="true" />
            <span><b>Managed by {managedBy}.</b> Grove runs this on its own. Its schedule and settings live in {managedBy}.</span>
            {onOpenOwner ? <Button variant="secondary" size="sm" onClick={onOpenOwner}><Settings2 />Open {managedBy}</Button> : null}
          </div>
        ) : (
          <div className="oau-sec">
            <span className="oau-lbl">Prompt</span>
            <textarea
              className="oau-prompt"
              aria-label="Prompt"
              rows={3}
              value={promptDraft ?? a.prompt}
              onFocus={() => setPromptDraft(a.prompt)}
              onChange={(e) => setPromptDraft(e.target.value)}
              onBlur={commitPrompt}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.blur();
              }}
            />
          </div>
        )}

        <div className="oau-sec">
          <span className="oau-lbl">When</span>
          <button type="button" className="oau-sentence" onClick={editable ? onEdit : undefined} disabled={!editable}>
            <Clock4 aria-hidden="true" />
            <span className="oui-truncate">{scheduleText(a, now)}</span>
            {!a.run_once_at && a.schedule_cron ? <code>{a.schedule_cron}</code> : null}
          </button>
          {triggers.length ? (
            <div className="oau-chips">
              {triggers.map((t) => <span key={t} className="oau-chip"><Zap aria-hidden="true" />{t}</span>)}
            </div>
          ) : null}
        </div>

        {editable ? (
          <div className="oau-sec">
            <span className="oau-lbl">Where it runs</span>
            <div className="oau-where">
              <button type="button" className="oau-pick" onClick={onEdit}><span>Task</span><b className="oui-truncate">{taskTargetText(a, taskName)}</b></button>
              <button type="button" className="oau-pick" onClick={onEdit}><span>Session</span><b className="oui-truncate">{sessionTargetText(a, chat?.title ?? null)}</b></button>
              <button type="button" className="oau-pick" onClick={onEdit}>
                <span>Agent</span>
                <b className="oui-truncate">{AgentIcon ? <AgentIcon size={14} /> : null}{agent?.label ?? "Session default"}</b>
              </button>
            </div>
          </div>
        ) : null}

        <div className="oau-sec">
          <span className="oau-lbl">Recent runs{runs?.length ? <small>latest {runs.length}</small> : null}</span>
          {error ? (
            <p className="oau-note is-error">Couldn’t load run history: {error}</p>
          ) : runs === null ? (
            <div className="oau-runs" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="oau-run is-skel"><span className="oui-skel" /></div>)}</div>
          ) : runs.length === 0 ? (
            <p className="oau-note">{editable ? "No runs yet. Run it now to see the result here." : "No runs have been recorded yet."}</p>
          ) : (
            <div className="oau-runs">
              {runs.map((run, index) => (
                <RunRow
                  key={run.id}
                  run={run}
                  index={index}
                  editable={editable}
                  onOpenChat={onOpenChat}
                  onCancel={() => onCancelRun(run.id)}
                  now={now}
                  onRerun={onRun}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="oau-foot">
        {editable ? (
          <Toggle checked={a.enabled} onChange={() => onPatch({ enabled: !a.enabled })} label="Enabled" disabled={busy} />
        ) : (
          <span className={`oui-status${a.enabled ? "" : " is-off"}`}><i />{a.enabled ? "Enabled" : "Paused"}</span>
        )}
        <span className="oau-foot-line oui-truncate">{footLine(a, managedBy)}</span>
        {editable ? (
          <Button variant="secondary" size="sm" disabled={triggering} onClick={onRun}>
            {running ? <Loader2 className="oui-spin" /> : <Play />}Run now
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

function RunRow({
  run, index, editable, now, onOpenChat, onCancel, onRerun,
}: {
  run: AutomationRun;
  now: number;
  index: number;
  editable: boolean;
  onOpenChat?: (taskId: string, chatId: string) => void;
  onCancel: () => void;
  onRerun: () => void;
}) {
  const tone = runTone(run.status);
  const excerpt = runExcerpt(run);
  const duration = run.completed_at ? formatDuration((run.completed_at - run.triggered_at) * 1000) : null;
  const canJump = !!(run.resolved_task_id && run.resolved_chat_id && onOpenChat);
  const open = () => { if (canJump) onOpenChat!(run.resolved_task_id!, run.resolved_chat_id!); };
  const cancellable = editable && run.status !== "success" && run.status !== "cancelled";
  const rerunnable = editable && run.status === "cancelled";
  return (
    <div
      className={`oau-run${canJump ? " is-link" : ""}`}
      style={{ animationDelay: `${160 + index * 40}ms` }}
      role={canJump ? "button" : undefined}
      tabIndex={canJump ? 0 : undefined}
      onClick={canJump ? open : undefined}
      onKeyDown={(e) => {
        if (canJump && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(); }
      }}
      title={run.agent_response || run.error || undefined}
    >
      <StatusDot className="oau-st" tone={RUN_DOT[tone]} ring={tone === "live"} pulse={tone === "live"} />
      <span className="oau-run-copy">
        <span className={tone === "live" ? "oau-shimmer" : undefined}>{runLabel(run.status)}</span>
        <small> · {triggerText(run.trigger_kind)}</small>
        {excerpt ? <em className={tone === "fail" ? "is-fail" : undefined}>{excerpt}</em> : null}
      </span>
      <span className="oau-r">{relativeText(run.triggered_at * 1000, now)}</span>
      <span className="oau-r">{duration ?? "—"}</span>
      <span className="oau-run-act">
        {cancellable ? (
          <button type="button" className="oau-mini is-danger" onClick={(e) => { e.stopPropagation(); onCancel(); }} aria-label="Cancel run" title="Cancel"><X /></button>
        ) : rerunnable ? (
          <button type="button" className="oau-mini" onClick={(e) => { e.stopPropagation(); onRerun(); }} aria-label="Run now" title="Run now"><RotateCcw /></button>
        ) : canJump ? (
          <ArrowUpRight className="oau-open" aria-label="Open session" />
        ) : null}
      </span>
    </div>
  );
}
