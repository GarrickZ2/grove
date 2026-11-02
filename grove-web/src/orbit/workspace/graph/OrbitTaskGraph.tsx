import { useMemo, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { AlertTriangle, ArrowRight, Check, LayoutGrid, Maximize2, Network, Plus } from "lucide-react";
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
import { ConnectPrompt, GraphInspector, type GraphForm, type QueuedMessage } from "./GraphInspector";
import { graphSummary, nodeDisplayStatus, type GraphNodeStatus, type Point } from "./graphLayout";
import "./orbit-graph.css";

interface OrbitTaskGraphProps {
  projectId: string;
  taskId: string;
}

/**
 * Orbit body of the Agent graph panel. Interactions follow Workbench: click an
 * agent to select it and switch the chat to it, double-click to edit, drag
 * agents anywhere, drag an agent's handle onto another agent to connect, wheel
 * to zoom. A floating action bar shows for the selected agent; a compact card
 * for a selected connection and the inline forms. Body only — the workspace
 * shell owns the panel header.
 */
export function OrbitTaskGraph({ projectId, taskId }: OrbitTaskGraphProps) {
  const graph = useTaskGraphData(projectId, taskId);
  const actions = useTaskGraphActions(projectId, taskId, graph.data, graph.refreshGraph);
  // Re-render when personas change so icons and labels stay current.
  usePersonaRegistry();
  const [rawSelection, setSelection] = useState<GraphSelection>(null);
  const [form, setForm] = useState<GraphForm | null>(null);
  const [linkPrompt, setLinkPrompt] = useState<{ from: string; to: string; anchor: Point } | null>(null);
  const [fitNonce, setFitNonce] = useState(0);
  const [tidyNonce, setTidyNonce] = useState(0);
  const inShell = useInPanelShell();

  const nodes = useMemo(() => graph.data?.nodes ?? [], [graph.data]);
  const edges = useMemo(() => graph.data?.edges ?? [], [graph.data]);
  // A selection whose node/edge disappeared (deleted elsewhere) is dropped.
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
  // What each agent shows: live status, or its last turn's error / done once idle.
  const displayStatus = (chatId: string): GraphNodeStatus =>
    nodeDisplayStatus(graph.getNodeStatus(chatId), graph.getNodeOutcome(chatId), queuedFor(chatId) > 0);

  const ready = !graph.loading && !graph.error;
  const summary = nodes.length ? graphSummary(nodes, displayStatus, queued.length) : "No agents";
  const newAgent = () => { setLinkPrompt(null); setForm({ kind: "spawn", fromChatId: null }); };
  const menuItems = useMemo<PanelMenuItem[]>(
    () => (ready
      ? [
        { id: "graph-new-agent", label: "New agent", icon: Plus, onSelect: () => setForm({ kind: "spawn", fromChatId: null }) },
        { id: "graph-tidy", label: "Tidy up layout", icon: LayoutGrid, onSelect: () => { setTidyNonce((n) => n + 1); setFitNonce((n) => n + 1); } },
      ]
      : []),
    [ready],
  );
  usePanelMenuItems(menuItems);

  const select = (next: GraphSelection) => {
    setSelection(next);
    setLinkPrompt(null);
    // Moving the selection drops a form bound to another target.
    setForm(null);
  };
  /** Click on a card: select it and switch the chat panel to it, as Workbench does. */
  const pickNode = (chatId: string) => {
    setSelection({ kind: "node", id: chatId });
    setLinkPrompt(null);
    setForm((prev) => (prev && "chatId" in prev && prev.chatId !== chatId ? null : prev));
    openGraphChat(chatId);
  };
  const connectDrop = (from: string, to: string, anchor: Point) => {
    const validity = actions.checkEdgeValidity(from, to);
    if (!validity.ok) {
      actions.setToast({ message: validity.reason, type: "error" });
      return;
    }
    const target = nodes.find((n) => n.chat_id === to);
    // A target with a duty connects at once; one without asks for a duty inline.
    if (target?.duty?.trim()) void actions.createEdge(from, to);
    else setLinkPrompt({ from, to, anchor });
  };

  const inspector = (
    <GraphInspector
      nodes={nodes}
      edges={edges}
      selection={selection}
      form={form}
      getNodeStatus={graph.getNodeStatus}
      getDisplayStatus={displayStatus}
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
    />
  );
  const showDock = !!form || !!selection;
  const barOnly = !form && selection?.kind === "node";

  const toast = (
    <div className="ogr-toast-slot">
      <AnimatePresence>
        {actions.toast ? (
          <motion.div
            key={`${actions.toast.type}-${actions.toast.message}`}
            className={`ogr-toast is-${actions.toast.type}`}
            role={actions.toast.type === "error" ? "alert" : "status"}
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2 }}
          >
            {actions.toast.type === "error" ? <AlertTriangle aria-hidden="true" /> : <Check aria-hidden="true" />}
            <span className="oui-truncate">{actions.toast.message}</span>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
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
        return <div className="ogr-state is-solo">{inspector}{toast}</div>;
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
      <div className="ogr-stage">
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          getNodeStatus={displayStatus}
          deriveEdgeState={graph.deriveEdgeState}
          queuedFor={queuedFor}
          checkEdge={actions.checkEdgeValidity}
          selection={selection}
          onSelect={select}
          onPickNode={pickNode}
          onEditNode={(chatId) => { setSelection({ kind: "node", id: chatId }); setLinkPrompt(null); setForm({ kind: "edit", chatId }); }}
          onSpawnFrom={(chatId) => { setSelection({ kind: "node", id: chatId }); setLinkPrompt(null); setForm({ kind: "spawn", fromChatId: chatId }); }}
          onConnectDrop={connectDrop}
          onCanvasDoubleClick={newAgent}
          pendingLink={linkPrompt}
          fitNonce={fitNonce}
          tidyNonce={tidyNonce}
          hideFitButton={inShell}
        />
        {inShell ? null : (
          <div className="ogr-corner">
            <Button variant="secondary" size="sm" onClick={newAgent}><Plus />New agent</Button>
          </div>
        )}
        {linkPrompt ? (
          <ConnectPrompt
            key={`${linkPrompt.from}>${linkPrompt.to}`}
            nodes={nodes}
            from={linkPrompt.from}
            to={linkPrompt.to}
            anchor={linkPrompt.anchor}
            busy={actions.edgeLoading}
            onCancel={() => setLinkPrompt(null)}
            onSubmit={async (duty) => {
              if (await actions.createEdge(linkPrompt.from, linkPrompt.to, { duty })) setLinkPrompt(null);
            }}
          />
        ) : null}
        {edges.length === 0 && nodes.length > 1 && !showDock && !linkPrompt ? (
          <div className="ogr-tip" role="note">
            <ArrowRight aria-hidden="true" />
            <span className="oui-truncate">No delegations yet. Drag the dot on an agent onto another to hand off work.</span>
          </div>
        ) : null}
        <AnimatePresence>
          {showDock ? (
            <motion.div
              key="dock"
              className={`ogr-dock${barOnly ? " is-bar" : ""}`}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.18 }}
            >
              {inspector}
            </motion.div>
          ) : null}
        </AnimatePresence>
        {toast}
      </div>
    );
  })();

  return (
    <MotionConfig reducedMotion="user">
      <div
        className={`orbit-ui ogr${inShell ? " is-shell" : ""}`}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return;
          if (form) { event.preventDefault(); setForm(null); }
          else if (linkPrompt) { event.preventDefault(); setLinkPrompt(null); }
          else if (selection) { event.preventDefault(); setSelection(null); }
        }}
      >
        <div className="ogr-in">{body}</div>
        {ready ? (
          <>
            <PanelHeaderContext><span title={summary}>{summary}</span></PanelHeaderContext>
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
