import { useMemo, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { AlertTriangle, Check, Maximize2, Network, Plus } from "lucide-react";
import {
  openGraphChat,
  useTaskGraphActions,
  useTaskGraphData,
} from "../../../components/Tasks/TaskView/useTaskGraphModel";
import { usePersonaRegistry } from "../../../utils/agentIcon";
import {
  Button,
  PanelEmpty,
  PanelError,
  PanelHeaderActions,
  PanelHeaderContext,
  PanelLoading,
  useInPanelShell,
  usePanelMenuItems,
  type PanelMenuItem,
} from "../../ui";
import { GraphCanvas, type GraphSelection } from "./GraphCanvas";
import { GraphInspector, type GraphForm, type QueuedMessage } from "./GraphInspector";
import { graphSummary } from "./graphLayout";
import "./orbit-graph.css";

interface OrbitTaskGraphProps {
  projectId: string;
  taskId: string;
}

/**
 * Orbit body of the Agent graph panel: the layered agent DAG on a pan/zoom
 * canvas plus an inspector (overview, selected agent / connection, inline
 * forms). Body only — the workspace shell owns the panel header.
 */
export function OrbitTaskGraph({ projectId, taskId }: OrbitTaskGraphProps) {
  const graph = useTaskGraphData(projectId, taskId);
  const actions = useTaskGraphActions(projectId, taskId, graph.data, graph.refreshGraph);
  // Re-render when personas change so icons and labels stay current.
  usePersonaRegistry();
  const [rawSelection, setSelection] = useState<GraphSelection>(null);
  const [form, setForm] = useState<GraphForm | null>(null);
  const [fitNonce, setFitNonce] = useState(0);
  const inShell = useInPanelShell();

  const nodes = useMemo(() => graph.data?.nodes ?? [], [graph.data]);
  const edges = useMemo(() => graph.data?.edges ?? [], [graph.data]);
  // A selection whose node/edge disappeared (deleted elsewhere) falls back to the overview.
  const selection: GraphSelection =
    rawSelection?.kind === "node" && !nodes.some((n) => n.chat_id === rawSelection.id) ? null
      : rawSelection?.kind === "edge" && !edges.some((e) => e.edge_id === rawSelection.id) ? null
        : rawSelection;

  const queued = useMemo<QueuedMessage[]>(() => {
    const out: QueuedMessage[] = [];
    for (const [key, excerpt] of graph.pendingPairsMap) {
      const [from, to] = key.split("::");
      if (from && to) out.push({ from, to, excerpt });
    }
    return out;
  }, [graph.pendingPairsMap]);
  const queuedFor = (chatId: string) => queued.filter((q) => q.to === chatId).length;

  const ready = !graph.loading && !graph.error;
  const newAgent = () => setForm({ kind: "spawn", fromChatId: null });
  const menuItems = useMemo<PanelMenuItem[]>(
    () => (ready ? [{ id: "graph-new-agent", label: "New agent", icon: Plus, onSelect: () => setForm({ kind: "spawn", fromChatId: null }) }] : []),
    [ready],
  );
  usePanelMenuItems(menuItems);

  const select = (next: GraphSelection) => {
    setSelection(next);
    // Moving the selection drops a form bound to the previous target.
    setForm(null);
  };

  const inspector = (
    <GraphInspector
      nodes={nodes}
      edges={edges}
      selection={selection}
      form={form}
      getNodeStatus={graph.getNodeStatus}
      deriveEdgeState={graph.deriveEdgeState}
      queued={queued}
      onSelect={select}
      onForm={setForm}
      onOpenChat={openGraphChat}
      defaultAgent={actions.defaultAgent}
      agentOptions={actions.acpAgentOptions}
      customAgents={actions.customAgents}
      customAgentPersonas={actions.customAgentPersonas}
      agentsLoaded={actions.acpAvailabilityLoaded}
      busy={{ spawning: actions.spawnLoading, sending: actions.sendingMessage, connecting: actions.edgeLoading }}
      onSend={actions.sendMessage}
      onSpawn={actions.spawnNode}
      onSaveNode={actions.saveNode}
      onConnect={actions.createEdge}
      checkEdge={actions.checkEdgeValidity}
      onSavePurpose={actions.updatePurpose}
      onRemind={actions.remindEdge}
      onDeleteNode={actions.deleteNode}
      onDeleteEdge={actions.deleteEdge}
      inShell={inShell}
    />
  );

  const body = (() => {
    if (graph.loading) {
      return <div className="ogr-state"><PanelLoading boxes={3} label="Loading agent graph" /></div>;
    }
    if (graph.error) {
      return (
        <div className="ogr-state">
          <PanelError title="Couldn’t load the agent graph" onRetry={graph.reload}>{graph.error}</PanelError>
        </div>
      );
    }
    if (nodes.length === 0) {
      if (form?.kind === "spawn") {
        return <div className="ogr-side is-solo">{inspector}</div>;
      }
      return (
        <div className="ogr-state">
          <PanelEmpty
            icon={Network}
            title="No agents in this task yet"
            action={<Button variant="primary" size="sm" onClick={newAgent}><Plus />New agent</Button>}
          >
            Start a chat or spawn an agent here. Agents that spawn or message each other show up as a graph.
          </PanelEmpty>
        </div>
      );
    }
    return (
      <>
        <div className="ogr-stage">
          <GraphCanvas
            nodes={nodes}
            edges={edges}
            getNodeStatus={graph.getNodeStatus}
            deriveEdgeState={graph.deriveEdgeState}
            queuedFor={queuedFor}
            selection={selection}
            onSelect={select}
            onOpenChat={openGraphChat}
            onCanvasDoubleClick={newAgent}
            fitNonce={fitNonce}
            hideFitButton={inShell}
          />
          <div className="ogr-toast-slot">
          <AnimatePresence>
            {actions.toast ? (
              <motion.div
                key={`${actions.toast.type}-${actions.toast.message}`}
                className={`ogr-toast is-${actions.toast.type}`}
                role={actions.toast.type === "error" ? "alert" : "status"}
                initial={{ opacity: 0, y: 6, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 4 }}
                transition={{ duration: 0.2 }}
              >
                {actions.toast.type === "error" ? <AlertTriangle aria-hidden="true" /> : <Check aria-hidden="true" />}
                <span className="oui-truncate">{actions.toast.message}</span>
              </motion.div>
            ) : null}
          </AnimatePresence>
          </div>
        </div>
        <div className="ogr-side">{inspector}</div>
      </>
    );
  })();

  return (
    <MotionConfig reducedMotion="user">
      <div
        className={`orbit-ui ogr${inShell ? " is-shell" : ""}`}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return;
          if (form) { event.preventDefault(); setForm(null); }
          else if (selection) { event.preventDefault(); setSelection(null); }
        }}
      >
        <div className="ogr-in">{body}</div>
        {ready ? (
          <>
            <PanelHeaderContext>{nodes.length ? graphSummary(nodes, graph.getNodeStatus, queued.length) : "No agents"}</PanelHeaderContext>
            <PanelHeaderActions>
              {nodes.length ? (
                <Button variant="ghost" size="sm" iconOnly aria-label="Fit graph to view" title="Fit to view" onClick={() => setFitNonce((n) => n + 1)}><Maximize2 /></Button>
              ) : null}
              <Button variant="ghost" size="sm" iconOnly aria-label="New agent" title="New agent" onClick={newAgent}><Plus /></Button>
            </PanelHeaderActions>
          </>
        ) : null}
      </div>
    </MotionConfig>
  );
}
