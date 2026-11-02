import { useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowRight,
  Bell,
  GitBranch,
  Link2,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Send,
  Trash2,
  X,
} from "lucide-react";
import type { NodeStatus } from "../../../api/walkieTalkie";
import type { CustomAgentPersona, CustomAgentServer } from "../../../api";
import type { GraphEdge, GraphNode } from "../../../components/Tasks/TaskView/graphShared";
import type { AcpAgentOption } from "../../../components/Tasks/TaskView/GraphContextToolbar";
import type { EdgeLiveState, EdgeValidity, SpawnInput } from "../../../components/Tasks/TaskView/useTaskGraphModel";
import { AgentPicker } from "../../../components/ui/AgentPicker";
import { agentColor } from "../../../components/Stats/agentColors";
import { resolveAgentIcon } from "../../../utils/agentIcon";
import { Button, DialogField, HoldButton, PopoverMenu, StatusDot } from "../../ui";
import { EDGE_STATE_LABEL, graphSummary, statusMeta } from "./graphLayout";
import type { GraphSelection } from "./GraphCanvas";

export type GraphForm =
  | { kind: "send"; chatId: string }
  | { kind: "spawn"; fromChatId: string | null }
  | { kind: "edit"; chatId: string }
  | { kind: "connect"; fromChatId: string }
  | { kind: "edit-edge"; edgeId: number }
  | { kind: "delete-node"; chatId: string }
  | { kind: "delete-edge"; edgeId: number };

export interface QueuedMessage {
  from: string;
  to: string;
  excerpt: string | undefined;
}

export interface GraphInspectorProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selection: GraphSelection;
  form: GraphForm | null;
  getNodeStatus: (chatId: string) => NodeStatus;
  deriveEdgeState: (from: string, to: string) => EdgeLiveState;
  queued: QueuedMessage[];
  onSelect: (selection: GraphSelection) => void;
  onForm: (form: GraphForm | null) => void;
  onOpenChat: (chatId: string) => void;
  // Spawn options
  defaultAgent: string;
  agentOptions: AcpAgentOption[];
  customAgents: CustomAgentServer[];
  customAgentPersonas: CustomAgentPersona[];
  agentsLoaded: boolean;
  // Actions (resolve true on success)
  busy: { spawning: boolean; sending: boolean; connecting: boolean };
  onSend: (chatId: string, text: string) => Promise<boolean>;
  onSpawn: (input: SpawnInput) => Promise<boolean>;
  onSaveNode: (chatId: string, name: string, duty: string) => Promise<void>;
  onConnect: (from: string, to: string, opts: { duty?: string; purpose?: string }) => Promise<boolean>;
  checkEdge: (from: string, to: string) => EdgeValidity;
  onSavePurpose: (edgeId: number, purpose: string) => Promise<void>;
  onRemind: (edgeId: number) => Promise<void>;
  onDeleteNode: (chatId: string) => Promise<boolean>;
  onDeleteEdge: (edgeId: number) => Promise<boolean>;
  /** Inside the workspace PanelShell: the header carries the summary and New agent. */
  inShell?: boolean;
}

/** Selected-agent / selected-connection detail, the overview, and every inline form. */
export function GraphInspector(props: GraphInspectorProps) {
  const { form, selection, nodes, edges } = props;
  if (form) return <FormView {...props} form={form} />;
  if (selection?.kind === "node") {
    const node = nodes.find((n) => n.chat_id === selection.id);
    if (node) return <NodeDetail {...props} node={node} />;
  }
  if (selection?.kind === "edge") {
    const edge = edges.find((e) => e.edge_id === selection.id);
    if (edge) return <EdgeDetail {...props} edge={edge} />;
  }
  return <Overview {...props} />;
}

function nameOf(nodes: GraphNode[], id: string): string {
  return nodes.find((n) => n.chat_id === id)?.name ?? id;
}

function AgentTile({ agent, status, size = "md" }: { agent: string; status?: NodeStatus; size?: "sm" | "md" }) {
  const Icon = resolveAgentIcon(agent).Component;
  const meta = status ? statusMeta(status) : null;
  return (
    <span className={`ogr-tile is-${size}`} style={{ "--ogr-agent": agentColor(agent) } as CSSProperties} aria-hidden="true">
      <Icon size={size === "sm" ? 13 : 16} />
      {meta ? <StatusDot className="ogr-node-dot" tone={meta.tone} pulse={meta.pulse} /> : null}
    </span>
  );
}

function Pane({ head, children, foot, className }: { head: ReactNode; children?: ReactNode; foot?: ReactNode; className?: string }) {
  return (
    <div className={`ogr-pane${className ? ` ${className}` : ""}`}>
      <div className="ogr-pane-head">{head}</div>
      {children ? <div className="ogr-pane-body oui-scroll">{children}</div> : null}
      {foot ? <div className="ogr-pane-foot">{foot}</div> : null}
    </div>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return <div className="ogr-rows">{children}</div>;
}

function KV({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ogr-kv">
      <span>{label}</span>
      <div>{children}</div>
    </div>
  );
}

// ─── Overview ──────────────────────────────────────────────────────────────

function Overview({ nodes, getNodeStatus, queued, onSelect, onForm, inShell }: GraphInspectorProps) {
  // A one-line strip in a narrow dock (the canvas is the list); a full list beside a wide canvas.
  return (
    <Pane
      className={`is-overview${inShell ? " is-shell" : ""}`}
      head={
        <>
          <div className="ogr-pane-title">
            <b>Agents</b>
            <small className="oui-truncate">{graphSummary(nodes, getNodeStatus, queued.length)}</small>
          </div>
          {inShell ? null : <Button variant="secondary" size="sm" onClick={() => onForm({ kind: "spawn", fromChatId: null })}><Plus />New agent</Button>}
        </>
      }
      foot={<span className="ogr-hint">Double-click an agent to open its chat · ⌘-scroll to zoom</span>}
    >
      <div className="ogr-list">
        {nodes.map((node) => {
          const status = getNodeStatus(node.chat_id);
          const meta = statusMeta(status);
          return (
            <button key={node.chat_id} type="button" className="ogr-list-row" onClick={() => onSelect({ kind: "node", id: node.chat_id })}>
              <AgentTile agent={node.agent} status={status} size="sm" />
              <span className="oui-truncate ogr-list-name">{node.name}</span>
              <span className={`ogr-list-st is-${meta.tone}`}>{meta.label}</span>
            </button>
          );
        })}
      </div>
    </Pane>
  );
}

// ─── Node detail ───────────────────────────────────────────────────────────

function NodeDetail(props: GraphInspectorProps & { node: GraphNode }) {
  const { node, nodes, edges, queued, getNodeStatus, deriveEdgeState, onSelect, onForm, onOpenChat } = props;
  const status = getNodeStatus(node.chat_id);
  const meta = statusMeta(status);
  const agent = resolveAgentIcon(node.agent);
  const inbound = edges.filter((e) => e.to === node.chat_id);
  const outbound = edges.filter((e) => e.from === node.chat_id);
  const waiting = queued.filter((q) => q.to === node.chat_id);
  const sent = queued.filter((q) => q.from === node.chat_id);
  const canConnect = nodes.some((n) => n.chat_id !== node.chat_id);
  return (
    <Pane
      head={
        <>
          <AgentTile agent={node.agent} status={status} />
          <div className="ogr-pane-title">
            <b className="oui-truncate" title={node.name}>{node.name}</b>
            <small className="oui-truncate">{agent.label} · <span className={`ogr-st is-${meta.tone}`}>{meta.label}</span></small>
          </div>
          <Button variant="ghost" size="sm" iconOnly aria-label="Close details" title="Close" onClick={() => onSelect(null)}><X /></Button>
        </>
      }
      foot={
        <>
          <Button variant="secondary" size="sm" onClick={() => onOpenChat(node.chat_id)}><MessageSquare />Open chat</Button>
          <Button variant="secondary" size="sm" onClick={() => onForm({ kind: "send", chatId: node.chat_id })}><Send />Send</Button>
          <Button variant="primary" size="sm" onClick={() => onForm({ kind: "spawn", fromChatId: node.chat_id })}><GitBranch />Spawn child</Button>
          <span className="ogr-sp" />
          <PopoverMenu
            label={`${node.name} actions`}
            items={[
              ...(canConnect ? [{ id: "connect", icon: Link2, title: "Connect to…", description: "Let this agent message another one.", onSelect: () => onForm({ kind: "connect", fromChatId: node.chat_id }) }] : []),
              { id: "edit", icon: Pencil, title: "Edit name & duty", description: "What this agent is called and responsible for.", onSelect: () => onForm({ kind: "edit", chatId: node.chat_id }) },
              { id: "delete", icon: Trash2, title: "Delete agent", description: "Removes its chat and all its connections.", onSelect: () => onForm({ kind: "delete-node", chatId: node.chat_id }) },
            ]}
            trigger={({ open, toggle }) => (
              <Button variant="ghost" size="sm" iconOnly aria-label="More actions" aria-expanded={open} title="More" onClick={toggle}><MoreHorizontal /></Button>
            )}
          />
        </>
      }
    >
      <Rows>
        <KV label="Duty">{node.duty?.trim() ? <p className="ogr-text">{node.duty}</p> : <span className="ogr-muted">Not set yet — the agent sets it on its first message.</span>}</KV>
        {waiting.length ? (
          <KV label="Waiting">
            {waiting.map((q) => <QueuedLine key={`${q.from}>${q.to}`} who={`From ${nameOf(nodes, q.from)}`} excerpt={q.excerpt} />)}
          </KV>
        ) : null}
        {sent.length ? (
          <KV label="Sent">
            {sent.map((q) => <QueuedLine key={`${q.from}>${q.to}`} who={`To ${nameOf(nodes, q.to)}`} excerpt={q.excerpt} />)}
          </KV>
        ) : null}
        {inbound.length || outbound.length ? (
          <KV label="Connections">
            <div className="ogr-links">
              {inbound.map((e) => (
                <EdgeLink key={e.edge_id} dir="in" name={nameOf(nodes, e.from)} edge={e} state={deriveEdgeState(e.from, e.to)} onClick={() => onSelect({ kind: "edge", id: e.edge_id })} />
              ))}
              {outbound.map((e) => (
                <EdgeLink key={e.edge_id} dir="out" name={nameOf(nodes, e.to)} edge={e} state={deriveEdgeState(e.from, e.to)} onClick={() => onSelect({ kind: "edge", id: e.edge_id })} />
              ))}
            </div>
          </KV>
        ) : null}
      </Rows>
    </Pane>
  );
}

function QueuedLine({ who, excerpt }: { who: string; excerpt: string | undefined }) {
  return (
    <div className="ogr-queued">
      <b>{who}</b>
      {excerpt ? <span>{excerpt}</span> : null}
    </div>
  );
}

function EdgeLink({ dir, name, edge, state, onClick }: { dir: "in" | "out"; name: string; edge: GraphEdge; state: EdgeLiveState; onClick: () => void }) {
  return (
    <button type="button" className="ogr-link" onClick={onClick} title={edge.purpose || undefined}>
      <span className="ogr-link-dir">{dir === "in" ? "From" : "To"}</span>
      <b className="oui-truncate">{name}</b>
      {edge.purpose ? <span className="oui-truncate ogr-muted">{edge.purpose}</span> : <span className="ogr-sp" />}
      {state !== "idle" ? <span className={`ogr-chip is-${state}`}>{EDGE_STATE_LABEL[state]}</span> : null}
    </button>
  );
}

// ─── Edge detail ───────────────────────────────────────────────────────────

function EdgeDetail(props: GraphInspectorProps & { edge: GraphEdge }) {
  const { edge, nodes, queued, getNodeStatus, deriveEdgeState, onSelect, onForm, onRemind } = props;
  const state = deriveEdgeState(edge.from, edge.to);
  const targetStatus = getNodeStatus(edge.to);
  const pending = queued.find((q) => q.from === edge.from && q.to === edge.to);
  const hasPending = state !== "idle";
  const canRemind = hasPending && targetStatus === "idle";
  const remindTitle = canRemind
    ? "Nudge the target to read its queued message"
    : !hasPending
      ? "No pending message on this edge"
      : targetStatus === "busy"
        ? "Target session is currently working"
        : "Target session is not idle";
  const [reminding, setReminding] = useState(false);
  return (
    <Pane
      head={
        <>
          <span className="ogr-tile is-md is-plain" aria-hidden="true"><ArrowRight size={15} /></span>
          <div className="ogr-pane-title">
            <b className="oui-truncate">
              <button type="button" className="ogr-namelink" onClick={() => onSelect({ kind: "node", id: edge.from })}>{nameOf(nodes, edge.from)}</button>
              <span className="ogr-muted"> → </span>
              <button type="button" className="ogr-namelink" onClick={() => onSelect({ kind: "node", id: edge.to })}>{nameOf(nodes, edge.to)}</button>
            </b>
            <small className="oui-truncate">Connection · <span className={`ogr-st is-${state}`}>{EDGE_STATE_LABEL[state]}</span></small>
          </div>
          <Button variant="ghost" size="sm" iconOnly aria-label="Close details" title="Close" onClick={() => onSelect(null)}><X /></Button>
        </>
      }
      foot={
        <>
          <Button
            variant="secondary"
            size="sm"
            disabled={!canRemind || reminding}
            title={remindTitle}
            onClick={async () => { setReminding(true); try { await onRemind(edge.edge_id); } finally { setReminding(false); } }}
          >
            {reminding ? <Loader2 className="oui-spin" /> : <Bell />}Remind
          </Button>
          <Button variant="secondary" size="sm" onClick={() => onForm({ kind: "edit-edge", edgeId: edge.edge_id })}><Pencil />Edit purpose</Button>
          <span className="ogr-sp" />
          <Button variant="ghost" size="sm" danger iconOnly aria-label="Delete connection" title="Delete connection" onClick={() => onForm({ kind: "delete-edge", edgeId: edge.edge_id })}><Trash2 /></Button>
        </>
      }
    >
      <Rows>
        <KV label="Purpose">{edge.purpose?.trim() ? <p className="ogr-text">{edge.purpose}</p> : <span className="ogr-muted">No purpose set.</span>}</KV>
        {pending ? <KV label="Queued"><QueuedLine who={`From ${nameOf(nodes, edge.from)}`} excerpt={pending.excerpt} /></KV> : null}
        <KV label="Target">{nameOf(nodes, edge.to)} · {statusMeta(targetStatus).label}</KV>
      </Rows>
    </Pane>
  );
}

// ─── Forms ─────────────────────────────────────────────────────────────────

function FormView(props: GraphInspectorProps & { form: GraphForm }) {
  const { form } = props;
  // Remount per target so each form starts from a fresh draft.
  switch (form.kind) {
    case "send": return <SendForm key={`send-${form.chatId}`} {...props} chatId={form.chatId} />;
    case "spawn": return <SpawnForm key={`spawn-${form.fromChatId ?? ""}`} {...props} fromChatId={form.fromChatId} />;
    case "edit": return <EditForm key={`edit-${form.chatId}`} {...props} chatId={form.chatId} />;
    case "connect": return <ConnectForm key={`connect-${form.fromChatId}`} {...props} fromChatId={form.fromChatId} />;
    case "edit-edge": return <EditEdgeForm key={`edge-${form.edgeId}`} {...props} edgeId={form.edgeId} />;
    case "delete-node": return <DeleteForm key={`dn-${form.chatId}`} {...props} target={{ kind: "node", id: form.chatId }} />;
    case "delete-edge": return <DeleteForm key={`de-${form.edgeId}`} {...props} target={{ kind: "edge", id: form.edgeId }} />;
  }
}

/** ⌘/Ctrl+Enter submits a form; Escape is handled by the panel root. */
function submitOnMetaEnter(submit: () => void) {
  return (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };
}

function FormPane({ title, sub, children, onCancel, submit, submitLabel, submitting, canSubmit, hint = "⌘↵ to save · Esc to cancel" }: {
  title: ReactNode;
  sub?: ReactNode;
  children: ReactNode;
  onCancel: () => void;
  submit: () => void;
  submitLabel: string;
  submitting?: boolean;
  canSubmit: boolean;
  hint?: string;
}) {
  return (
    <form
      className="ogr-pane is-form"
      onSubmit={(event) => { event.preventDefault(); if (canSubmit && !submitting) submit(); }}
      onKeyDown={submitOnMetaEnter(() => { if (canSubmit && !submitting) submit(); })}
    >
      <div className="ogr-pane-head">
        <div className="ogr-pane-title">
          <b className="oui-truncate">{title}</b>
          {sub ? <small className="oui-truncate">{sub}</small> : null}
        </div>
        <Button variant="ghost" size="sm" iconOnly aria-label="Cancel" title="Cancel" onClick={onCancel}><X /></Button>
      </div>
      <div className="ogr-pane-body oui-scroll ogr-fields">{children}</div>
      <div className="ogr-pane-foot">
        <span className="ogr-hint">{hint}</span>
        <span className="ogr-sp" />
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" size="sm" type="submit" disabled={!canSubmit || submitting}>
          {submitting ? <Loader2 className="oui-spin" /> : null}{submitLabel}
        </Button>
      </div>
    </form>
  );
}

function SendForm(props: GraphInspectorProps & { chatId: string }) {
  const { chatId, nodes, getNodeStatus, busy, onSend, onForm } = props;
  const [text, setText] = useState("");
  const name = nameOf(nodes, chatId);
  const offline = getNodeStatus(chatId) === "disconnected";
  const submit = async () => {
    if (await onSend(chatId, text)) onForm(null);
  };
  return (
    <FormPane
      title={`Message ${name}`}
      sub={offline ? "Not running — sending starts it" : "Queued into its chat as a user message"}
      onCancel={() => onForm(null)}
      submit={submit}
      submitLabel="Send"
      submitting={busy.sending}
      canSubmit={!!text.trim()}
      hint="↵ to send · ⇧↵ for a new line"
    >
      <textarea
        autoFocus
        className="ogr-textarea"
        rows={3}
        value={text}
        aria-label={`Message to ${name}`}
        placeholder={offline ? `Start and send to ${name}…` : `Send to ${name}…`}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
            event.preventDefault();
            if (text.trim() && !busy.sending) void submit();
          }
        }}
      />
    </FormPane>
  );
}

function SpawnForm(props: GraphInspectorProps & { fromChatId: string | null }) {
  const { fromChatId, nodes, defaultAgent, agentOptions, customAgents, customAgentPersonas, agentsLoaded, busy, onSpawn, onForm, onSelect } = props;
  const [agent, setAgent] = useState(defaultAgent);
  const [name, setName] = useState("");
  const [duty, setDuty] = useState("");
  const [purpose, setPurpose] = useState("");
  const parent = fromChatId ? nameOf(nodes, fromChatId) : null;
  const canSubmit = !!agent && !!name.trim();
  const submit = async () => {
    if (await onSpawn({ fromChatId, agent, name, duty, purpose })) {
      onForm(null);
      if (fromChatId) onSelect({ kind: "node", id: fromChatId });
    }
  };
  return (
    <FormPane
      title={parent ? `Spawn child of ${parent}` : "New agent"}
      sub={parent ? `${parent} can message it once it starts` : "A new session in this task"}
      onCancel={() => onForm(null)}
      submit={submit}
      submitLabel="Spawn"
      submitting={busy.spawning}
      canSubmit={canSubmit}
      hint="⌘↵ to spawn · Esc to cancel"
    >
      <DialogField label="Agent" as="div">
        <AgentPicker
          value={agent}
          onChange={setAgent}
          placeholder={agentsLoaded ? "Select agent…" : "Checking…"}
          allowCustom={false}
          options={agentOptions}
          customAgents={customAgents}
          customAgentPersonas={customAgentPersonas}
          triggerSize="compact"
        />
      </DialogField>
      <DialogField label="Name">
        <input autoFocus className="oui-field" value={name} placeholder="Unique within this task" onChange={(event) => setName(event.target.value)} />
      </DialogField>
      <DialogField label="Duty" note="Optional — the agent sets it on its first message.">
        <textarea className="ogr-textarea" rows={2} value={duty} placeholder="What this agent is responsible for" onChange={(event) => setDuty(event.target.value)} />
      </DialogField>
      {parent ? (
        <DialogField label="Purpose of the connection">
          <input className="oui-field" value={purpose} placeholder="Optional" onChange={(event) => setPurpose(event.target.value)} />
        </DialogField>
      ) : null}
    </FormPane>
  );
}

function EditForm(props: GraphInspectorProps & { chatId: string }) {
  const { chatId, nodes, onSaveNode, onForm } = props;
  const node = nodes.find((n) => n.chat_id === chatId);
  const [name, setName] = useState(node?.name ?? "");
  const [duty, setDuty] = useState(node?.duty ?? "");
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true);
    try {
      await onSaveNode(chatId, name, duty);
      onForm(null);
    } finally {
      setSaving(false);
    }
  };
  return (
    <FormPane title={`Edit ${node?.name ?? "agent"}`} onCancel={() => onForm(null)} submit={submit} submitLabel="Save" submitting={saving} canSubmit={!!name.trim()}>
      <DialogField label="Name">
        <input autoFocus className="oui-field" value={name} onChange={(event) => setName(event.target.value)} />
      </DialogField>
      <DialogField label="Duty">
        <textarea className="ogr-textarea" rows={3} value={duty} placeholder="What this agent is responsible for" onChange={(event) => setDuty(event.target.value)} />
      </DialogField>
    </FormPane>
  );
}

function ConnectForm(props: GraphInspectorProps & { fromChatId: string }) {
  const { fromChatId, nodes, checkEdge, busy, onConnect, onForm, onSelect } = props;
  const candidates = nodes.filter((n) => n.chat_id !== fromChatId);
  const [target, setTarget] = useState<string | null>(null);
  const [purpose, setPurpose] = useState("");
  const [duty, setDuty] = useState("");
  const targetNode = candidates.find((n) => n.chat_id === target) ?? null;
  // A target without a duty needs one before it can receive messages.
  const needsDuty = !!targetNode && !targetNode.duty?.trim();
  const canSubmit = !!targetNode && checkEdge(fromChatId, targetNode.chat_id).ok && (!needsDuty || !!duty.trim());
  const submit = async () => {
    if (!targetNode) return;
    const ok = await onConnect(fromChatId, targetNode.chat_id, { purpose, duty: needsDuty ? duty : undefined });
    if (ok) {
      onForm(null);
      onSelect({ kind: "node", id: fromChatId });
    }
  };
  return (
    <FormPane
      title={`Connect ${nameOf(nodes, fromChatId)} to…`}
      sub="It can then send messages along this connection"
      onCancel={() => onForm(null)}
      submit={submit}
      submitLabel="Connect"
      submitting={busy.connecting}
      canSubmit={canSubmit}
      hint="⌘↵ to connect · Esc to cancel"
    >
      <div className="ogr-pick" role="radiogroup" aria-label="Target agent">
        {candidates.map((node) => {
          const validity = checkEdge(fromChatId, node.chat_id);
          const picked = target === node.chat_id;
          return (
            <button
              key={node.chat_id}
              type="button"
              role="radio"
              aria-checked={picked}
              disabled={!validity.ok}
              className={`ogr-list-row${picked ? " is-picked" : ""}`}
              title={validity.ok ? undefined : validity.reason}
              onClick={() => setTarget(node.chat_id)}
            >
              <AgentTile agent={node.agent} size="sm" />
              <span className="oui-truncate ogr-list-name">{node.name}</span>
              {validity.ok ? null : <span className="ogr-list-st is-off">{validity.reason}</span>}
            </button>
          );
        })}
      </div>
      {needsDuty ? (
        <DialogField label={`Duty for ${targetNode?.name}`} note="It has no duty yet; set one so it knows what to do with messages.">
          <textarea className="ogr-textarea" rows={2} value={duty} onChange={(event) => setDuty(event.target.value)} />
        </DialogField>
      ) : null}
      <DialogField label="Purpose">
        <input className="oui-field" value={purpose} placeholder="Optional" onChange={(event) => setPurpose(event.target.value)} />
      </DialogField>
    </FormPane>
  );
}

function EditEdgeForm(props: GraphInspectorProps & { edgeId: number }) {
  const { edgeId, edges, nodes, onSavePurpose, onForm } = props;
  const edge = edges.find((e) => e.edge_id === edgeId);
  const [purpose, setPurpose] = useState(edge?.purpose ?? "");
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true);
    try {
      await onSavePurpose(edgeId, purpose);
      onForm(null);
    } finally {
      setSaving(false);
    }
  };
  return (
    <FormPane
      title="Connection purpose"
      sub={edge ? `${nameOf(nodes, edge.from)} → ${nameOf(nodes, edge.to)}` : undefined}
      onCancel={() => onForm(null)}
      submit={submit}
      submitLabel="Save"
      submitting={saving}
      canSubmit
    >
      <textarea autoFocus className="ogr-textarea" rows={3} value={purpose} aria-label="Purpose" placeholder="Why does this connection exist?" onChange={(event) => setPurpose(event.target.value)} />
    </FormPane>
  );
}

function DeleteForm(props: GraphInspectorProps & { target: { kind: "node"; id: string } | { kind: "edge"; id: number } }) {
  const { target, nodes, edges, onDeleteNode, onDeleteEdge, onForm, onSelect } = props;
  const edge = target.kind === "edge" ? edges.find((e) => e.edge_id === target.id) : null;
  const title = target.kind === "node" ? `Delete ${nameOf(nodes, target.id)}?` : "Delete this connection?";
  const sub = target.kind === "node"
    ? "Its chat and all its connections are removed."
    : edge ? `${nameOf(nodes, edge.from)} will no longer message ${nameOf(nodes, edge.to)}.` : undefined;
  const confirm = async () => {
    const ok = target.kind === "node" ? await onDeleteNode(target.id) : await onDeleteEdge(target.id);
    onForm(null);
    if (ok) onSelect(null);
  };
  return (
    <div className="ogr-pane is-form">
      <div className="ogr-pane-head">
        <span className="ogr-tile is-md is-danger" aria-hidden="true"><Trash2 size={15} /></span>
        <div className="ogr-pane-title">
          <b className="oui-truncate">{title}</b>
          {sub ? <small className="ogr-wrap">{sub}</small> : null}
        </div>
      </div>
      <div className="ogr-pane-foot">
        <span className="ogr-sp" />
        <Button variant="ghost" size="sm" autoFocus onClick={() => onForm(null)}>Cancel</Button>
        <HoldButton size="sm" onConfirm={() => void confirm()}>Hold to delete</HoldButton>
      </div>
    </div>
  );
}
