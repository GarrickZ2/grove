import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, Brain, CalendarClock, Plus, Repeat, Sparkles, Zap } from "lucide-react";
import type { Automation, AutomationUpsert } from "../../api/automations";
import { useProject } from "../../context";
import { AutomationDialog } from "../../components/Automation/AutomationDialog";
import { ConfirmDialog } from "../../components/Dialogs/ConfirmDialog";
import {
  isSystemManagedAutomation, managedAutomationOwner, MEMORY_AUTOMATION_HANDLER,
} from "../../components/Automation/automationModel";
import { useAutomationCommands, useProjectAutomations } from "../../components/Automation/useAutomations";
import {
  Button, Card, EmptyState, OrbitPage, OrbitPageHeader, OrbitPageMessage, SavedChip, SELECTION_SPRING, StatusDot, useNow, type PageHue,
} from "../ui";
import { AutomationDetail } from "./AutomationDetail";
import { DayStrip } from "./DayStrip";
import { RUN_DOT, buildDayTimeline, nextRunBadge, runTone, scheduleText } from "./automationView";
import { useAllRuns } from "./useAutomationContext";
import "./orbit-automation.css";

interface OrbitAutomationPageProps {
  onOpenChat?: (taskId: string, chatId: string) => void;
  onOpenManagedAutomation?: (handlerKey: string) => void;
}

const HUE: PageHue = {
  from: "#7dd3fc",
  to: "#0369a1",
  strong: "rgb(3 105 161 / 75%)",
  glow: "color-mix(in oklab, #0ea5e9 13%, transparent)",
};

function glyphFor(a: Automation, managed: boolean) {
  if (managed) return Brain;
  if (a.run_once_at) return CalendarClock;
  if (a.event_triggers?.length && !a.schedule_cron) return Zap;
  return Repeat;
}

/** Orbit Automation: one viewport. Today strip on top, the list on the left,
 *  the selected Automation on the right; long lists scroll in their cards. */
export function OrbitAutomationPage({ onOpenChat, onOpenManagedAutomation }: OrbitAutomationPageProps) {
  const { selectedProject } = useProject();
  const projectId = selectedProject?.id ?? null;
  const state = useProjectAutomations(projectId);
  const { automations, isLoading, errorMsg, setErrorMsg, runsRefreshTick, triggeringId, togglingId } = state;
  const now = useNow(30_000);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Automation | null>(null);
  const [deleting, setDeleting] = useState<Automation | null>(null);
  const [savedCount, setSavedCount] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Ids present when a create was submitted; the new row gets selected.
  const createdFrom = useRef<Set<string> | null>(null);

  // User rows first, then the ones Grove features own.
  const ordered = useMemo(() => [
    ...automations.filter((a) => !isSystemManagedAutomation(a)),
    ...automations.filter(isSystemManagedAutomation),
  ], [automations]);
  const firstManaged = ordered.findIndex(isSystemManagedAutomation);

  useEffect(() => {
    const before = createdFrom.current;
    if (!before) return;
    const added = automations.find((a) => !before.has(a.id));
    if (added) {
      createdFrom.current = null;
      void Promise.resolve().then(() => setSelectedId(added.id));
    }
  }, [automations]);

  const selected = ordered.find((a) => a.id === selectedId) ?? ordered[0] ?? null;
  const selectedManaged = selected ? isSystemManagedAutomation(selected) : false;
  const editableSelected = selected && !selectedManaged ? selected : null;

  const allRuns = useAllRuns(projectId, automations, runsRefreshTick);
  const timeline = useMemo(
    () => buildDayTimeline(automations, allRuns, isSystemManagedAutomation, now),
    [automations, allRuns, now],
  );

  const taskNames = useMemo(() => new Map(selectedProject?.tasks.map((t) => [t.id, t.name]) ?? []), [selectedProject]);
  const taskName = useCallback((id: string) => taskNames.get(id), [taskNames]);

  const openCreate = () => { setEditing(null); setDialogOpen(true); };
  const openEdit = (a: Automation) => { setEditing(a); setDialogOpen(true); };
  const run = (a: Automation) => { void state.trigger(a.id); };
  useAutomationCommands({
    projectId,
    current: editableSelected,
    onNew: openCreate,
    onEdit: openEdit,
    onDelete: setDeleting,
    onRun: run,
  });

  const submit = async (input: AutomationUpsert) => {
    if (!editing) createdFrom.current = new Set(automations.map((a) => a.id));
    await state.submit(editing, input);
  };
  const patch = async (a: Automation, changes: Partial<AutomationUpsert>) => {
    const result = await state.patch(a, changes);
    if (result.ok) setSavedCount((n) => n + 1);
    // The reconciling refresh clears the shared error, so keep this one.
    setSaveError(result.error ?? null);
  };
  const confirmDelete = async () => {
    if (!deleting) return;
    const id = deleting.id;
    setDeleting(null);
    await state.remove(id);
  };

  if (!selectedProject || !projectId) {
    return <OrbitPageMessage className="oau">Select a project to manage automations</OrbitPageMessage>;
  }

  const activeCount = automations.filter((a) => a.enabled).length;
  const empty = !isLoading && automations.length === 0;
  const shownError = saveError ?? errorMsg;

  return (
    <OrbitPage
      className="oau"
      hue={HUE}
      overlays={(
        <>
          <AutomationDialog
            isOpen={dialogOpen}
            onClose={() => {
              setDialogOpen(false);
              setEditing(null);
            }}
            projectId={projectId}
            initial={editing}
            onSubmit={submit}
          />
          <ConfirmDialog
            isOpen={!!deleting}
            title="Delete automation"
            message={deleting ? <span>Delete <strong>{deleting.name}</strong>? Its run history will be removed too. This can’t be undone.</span> : ""}
            confirmLabel="Delete"
            cancelLabel="Cancel"
            variant="danger"
            onConfirm={() => void confirmDelete()}
            onCancel={() => setDeleting(null)}
          />
        </>
      )}
    >
      <OrbitPageHeader
        icon={Repeat}
        title="Automation"
        subtitle="Prompts that run on their own — on a schedule or when something happens."
        actions={(
          <>
            <SavedChip count={savedCount} />
            <Button variant="primary" onClick={openCreate}><Plus />New automation</Button>
          </>
        )}
      />

      {shownError ? (
        <div className="oau-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <span className="oui-truncate" title={shownError}>{saveError ? `Couldn’t save: ${saveError}` : shownError}</span>
          <Button variant="ghost" size="sm" onClick={() => { setErrorMsg(null); setSaveError(null); }}>Dismiss</Button>
        </div>
      ) : null}

      {empty ? (
        <Card className="oau-empty oui-rise" style={{ animationDelay: "80ms" }}>
          <EmptyState
            size="lg"
            icon={Sparkles}
            tone="hue"
            title="No automations yet"
            action={<Button variant="primary" onClick={openCreate}><Plus />Create your first automation</Button>}
          >
            Schedule a prompt to fire into a session — daily summaries, hourly checks, weekly reports.
          </EmptyState>
        </Card>
      ) : (
        <>
          <DayStrip timeline={timeline} selectedId={selected?.id ?? null} onPick={setSelectedId} />
          <div className="oau-grid">
            <Card className="oui-rise" style={{ animationDelay: "100ms" }} aria-label="Automations" title="Automations" hint={isLoading && automations.length === 0 ? null : `${activeCount} on`}>
              <div className="oui-card-list oui-scroll" role="listbox" aria-label="Automations">
                {isLoading && automations.length === 0
                  ? [0, 1, 2].map((i) => (
                    <div key={i} className="oau-au is-skel" aria-hidden="true">
                      <span className="oau-au-ic" />
                      <span className="oau-au-copy"><span className="oui-skel" style={{ width: "60%" }} /><span className="oui-skel" style={{ width: "40%", marginTop: 8 }} /></span>
                    </div>
                  ))
                  : ordered.map((a, index) => {
                    const managed = isSystemManagedAutomation(a);
                    const Glyph = glyphFor(a, managed);
                    const badge = nextRunBadge(a, now);
                    const isSel = selected?.id === a.id;
                    const last = a.last_run_status ? runTone(a.last_run_status) : null;
                    return (
                      <div key={a.id}>
                        {index === firstManaged && firstManaged > 0 ? <div className="oau-divider">Managed by Grove</div> : null}
                        <button
                          type="button"
                          role="option"
                          aria-selected={isSel}
                          className={`oau-au${isSel ? " is-sel" : ""}${a.enabled ? "" : " is-off"}`}
                          style={{ animationDelay: `${100 + index * 40}ms` }}
                          onClick={() => setSelectedId(a.id)}
                        >
                          {isSel ? <motion.span layoutId="oau-sel" className="oau-au-pill" transition={SELECTION_SPRING} /> : null}
                          <span className={`oau-au-ic${managed ? " is-managed" : ""}`}><Glyph aria-hidden="true" /></span>
                          <span className="oau-au-copy">
                            <b><span className="oui-truncate">{a.name}</span>{managed ? <span className="oau-badge">{managedAutomationOwner(a.handler_key)}</span> : null}</b>
                            <small>{last ? <StatusDot className="oau-sdot" size="sm" tone={RUN_DOT[last]} title={`Last run: ${a.last_run_status}`} /> : null}{scheduleText(a, now)}</small>
                          </span>
                          {badge ? (
                            <span className="oau-count"><b>{badge.value}</b><span>{badge.caption}</span></span>
                          ) : null}
                        </button>
                      </div>
                    );
                  })}
              </div>
            </Card>

            {selected ? (
              <AutomationDetail
                key={selected.id}
                projectId={projectId}
                automation={selected}
                managedBy={selectedManaged ? managedAutomationOwner(selected.handler_key) : null}
                refreshTick={runsRefreshTick}
                triggering={triggeringId === selected.id}
                busy={togglingId === selected.id}
                taskName={taskName}
                onPatch={(changes) => void patch(selected, changes)}
                onEdit={() => openEdit(selected)}
                onDelete={() => setDeleting(selected)}
                onRun={() => run(selected)}
                onCancelRun={(runId) => void state.cancelRun(selected.id, runId)}
                onOpenChat={onOpenChat}
                onOpenOwner={
                  onOpenManagedAutomation && selected.handler_key === MEMORY_AUTOMATION_HANDLER
                    ? () => onOpenManagedAutomation(selected.handler_key)
                    : undefined
                }
                onSettle={() => void state.refresh()}
              />
            ) : (
              <Card className="oau-detail oui-rise" style={{ animationDelay: "140ms" }} aria-busy="true">
                <div className="oau-edit"><span className="oui-skel" style={{ width: "40%", height: 14 }} /></div>
              </Card>
            )}
          </div>
        </>
      )}
    </OrbitPage>
  );
}
