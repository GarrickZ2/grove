import { ArrowLeft, CircleAlert, CircleCheck, CircleX, Loader2, Square, Trash2 } from "lucide-react";
import type { AutomationRun } from "../../api/automations";
import type { MemoryOverview } from "../../api/memory";
import { ConfirmDialog } from "../../components/Dialogs";
import { TaskChat } from "../../components/Tasks/TaskView/TaskChat";
import { RunTranscript } from "../../components/Memory/MemoryPage";
import { formatNumber, humanize } from "../../components/Memory/memoryFormat";
import { formatTokens } from "../../components/Stats/formatters";
import {
  canFinishRun, durationLabel, formatMetricCost, isAgentRunning, isTerminal, runChanges, runTitle,
} from "../../components/Memory/memoryModel";
import type { MemoryRunsState } from "../../components/Memory/useMemoryRuns";
import { Button, EmptyState, Sheet, formatDateTime } from "../ui";
import { countLabel } from "./memoryView";

interface MemoryRunsSheetProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  overview: MemoryOverview;
  runs: MemoryRunsState;
}

function RunGlyph({ status }: { status: string }) {
  if (status === "success") return <span className="omr-glyph is-ok" title="Completed"><CircleCheck /></span>;
  if (status === "cancelled") return <span className="omr-glyph" title="Cancelled"><CircleX /></span>;
  if (status === "waiting") return <span className="omr-glyph is-warn" title="Waiting"><CircleAlert /></span>;
  if (status === "failed") return <span className="omr-glyph is-bad" title="Failed"><CircleX /></span>;
  return <span className="omr-glyph is-live" title="In progress"><Loader2 className="oui-spin" /></span>;
}

function RunActions({ run, runs }: { run: AutomationRun; runs: MemoryRunsState }) {
  const finishing = runs.finishingRunId === run.id;
  return (
    <span className="omr-acts">
      {canFinishRun(run.status) ? (
        <Button variant="ghost" size="sm" disabled={finishing} onClick={() => void runs.finishRun(run)}>{finishing ? "Finishing…" : "Finish"}</Button>
      ) : null}
      {!isTerminal(run.status) ? (
        <Button variant="ghost" size="sm" onClick={() => runs.cancelRun(run)}><Square />Cancel</Button>
      ) : (
        <Button variant="ghost" iconOnly size="sm" danger aria-label="Delete run" title="Delete run" onClick={() => runs.setDeleteTarget(run)}><Trash2 /></Button>
      )}
    </span>
  );
}

function runMeta(run: AutomationRun) {
  return [formatDateTime(run.triggered_at * 1000), durationLabel(run), run.agent_snapshot].filter(Boolean).join(" · ");
}

/** Organization runs: history with usage, plus a wide viewer for one run's session. */
export function MemoryRunsSheet({ open, onClose, projectId, overview, runs }: MemoryRunsSheetProps) {
  const selected = runs.selectedRun;
  const usage = overview.usage;
  const cost = formatMetricCost(usage.cost_by_currency);
  const summary = [
    `${countLabel(overview.successful_run_count, "run", "runs")} completed`,
    overview.failed_run_count > 0 ? `${formatNumber(overview.failed_run_count)} failed` : null,
    `${formatTokens(usage.total_tokens)} tokens`,
    cost !== "—" ? cost : null,
  ].filter(Boolean).join(" · ");

  return (
    <Sheet
      open={open}
      onClose={onClose}
      onEscape={selected ? () => runs.setExpanded(null) : onClose}
      wide={Boolean(selected)}
      label={selected ? runTitle(selected) : "Organization runs"}
      lead={selected ? (
        <Button variant="ghost" iconOnly aria-label="All runs" title="All runs" onClick={() => runs.setExpanded(null)}><ArrowLeft /></Button>
      ) : null}
      title={selected ? runTitle(selected) : "Organization runs"}
      description={selected ? `${humanize(selected.trigger_kind)} · ${runMeta(selected)}` : summary}
      aside={selected ? <RunActions run={selected} runs={runs} /> : null}
    >
      {runs.error ? (
        <p className="oms-problem" role="alert">{runs.error}<button type="button" onClick={() => runs.setError(null)}>Dismiss</button></p>
      ) : null}
      {selected ? (
        <div className="omr-viewer">
          {selected.resolved_task_id === "_memory" && selected.resolved_chat_id ? (
            <TaskChat
              key={selected.id}
              projectId={projectId}
              taskId={selected.resolved_task_id}
              fixedChatId={selected.resolved_chat_id}
              sessionManagement={false}
              finished={isTerminal(selected.status)}
              fullscreen
              hideHeader
            />
          ) : (
            <div className="omr-transcript oui-scroll">
              <RunTranscript
                events={runs.history}
                usage={runs.historyUsage}
                loading={runs.historyLoading}
                active={isAgentRunning(selected.status)}
                error={selected.error}
                summary={typeof selected.result?.summary === "string" ? selected.result.summary : undefined}
              />
            </div>
          )}
        </div>
      ) : (
        <div className="omr-list oui-scroll">
          {runs.loading && runs.runs.length === 0 ? (
            <div className="omr-loading" aria-hidden="true"><span className="oui-skel" /><span className="oui-skel" /><span className="oui-skel" /></div>
          ) : runs.runs.length === 0 ? (
            <EmptyState title="No organization runs yet">Runs appear here when Grove organizes notes on schedule, after a task is archived, or when you organize by hand.</EmptyState>
          ) : runs.runs.map((run, index) => {
            const changes = runChanges(run.result);
            return (
              <div key={run.id} className="omr-row" style={{ animationDelay: `${Math.min(index, 10) * 30}ms` }}>
                <button type="button" className="omr-open" onClick={() => runs.toggle(run.id)}>
                  <RunGlyph status={run.status} />
                  <span className="omr-copy">
                    <b>{runTitle(run)}<em>{humanize(run.trigger_kind)}</em></b>
                    <small>{runMeta(run)}</small>
                    {changes ? <small className="omr-changes">{countLabel(changes.memories, "memory", "memories")} changed · {countLabel(changes.relations, "link", "links")}</small> : null}
                  </span>
                </button>
                <RunActions run={run} runs={runs} />
              </div>
            );
          })}
        </div>
      )}
      <ConfirmDialog
        isOpen={Boolean(runs.deleteTarget)}
        title="Delete Run"
        message="Delete this completed organization run, its process history, and its recorded token usage? Memory documents produced by the run will not be changed."
        confirmLabel={runs.deleting ? "Deleting…" : "Delete"}
        actionsDisabled={runs.deleting}
        variant="danger"
        onConfirm={() => void runs.confirmDelete()}
        onCancel={() => { if (!runs.deleting) runs.setDeleteTarget(null); }}
      />
    </Sheet>
  );
}

