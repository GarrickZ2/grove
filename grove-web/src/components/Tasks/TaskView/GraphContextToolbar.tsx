import { createElement } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ZoomIn,
  ZoomOut,
  Pencil,
  Trash2,
  Bell,
  Send,
  Loader2,
  Plus,
  GitBranch,
  MessageSquare,
} from "lucide-react";
import type { CustomAgentServer, CustomAgentPersona } from "../../../api";
import type { NodeStatus } from "../../../api/walkieTalkie";
import { AgentPicker } from "../../ui/AgentPicker";
import { agentIconComponent } from "../../../utils/agentIcon";
import { STATUS_COLORS, type GraphNode, type GraphEdge } from "./graphShared";

// Toolbar mode — what state the floating pill is currently morphed into.
// Mirrors TaskGraph's local ToolbarMode; lives here so the toolbar's prop
// types are self-contained.
export type ToolbarModeShape =
  | { kind: "send"; chatId: string }
  | { kind: "edit"; chatId: string; name: string; duty: string }
  | {
      kind: "spawn";
      fromChatId: string | null;
      agent: string;
      name: string;
      duty: string;
      /** Edge purpose — only meaningful when fromChatId != null. */
      purpose: string;
    }
  | { kind: "edit-edge"; edgeId: number; purpose: string }
  | { kind: "confirm-delete-node"; chatId: string; name: string }
  | { kind: "confirm-delete-edge"; edgeId: number };

export interface AcpAgentOption {
  id: string;
  value: string;
  label: string;
  disabled?: boolean;
  disabledReason?: string;
}

export interface ToolbarProps {
  node: GraphNode | null;
  edge: GraphEdge | null;
  nodeStatus: string | null;
  /** Live state of `edge`. `null` when no edge is selected. */
  edgeState: "idle" | "in_flight" | "blocked" | null;
  /** Live status of the selected edge's target node. */
  edgeTargetStatus: NodeStatus | null;
  nodeNameById: (id: string) => string;
  directMessage: string;
  sendingMessage: boolean;
  spawning: boolean;
  defaultAgent: string;
  agentOptionsList: AcpAgentOption[];
  customAgentsList: CustomAgentServer[];
  customAgentPersonasList: CustomAgentPersona[];
  mode: ToolbarModeShape | null;
  onModeChange: (mode: ToolbarModeShape | null) => void;
  onDirectMessageChange: (v: string) => void;
  onSendDirect: (chatId: string, text: string) => void;
  onEditNode: (node: GraphNode) => void;
  onSpawnFrom: (node: GraphNode) => void;
  onDeleteNode: (node: GraphNode) => void;
  onEditEdge: (edge: GraphEdge) => void;
  onRemindEdge: (edge: GraphEdge) => void;
  onDeleteEdge: (edge: GraphEdge) => void;
  onConfirmDeleteNode: (chatId: string) => void;
  onConfirmDeleteEdge: (edgeId: number) => void;
  onSubmitEditEdge: (edgeId: number, purpose: string) => void;
  onNewSession: () => void;
  onSubmitEdit: (chatId: string, name: string, duty: string) => void;
  onSubmitSpawn: (
    fromChatId: string | null,
    agent: string,
    name: string,
    duty: string,
    purpose: string,
  ) => void;
  zoomLevel: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomFit: () => void;
}

const FLOAT_PILL =
  "rounded-3xl select-none border border-[color-mix(in_srgb,var(--color-border)_70%,transparent)] " +
  // Opaque bg (no backdrop-blur). Blur introduced a one-frame
  // bleed-through on mount/mode-change because the GPU layer for
  // backdrop-filter is created lazily — during that first frame the
  // semi-transparent bg lets graph content show through, then snaps
  // clean once blur is established. Solid bg eliminates that flash.
  "bg-[var(--color-bg-secondary)] " +
  "shadow-[0_10px_32px_rgba(0,0,0,0.16),0_2px_8px_rgba(0,0,0,0.06)] " +
  "overflow-hidden";

// Spring keeps the morphing pill feeling alive. restDelta/restSpeed
// tightened to sub-pixel so framer-motion considers the spring at-rest
// only when it's truly aligned — eliminates the "last-frame teleport"
// that happens when the spring stops at a near-rest position a few px
// off from the final measured layout.
const MODE_TRANSITION = {
  type: "spring" as const,
  stiffness: 380,
  damping: 32,
  mass: 0.8,
  restDelta: 0.001,
  restSpeed: 0.001,
};

export function GraphContextToolbar(props: ToolbarProps) {
  const {
    node,
    edge,
    nodeStatus,
    edgeState,
    edgeTargetStatus,
    nodeNameById,
    directMessage,
    sendingMessage,
    spawning,
    defaultAgent,
    agentOptionsList,
    customAgentsList,
    customAgentPersonasList,
    mode,
    onModeChange,
    onDirectMessageChange,
    onSendDirect,
    onEditNode,
    onSpawnFrom,
    onDeleteNode,
    onEditEdge,
    onRemindEdge,
    onDeleteEdge,
    onConfirmDeleteNode,
    onConfirmDeleteEdge,
    onSubmitEditEdge,
    onNewSession,
    onSubmitEdit,
    onSubmitSpawn,
    zoomLevel,
    onZoomIn,
    onZoomOut,
    onZoomFit,
  } = props;

  // Active mode key drives AnimatePresence; the pill morphs around it.
  // Cancellation when the selection moves elsewhere is handled upstream by
  // the click handler that changed the selection.
  const activeKey = mode?.kind ?? (node ? "node" : edge ? "edge" : "empty");
  // Zoom widget lives at top-right (see below) so it never competes with the
  // centered context toolbar for horizontal space in narrow split-pane
  // containers; therefore no mode-driven hide logic is needed anymore.

  return (
    <>
      <motion.div
        layout
        transition={MODE_TRANSITION}
        // Cap at 640px on big monitors, 2rem breathing room from
        // viewport edges. The zoom widget auto-hides when this toolbar
        // shows a wide form, so we don't reserve space for it here.
        className={`absolute bottom-5 left-1/2 -translate-x-1/2 z-40 max-w-[min(calc(100%-2rem),640px)] ${FLOAT_PILL}`}
        style={{ originY: 1 }}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          {mode?.kind === "send" && node && nodeStatus && (
            <motion.div
              key="send"
              layout
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={MODE_TRANSITION}
              className="px-3 py-2"
            >
              <SendForm
                placeholder={
                  nodeStatus === "disconnected"
                    ? `Start and send to ${node.name}…`
                    : `Send to ${node.name}…`
                }
                value={directMessage}
                disabled={sendingMessage}
                sending={sendingMessage}
                onChange={onDirectMessageChange}
                onSend={() => {
                  if (directMessage.trim()) {
                    onSendDirect(node.chat_id, directMessage);
                    onModeChange(null);
                  }
                }}
                onCancel={() => onModeChange(null)}
              />
            </motion.div>
          )}
          {mode?.kind === "edit" && (
            <motion.div
              key="edit"
              layout
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={MODE_TRANSITION}
              className="p-3 w-[min(420px,calc(100vw-3rem))]"
            >
              <EditForm
                name={mode.name}
                duty={mode.duty}
                onNameChange={(v) =>
                  onModeChange(
                    mode.kind === "edit" ? { ...mode, name: v } : mode,
                  )
                }
                onDutyChange={(v) =>
                  onModeChange(
                    mode.kind === "edit" ? { ...mode, duty: v } : mode,
                  )
                }
                onSubmit={() =>
                  onSubmitEdit(mode.chatId, mode.name, mode.duty)
                }
                onCancel={() => onModeChange(null)}
              />
            </motion.div>
          )}
          {mode?.kind === "spawn" && (
            <motion.div
              key="spawn"
              layout
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={MODE_TRANSITION}
              className="p-3 w-[min(420px,calc(100vw-3rem))]"
            >
              <SpawnForm
                agent={mode.agent}
                name={mode.name}
                duty={mode.duty}
                purpose={mode.purpose}
                fromName={
                  mode.fromChatId ? nodeNameById(mode.fromChatId) : null
                }
                agents={agentOptionsList}
                customAgents={customAgentsList}
                customAgentPersonas={customAgentPersonasList}
                onAgentChange={(v) =>
                  onModeChange(
                    mode.kind === "spawn" ? { ...mode, agent: v } : mode,
                  )
                }
                onNameChange={(v) =>
                  onModeChange(
                    mode.kind === "spawn" ? { ...mode, name: v } : mode,
                  )
                }
                onDutyChange={(v) =>
                  onModeChange(
                    mode.kind === "spawn" ? { ...mode, duty: v } : mode,
                  )
                }
                onPurposeChange={(v) =>
                  onModeChange(
                    mode.kind === "spawn" ? { ...mode, purpose: v } : mode,
                  )
                }
                submitting={spawning}
                onSubmit={() =>
                  onSubmitSpawn(
                    mode.fromChatId,
                    mode.agent,
                    mode.name,
                    mode.duty,
                    mode.purpose,
                  )
                }
                onCancel={() => onModeChange(null)}
              />
            </motion.div>
          )}
          {mode?.kind === "edit-edge" && (
            <motion.div
              key="edit-edge"
              layout
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={MODE_TRANSITION}
              className="p-3 w-[min(420px,calc(100vw-3rem))]"
            >
              <EditEdgeForm
                purpose={mode.purpose}
                onPurposeChange={(v) =>
                  onModeChange(
                    mode.kind === "edit-edge"
                      ? { ...mode, purpose: v }
                      : mode,
                  )
                }
                onSubmit={() => onSubmitEditEdge(mode.edgeId, mode.purpose)}
                onCancel={() => onModeChange(null)}
              />
            </motion.div>
          )}
          {mode?.kind === "confirm-delete-node" && (
            <motion.div
              key="confirm-del-node"
              layout
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={MODE_TRANSITION}
              className="flex items-center gap-2 px-3 py-2"
            >
              <ConfirmDeleteRow
                label={
                  <>
                    Delete{" "}
                    <span className="font-semibold">{mode.name}</span>?
                    <span className="text-[10.5px] text-[var(--color-text-muted)] ml-1">
                      (chat + all its edges)
                    </span>
                  </>
                }
                onConfirm={() => onConfirmDeleteNode(mode.chatId)}
                onCancel={() => onModeChange(null)}
              />
            </motion.div>
          )}
          {mode?.kind === "confirm-delete-edge" && (
            <motion.div
              key="confirm-del-edge"
              layout
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={MODE_TRANSITION}
              className="flex items-center gap-2 px-3 py-2"
            >
              <ConfirmDeleteRow
                label={<>Delete this connection?</>}
                onConfirm={() => onConfirmDeleteEdge(mode.edgeId)}
                onCancel={() => onModeChange(null)}
              />
            </motion.div>
          )}
          {!mode && node && nodeStatus && (
            <motion.div
              key={`node-${node.chat_id}`}
              layout
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={MODE_TRANSITION}
              className="flex items-center gap-2 px-3 py-2"
            >
              <NodeContextSection
                node={node}
                status={nodeStatus}
                onSendClick={() =>
                  onModeChange({ kind: "send", chatId: node.chat_id })
                }
                onEditClick={() => onEditNode(node)}
                onSpawnFromClick={() => onSpawnFrom(node)}
                onDeleteClick={() => onDeleteNode(node)}
              />
            </motion.div>
          )}
          {!mode && !node && edge && (
            <motion.div
              key={`edge-${edge.edge_id}`}
              layout
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={MODE_TRANSITION}
              className="flex items-center gap-2 px-3 py-2"
            >
              <EdgeContextSection
                edge={edge}
                edgeState={edgeState}
                targetStatus={edgeTargetStatus}
                fromName={nodeNameById(edge.from)}
                toName={nodeNameById(edge.to)}
                onEditClick={() => onEditEdge(edge)}
                onRemindClick={() => onRemindEdge(edge)}
                onDeleteClick={() => onDeleteEdge(edge)}
              />
            </motion.div>
          )}
          {!mode && !node && !edge && (
            <motion.div
              key="empty"
              layout
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={MODE_TRANSITION}
              className="flex items-center gap-2 px-3 py-2"
            >
              <EmptyContextSection
                onNewSession={() => {
                  onModeChange({
                    kind: "spawn",
                    fromChatId: null,
                    agent: defaultAgent,
                    name: "",
                    duty: "",
                    purpose: "",
                  });
                  onNewSession?.();
                }}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* Zoom widget: zoom out, current level (display-only label), zoom in,
       *  divider, "Reset" text button. The label is intentionally not a
       *  button — users were misreading it as an editable percentage.
       *  Anchored top-right so it never collides with the centered
       *  context toolbar at the bottom in narrow split-pane containers. */}
      <motion.div
        layout
        transition={MODE_TRANSITION}
        className={`absolute top-5 right-5 z-40 flex items-center gap-0.5 px-1.5 py-1.5 ${FLOAT_PILL}`}
        key={`zoom-${activeKey}`}
      >
        <button
          type="button"
          onClick={onZoomOut}
          title="Zoom out"
          className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)] transition-colors"
        >
          <ZoomOut size={14} />
        </button>
        <span className="flex h-7 px-2 items-center justify-center text-[10.5px] font-mono tabular-nums text-[var(--color-text-muted)] select-none">
          {Math.round(zoomLevel * 100)}%
        </span>
        <button
          type="button"
          onClick={onZoomIn}
          title="Zoom in"
          className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)] transition-colors"
        >
          <ZoomIn size={14} />
        </button>
        <span
          className="mx-1 h-4 w-px bg-[color-mix(in_srgb,var(--color-border)_70%,transparent)]"
          aria-hidden
        />
        <button
          type="button"
          onClick={onZoomFit}
          title="Reset zoom and fit graph to view"
          className="flex h-7 px-3 items-center justify-center rounded-full text-[11px] font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)] transition-colors"
        >
          Reset
        </button>
      </motion.div>
    </>
  );
}

function EmptyContextSection({ onNewSession }: { onNewSession: () => void }) {
  return (
    <>
      <button
        type="button"
        onClick={onNewSession}
        className="flex items-center gap-1.5 h-7 px-3 rounded-full bg-[var(--color-highlight)] text-[12px] font-medium text-white hover:opacity-90 transition-opacity shadow-sm shrink-0 whitespace-nowrap"
        title="Create a new session"
      >
        <Plus className="w-3.5 h-3.5" />
        <span>New Session</span>
      </button>
      <span className="text-[11px] text-[var(--color-text-muted)] truncate min-w-0">
        Click a node to switch chat · double-click to edit · drag to rearrange
      </span>
    </>
  );
}

function NodeContextSection({
  node,
  status,
  onSendClick,
  onEditClick,
  onSpawnFromClick,
  onDeleteClick,
}: {
  node: GraphNode;
  status: string;
  onSendClick: () => void;
  onEditClick: () => void;
  onSpawnFromClick: () => void;
  onDeleteClick: () => void;
}) {
  const Icon = agentIconComponent(node.agent);
  const dotColor = STATUS_COLORS[status] || STATUS_COLORS.disconnected;
  return (
    <>
      <div className="flex items-center gap-2 min-w-0">
        <span className="relative shrink-0">
          {createElement(Icon, { size: 16, className: "block" })}
          <span
            className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ring-[var(--color-bg)]"
            style={{ backgroundColor: dotColor }}
            title={status}
          />
        </span>
        <span className="text-[12px] font-medium text-[var(--color-text)] truncate max-w-[180px]">
          {node.name}
        </span>
        <span className="text-[10px] text-[var(--color-text-muted)] shrink-0">
          {status}
        </span>
      </div>
      <div className="ml-2 flex items-center gap-1 shrink-0">
        <ToolbarButton
          icon={<Send className="w-3.5 h-3.5" />}
          label="Send"
          onClick={onSendClick}
          disabled={false}
        />
        <ToolbarButton
          icon={<GitBranch className="w-3.5 h-3.5" />}
          label="Spawn Child"
          onClick={onSpawnFromClick}
        />
        <ToolbarButton
          icon={<Pencil className="w-3.5 h-3.5" />}
          label="Edit"
          onClick={onEditClick}
        />
        <ToolbarButton
          icon={<Trash2 className="w-3.5 h-3.5" />}
          label="Delete"
          onClick={onDeleteClick}
          danger
        />
      </div>
    </>
  );
}

function SendForm({
  placeholder,
  value,
  disabled,
  sending,
  onChange,
  onSend,
  onCancel,
}: {
  placeholder: string;
  value: string;
  disabled: boolean;
  sending: boolean;
  onChange: (v: string) => void;
  onSend: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center gap-2 w-[480px] max-w-full">
      <input
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder={placeholder}
        disabled={disabled}
        className="flex-1 min-w-0 h-8 px-3 text-[12.5px] rounded-full border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)]"
      />
      <button
        type="button"
        onClick={onSend}
        disabled={disabled || !value.trim()}
        className="h-8 w-8 flex items-center justify-center rounded-full bg-[var(--color-highlight)] text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
        title="Send (Enter)"
      >
        {sending ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Send className="w-3.5 h-3.5" />
        )}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="h-8 px-3 text-[11.5px] rounded-full text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
      >
        Cancel
      </button>
    </div>
  );
}

function EditForm({
  name,
  duty,
  onNameChange,
  onDutyChange,
  onSubmit,
  onCancel,
}: {
  name: string;
  duty: string;
  onNameChange: (v: string) => void;
  onDutyChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="flex flex-col gap-2"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          onSubmit();
        }
      }}
    >
      <div className="flex items-center gap-2">
        <Pencil className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />
        <input
          autoFocus
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Name"
          className="flex-1 h-8 px-3 text-[12.5px] rounded-full border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)]"
        />
      </div>
      <textarea
        value={duty}
        onChange={(e) => onDutyChange(e.target.value)}
        placeholder="Duty — what this session is responsible for…"
        rows={3}
        className="px-3 py-2 text-[12.5px] leading-snug rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)] resize-none min-h-[64px]"
      />
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-[var(--color-text-muted)]">
          ⌘/Ctrl + Enter to save · Esc to cancel
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onCancel}
            className="h-7 px-3 text-[11.5px] rounded-full text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            className="h-7 px-3 text-[11.5px] font-medium rounded-full bg-[var(--color-highlight)] text-white hover:opacity-90 transition-opacity"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function SpawnForm({
  agent,
  name,
  duty,
  purpose,
  fromName,
  agents,
  customAgents,
  customAgentPersonas,
  submitting,
  onAgentChange,
  onNameChange,
  onDutyChange,
  onPurposeChange,
  onSubmit,
  onCancel,
}: {
  agent: string;
  name: string;
  duty: string;
  purpose: string;
  fromName: string | null;
  agents: AcpAgentOption[];
  customAgents: CustomAgentServer[];
  customAgentPersonas: CustomAgentPersona[];
  submitting: boolean;
  onAgentChange: (v: string) => void;
  onNameChange: (v: string) => void;
  onDutyChange: (v: string) => void;
  onPurposeChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="flex flex-col gap-2"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          onSubmit();
        }
      }}
    >
      <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
        <Plus className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate">
          {fromName ? `Spawn child from ${fromName}` : "Spawn new session"}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <div className="shrink-0">
          <AgentPicker
            value={agent}
            onChange={onAgentChange}
            allowCustom={false}
            options={agents}
            customAgents={customAgents}
            customAgentPersonas={customAgentPersonas}
            triggerShape="pill"
            triggerSize="compact"
          />
        </div>
        <input
          autoFocus
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Session name"
          className="flex-1 h-8 px-3 text-[12.5px] rounded-full border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)]"
        />
      </div>
      <textarea
        value={duty}
        onChange={(e) => onDutyChange(e.target.value)}
        placeholder="Duty (optional)"
        rows={2}
        className="px-3 py-2 text-[12.5px] leading-snug rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)] resize-none min-h-[48px]"
      />
      {fromName && (
        // Edge purpose only applies when there's a parent edge to label —
        // orphan spawns (no fromName) hide it to keep the form minimal.
        <input
          value={purpose}
          onChange={(e) => onPurposeChange(e.target.value)}
          placeholder="Purpose of this connection (optional)"
          className="h-8 px-3 text-[12.5px] rounded-full border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)]"
        />
      )}
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-[var(--color-text-muted)]">
          ⌘/Ctrl + Enter to spawn · Esc to cancel
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onCancel}
            className="h-7 px-3 text-[11.5px] rounded-full text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={submitting || !name.trim() || !agent}
            className="h-7 px-3 text-[11.5px] font-medium rounded-full bg-[var(--color-highlight)] text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity flex items-center gap-1.5"
          >
            {submitting && <Loader2 className="w-3 h-3 animate-spin" />}
            Spawn
          </button>
        </div>
      </div>
    </div>
  );
}

function EdgeContextSection({
  edge,
  edgeState,
  targetStatus,
  fromName,
  toName,
  onEditClick,
  onRemindClick,
  onDeleteClick,
}: {
  edge: GraphEdge;
  edgeState: "idle" | "in_flight" | "blocked" | null;
  targetStatus: NodeStatus | null;
  fromName: string;
  toName: string;
  onEditClick: () => void;
  onRemindClick: () => void;
  onDeleteClick: () => void;
}) {
  const hasPending = edgeState !== null && edgeState !== "idle";
  const canRemind = hasPending && targetStatus === "idle";
  const remindDisabledTitle = !hasPending
    ? "No pending message on this edge"
    : targetStatus === "busy"
      ? "Target session is currently working"
      : "Target session is not idle";
  return (
    <>
      <div className="flex items-center gap-2 min-w-0 flex-1 text-[12px]">
        <MessageSquare className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-muted)]" />
        <span
          className="font-medium text-[var(--color-text)] truncate max-w-[140px]"
          title={fromName}
        >
          {fromName}
        </span>
        <span className="text-[var(--color-text-muted)] shrink-0">→</span>
        <span
          className="font-medium text-[var(--color-text)] truncate max-w-[140px]"
          title={toName}
        >
          {toName}
        </span>
        {edge.purpose && (
          <span
            className="text-[var(--color-text-muted)] truncate min-w-0"
            title={edge.purpose}
          >
            · {edge.purpose}
          </span>
        )}
      </div>
      <div className="ml-2 flex items-center gap-1 shrink-0">
        <ToolbarButton
          icon={<Pencil className="w-3.5 h-3.5" />}
          label="Edit Purpose"
          onClick={onEditClick}
        />
        <ToolbarButton
          icon={<Bell className="w-3.5 h-3.5" />}
          label="Remind"
          onClick={onRemindClick}
          disabled={!canRemind}
          disabledTitle={remindDisabledTitle}
        />
        <ToolbarButton
          icon={<Trash2 className="w-3.5 h-3.5" />}
          label="Delete"
          onClick={onDeleteClick}
          danger
        />
      </div>
    </>
  );
}

function ToolbarButton({
  icon,
  label,
  onClick,
  disabled,
  disabledTitle,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  disabledTitle?: string;
  danger?: boolean;
}) {
  const base =
    "flex items-center gap-1 h-7 px-2.5 rounded-full text-[11.5px] font-medium transition-colors shrink-0 whitespace-nowrap";
  const enabled = danger
    ? "text-[var(--color-error)] hover:bg-[color-mix(in_srgb,var(--color-error)_12%,transparent)]"
    : "text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]";
  const disabledCls =
    "text-[var(--color-text-muted)] opacity-50 cursor-not-allowed";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? disabledTitle : label}
      className={`${base} ${disabled ? disabledCls : enabled}`}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

function EditEdgeForm({
  purpose,
  onPurposeChange,
  onSubmit,
  onCancel,
}: {
  purpose: string;
  onPurposeChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="flex flex-col gap-2"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          onSubmit();
        }
      }}
    >
      <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
        <Pencil className="w-3.5 h-3.5 shrink-0" />
        <span>Edit connection purpose</span>
      </div>
      <textarea
        autoFocus
        value={purpose}
        onChange={(e) => onPurposeChange(e.target.value)}
        placeholder="Why does this connection exist?"
        rows={2}
        className="px-3 py-2 text-[12.5px] leading-snug rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)] resize-none min-h-[48px]"
      />
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-[var(--color-text-muted)]">
          ⌘/Ctrl + Enter to save · Esc to cancel
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onCancel}
            className="h-7 px-3 text-[11.5px] rounded-full text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            className="h-7 px-3 text-[11.5px] font-medium rounded-full bg-[var(--color-highlight)] text-white hover:opacity-90 transition-opacity"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Inline confirm-delete row. Replaces window.confirm so the confirmation lives
 * in the same toolbar surface and matches the app's visual language.
 */
function ConfirmDeleteRow({
  label,
  onConfirm,
  onCancel,
}: {
  label: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <div className="flex items-center gap-2 min-w-0 text-[12px] text-[var(--color-text)] pr-2">
        <Trash2 className="w-3.5 h-3.5 shrink-0 text-[var(--color-error)]" />
        <span className="truncate">{label}</span>
      </div>
      <button
        type="button"
        onClick={onCancel}
        autoFocus
        className="h-7 px-3 text-[11.5px] font-medium rounded-full border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors shrink-0 whitespace-nowrap"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={onConfirm}
        className="h-7 px-3 text-[11.5px] font-medium rounded-full bg-[var(--color-error)] text-white hover:opacity-90 transition-opacity shrink-0 whitespace-nowrap"
      >
        Confirm Delete
      </button>
    </>
  );
}
