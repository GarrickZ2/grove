import { useEffect, useMemo, useRef, useState } from "react";
import { Brain, FileText, History, RefreshCw, SlidersHorizontal, Sparkles } from "lucide-react";
import { useProject } from "../../context";
import { useMemoryProject } from "../../components/Memory/useMemoryProject";
import { useMemoryConfigDraft } from "../../components/Memory/useMemoryConfigDraft";
import { useMemoryEntities } from "../../components/Memory/useMemoryEntities";
import { useMemoryLogs } from "../../components/Memory/useMemoryLogs";
import { useMemoryRuns } from "../../components/Memory/useMemoryRuns";
import { useIsMobile } from "../../hooks/useIsMobile";
import { Button, OrbitPage, OrbitPageHeader, OrbitPageMessage, Segmented, useNow, type PageHue } from "../ui";
import { MemoryListCard, type ListMode } from "./MemoryListCard";
import { MemoryDetailCard, type DetailPane } from "./MemoryDetailCard";
import { MemorySettingsSheet } from "./MemorySettingsSheet";
import { MemoryRunsSheet } from "./MemoryRunsSheet";
import { useMemoryAutosave } from "./useMemoryAutosave";
import { activeRunOf, countLabel, organizeAction, organizerStage, unseenIds } from "./memoryView";
import "./orbit-memory.css";

/** Relative times ("next organize in 4h") re-render on this cadence. */
const CLOCK_MS = 30_000;

const HUE: PageHue = {
  from: "#c4b5fd",
  to: "#6d28d9",
  strong: "rgba(109,40,217,.75)",
  glow: "color-mix(in oklab, #7c3aed 13%, transparent)",
};

const STEPS = [
  { title: "Agents leave notes", body: "While they work, agents log short observations from each chat." },
  { title: "Grove organizes", body: "On a schedule, an agent merges notes into durable memories." },
  { title: "Sessions recall", body: "New sessions search Memory before they start work." },
];

/**
 * Memories that appear while the page is open (after organizing) get a New
 * badge and a settle-in glow. Searches are ignored: they surface older
 * memories that were simply outside the loaded snapshot.
 */
function useFreshIds(ids: string[], ready: boolean) {
  const seenRef = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (!ready) return;
    if (seenRef.current === null) {
      seenRef.current = new Set(ids);
      return;
    }
    const added = unseenIds(seenRef.current, ids);
    if (added.length === 0) return;
    added.forEach((id) => seenRef.current?.add(id));
    void Promise.resolve().then(() => setFresh((current) => new Set([...current, ...added])));
  }, [ids, ready]);
  return fresh;
}

interface OrbitMemoryPageProps {
  /** Opens the run whose session is this chat (e.g. from Automation's "Open session"). */
  initialRunChatId?: string;
  /** Show this Project's Memory instead of the selected one (e.g. a Buddy's own Project). */
  projectId?: string;
  /** How the page names that Project; defaults to the selected Project's name. */
  projectName?: string;
}

export function OrbitMemoryPage({ initialRunChatId, projectId, projectName }: OrbitMemoryPageProps) {
  const { selectedProject } = useProject();
  if (projectId) {
    return <ProjectMemory key={projectId} projectId={projectId} projectName={projectName ?? (selectedProject?.id === projectId ? selectedProject.name : "this project")} initialRunChatId={initialRunChatId} />;
  }
  if (!selectedProject) {
    return <OrbitPageMessage className="om">Select a project to see its Memory</OrbitPageMessage>;
  }
  // Keyed so every per-project state (selection, sheets, live runs) starts fresh.
  return <ProjectMemory key={selectedProject.id} projectId={selectedProject.id} projectName={selectedProject.name} initialRunChatId={initialRunChatId} />;
}

type PhoneView = "graph" | "list" | "doc";

function ProjectMemory({ projectId, projectName, initialRunChatId }: { projectId: string; projectName: string; initialRunChatId?: string }) {
  const { selectedProject } = useProject();
  const now = useNow(CLOCK_MS);
  const [mode, setMode] = useState<ListMode>("memories");
  // The mind map leads; picking a memory in the list opens it.
  const [pane, setPane] = useState<DetailPane>("graph");
  // A phone shows one card at a time: the mind map, the list, or an open memory.
  const { isMobile, isTablet } = useIsMobile();
  const phone = isMobile && !isTablet;
  const [phoneView, setPhoneView] = useState<PhoneView>("graph");
  const [phoneDocFrom, setPhoneDocFrom] = useState<"graph" | "list">("graph");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  // Bumped per opening so the guide starts at step 1 but still animates out.
  const [setupRun, setSetupRun] = useState(0);
  const [runsOpen, setRunsOpen] = useState(Boolean(initialRunChatId));

  const project = useMemoryProject(projectId, { liveEvents: runsOpen, agentsReloadKey: settingsOpen });
  const { config, setConfig, overview, bump, refreshTick } = project;
  const editor = useMemoryConfigDraft({
    projectId,
    config,
    agents: project.agents,
    agentsLoading: project.agentsLoading,
    agentsError: project.agentsError,
    onSaved: (next) => { setConfig(next); bump(); },
  });
  const autosave = useMemoryAutosave(editor);
  const entities = useMemoryEntities({ projectId, refreshTick, onChanged: bump });
  const logs = useMemoryLogs({ projectId, refreshTick, onChanged: bump });
  const runs = useMemoryRuns({ projectId, config, refreshTick, liveUpdates: project.liveRunUpdates, openRunChatId: initialRunChatId, onChanged: bump });

  const entityIds = useMemo(() => entities.items.map((entity) => entity.entity_id), [entities.items]);
  const fresh = useFreshIds(entityIds, !entities.loading && entities.submitted === "");
  // Task names are only known for the selected Project.
  const taskNames = useMemo(() => new Map(((selectedProject?.id === projectId ? selectedProject.tasks : undefined) ?? []).map((task) => [task.id, task.name])), [selectedProject, projectId]);

  // Keep a memory open: the strongest visible one until you pick another (and
  // again after Forget clears the selection). A related memory outside the
  // current filter stays open.
  const { visibleItems, selectedId, setSelectedId, loading: entitiesLoading } = entities;
  const firstVisibleId = visibleItems[0]?.entity_id ?? null;
  useEffect(() => {
    if (entitiesLoading || selectedId || !firstVisibleId) return;
    void Promise.resolve().then(() => setSelectedId(firstVisibleId));
  }, [entitiesLoading, firstVisibleId, selectedId, setSelectedId]);

  const activeRun = activeRunOf(runs.runs);
  const stage = organizerStage(config, overview, activeRun, now);
  const action = organizeAction(config, overview, project.runStarting);
  const firstLoad = project.loading && !config;
  const enabled = Boolean(config?.enabled);
  const showIntro = !firstLoad && !enabled && overview.entity_count === 0 && overview.log_count === 0;

  const openRuns = (run = activeRun) => {
    setRunsOpen(true);
    if (run && runs.expanded !== run.id) runs.toggle(run.id);
  };
  const organize = () => {
    if (action.opensRun) openRuns();
    else void project.runOrganization();
  };
  // Turning Memory on always goes through the setup guide: it's only on once
  // the user has confirmed an organizer and a schedule. Cancelling drops the
  // unsaved setup draft.
  const turnOn = () => {
    setSetupRun((run) => run + 1);
    setSetupOpen(true);
  };
  const cancelSetup = () => {
    setSetupOpen(false);
    editor.setDraft(() => editor.savedDraft);
  };
  const finishSetup = () => {
    void editor.save({ ...editor.draft, enabled: true }).then((ok) => {
      if (ok) setSetupOpen(false);
    });
  };
  const refresh = () => { bump(); void project.loadAgents(); };

  return (
    <OrbitPage
      className="om"
      hue={HUE}
      overlays={(
        <>
          <MemorySettingsSheet
            key={setupRun}
            open={setupOpen}
            onClose={cancelSetup}
            projectName={projectName}
            editor={editor}
            autosave={autosave}
            agentsLoading={project.agentsLoading}
            setup={{ onConfirm: finishSetup, saving: editor.saving }}
          />
          <MemorySettingsSheet
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            projectName={projectName}
            editor={editor}
            autosave={autosave}
            agentsLoading={project.agentsLoading}
          />
          <MemoryRunsSheet
            open={runsOpen}
            onClose={() => { setRunsOpen(false); runs.setExpanded(null); }}
            projectId={projectId}
            overview={overview}
            runs={runs}
          />
        </>
      )}
    >
      <OrbitPageHeader
        icon={Brain}
        title="Memory"
        subtitle={`What agents have learned in ${projectName} — and what they’ll recall next session.`}
        actions={(
          <>
            <Button variant="ghost" iconOnly aria-label="Refresh Memory" title="Refresh" disabled={project.loading} onClick={refresh}>
              <RefreshCw className={project.loading ? "oui-spin" : undefined} />
            </Button>
            <Button variant="ghost" iconOnly className="om-runs-btn" aria-label="Organization runs" title="Runs" aria-expanded={runsOpen} onClick={() => setRunsOpen(true)}>
              <History />{overview.active_run_count > 0 ? <i className="om-badge" aria-hidden="true" /> : null}
            </Button>
            <Button variant="ghost" iconOnly aria-label="Memory settings" title="Settings" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(true)}>
              <SlidersHorizontal />
            </Button>
            {enabled ? (
              <Button variant="primary" disabled={action.disabled} onClick={organize}>
                <Sparkles className={action.spinning ? "oui-spin" : undefined} />{action.label}
              </Button>
            ) : null}
          </>
        )}
      />

      {project.error ? (
        <p className="om-notice oui-rise" role="alert">{project.error}<button type="button" onClick={() => project.setError(null)}>Dismiss</button></p>
      ) : null}

      {showIntro ? (
        <section className="om-off oui-rise" style={{ animationDelay: "60ms" }} aria-label="Memory is off">
          <div className="om-off-in">
            <div className="om-orb" aria-hidden="true"><Brain /></div>
            <h2>Let {projectName} remember</h2>
            <p>Agents forget everything between sessions. With Memory on, Grove keeps what they learn here — conventions, decisions, gotchas — so the next agent can recall it.</p>
            <ol className="om-steps">
              {STEPS.map((step, index) => (
                <li key={step.title} style={{ animationDelay: `${140 + index * 80}ms` }}>
                  <em>{index + 1}</em><b>{step.title}</b><span>{step.body}</span>
                </li>
              ))}
            </ol>
            <div className="om-off-acts">
              <Button variant="primary" disabled={project.agentsLoading} onClick={turnOn}>Set up Memory</Button>
            </div>
          </div>
        </section>
      ) : (
        <>
          <section className="om-pipe oui-rise" style={{ animationDelay: "60ms" }} aria-label="Memory pipeline">
            <button type="button" className="om-stage om-stage-hit" onClick={() => { setMode("notes"); setPhoneView("list"); }} title="Show notes">
              <span className={`om-stage-ic${overview.log_count > 0 ? " is-on" : ""}`}><FileText /></span>
              <span className="om-stage-copy">
                <b key={`n${overview.log_count}`} className="om-bump">{firstLoad ? "—" : countLabel(overview.log_count, "new note", "new notes")}</b>
                <span>{overview.log_count > 0 ? "waiting to be organized" : "Agents add notes as they work"}</span>
              </span>
            </button>
            <div className={`om-flow${stage.busy ? " is-on" : ""}`} aria-hidden="true" />
            <div className={`om-stage om-stage-mid${stage.attention ? " is-attention" : ""}`}>
              <button type="button" className="om-stage-hit" onClick={() => openRuns()} title="Show runs">
                <span className={`om-stage-ic${stage.busy || stage.attention ? " is-on" : ""}`}><Sparkles className={stage.busy ? "oui-spin" : undefined} /></span>
                <span className="om-stage-copy">
                  <b>{firstLoad ? "Loading…" : stage.title}</b>
                  <span title={stage.sub}>{firstLoad ? "\u00a0" : stage.sub}</span>
                </span>
              </button>
              {!enabled && !firstLoad ? <Button variant="secondary" size="sm" disabled={editor.saving} onClick={turnOn}>Turn on</Button> : null}
            </div>
            <div className={`om-flow${stage.busy ? " is-on" : ""}`} aria-hidden="true" />
            <button type="button" className="om-stage om-stage-hit" onClick={() => { setMode("memories"); setPhoneView("list"); }} title="Show memories">
              <span className="om-stage-ic is-on"><Brain /></span>
              <span className="om-stage-copy">
                <b key={`m${overview.entity_count}`} className="om-bump">{firstLoad ? "—" : countLabel(overview.entity_count, "memory", "memories")}</b>
                <span>{countLabel(overview.relation_count, "link", "links")} between them</span>
              </span>
            </button>
          </section>

          {phone ? (
            <Segmented<"graph" | "list">
              className="om-phone-switch"
              block
              ariaLabel="Memory view"
              value={phoneView === "graph" ? "graph" : "list"}
              onChange={setPhoneView}
              options={[{ value: "graph", label: "Mind map" }, { value: "list", label: "Memory" }]}
            />
          ) : null}
          <div className={`om-grid${phone ? ` is-phone is-${phoneView}` : ""}`}>
            <div className="oui-rise om-col om-col-list" style={{ animationDelay: "100ms" }}>
              <MemoryListCard
                mode={mode}
                onModeChange={setMode}
                entities={entities}
                logs={logs}
                noteCount={overview.log_count}
                fresh={fresh}
                taskNames={taskNames}
                onOpenMemory={() => {
                  setPane("memory");
                  if (phone) { setPhoneDocFrom("list"); setPhoneView("doc"); }
                }}
                emptyAction={enabled && overview.log_count > 0 ? { label: action.label, onClick: organize, disabled: action.disabled } : null}
              />
            </div>
            <div className="oui-rise om-col om-col-detail" style={{ animationDelay: "140ms" }}>
              <MemoryDetailCard
                pane={phone ? (phoneView === "doc" ? "memory" : "graph") : pane}
                onPaneChange={(next) => {
                  setPane(next);
                  if (!phone) return;
                  if (next === "memory") { setPhoneDocFrom("graph"); setPhoneView("doc"); } else setPhoneView("graph");
                }}
                onBack={phone ? () => setPhoneView(phoneDocFrom) : undefined}
                entities={entities}
                pendingNotes={overview.log_count}
                emptyHint={overview.log_count > 0
                  ? `${countLabel(overview.log_count, "note is", "notes are")} waiting. Organize them to form the first memories.`
                  : "As agents work here they leave notes; organizing turns them into memories every new session can recall."}
              />
            </div>
          </div>
        </>
      )}
    </OrbitPage>
  );
}
