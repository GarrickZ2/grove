import { memo, type DragEventHandler, type PointerEventHandler, type ReactNode, type Ref } from "react";
import { ArrowUp, BookOpen, Check, ChevronsUp, Database, ExternalLink, KeyRound, ListChecks, Loader2, MessageSquarePlus, ShieldCheck, Square, X } from "lucide-react";
import { useEscapeScope } from "../../../../keyboard/useEscapeScope";
import { SubagentAvatar } from "../SubagentAvatar";
import type { PlanEntry } from "../planEntries";
import { currentPlanStep, hasComposerStatus, type AskKind, type ComposerStatus, type OrbAction, type OrbitTray } from "./composerStatus";
import "./orbit-composer.css";

interface OrbitComposerProps {
  shellRef?: Ref<HTMLDivElement>;
  /** Extra classes on the shell (keeps `chatbox-bubble` for measuring / hand-off). */
  className?: string;
  running: boolean;
  /** Phone: touch sizes, 16px input, one scrolling status row. */
  phone?: boolean;
  dragging?: boolean;
  onDragOver?: DragEventHandler<HTMLDivElement>;
  onDragLeave?: DragEventHandler<HTMLDivElement>;
  onDrop?: DragEventHandler<HTMLDivElement>;
  /** Top status zone; omitted on the New page (no session yet). */
  statusBar?: ReactNode;
  /** The open tray's body, rising out of the composer. */
  tray?: ReactNode;
  /** A docked agent request (permission, survey, sign-in). */
  ask?: ReactNode;
  /** Attachments, the input itself and anything inline with it. */
  children: ReactNode;
  tools?: ReactNode;
  /** Shown only while typing. */
  hint?: string | null;
  setup?: ReactNode;
  usage?: ReactNode;
  orb: ReactNode;
}

/**
 * Orbit composer frame: status zone and trays on top, input in the middle,
 * input tools bottom-left and "who and how" bottom-right. Pure layout — the
 * live pieces it's given (status bar, setup chip, usage ring, orb) are
 * memoized on their own so a streamed chunk re-renders none of them.
 */
export function OrbitComposer({ shellRef, className = "", running, phone = false, dragging = false, onDragOver, onDragLeave, onDrop, statusBar, tray, ask, children, tools, hint, setup, usage, orb }: OrbitComposerProps) {
  return (
    <div
      ref={shellRef}
      className={`oc-shell${running ? " is-running" : ""}${phone ? " is-phone" : ""}${dragging ? " chatbox-drop-active" : ""} ${className}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Running light: a sharp arc, and a blurred copy of it as its bloom. */}
      {running && <span className="oc-orbit is-bloom" aria-hidden="true"><i /></span>}
      {running && <span className="oc-orbit" aria-hidden="true"><i /></span>}
      {statusBar}
      {tray && <div className="oc-tray">{tray}</div>}
      {ask && <div className="oc-ask">{ask}</div>}
      <div className="oc-body">{children}</div>
      <div className="oc-bar">
        <div className="oc-tools">
          {tools}
          {hint && <span className="oc-hint" aria-live="polite">{hint}</span>}
        </div>
        <div className="oc-who">
          {setup}
          {usage}
          {orb}
        </div>
      </div>
    </div>
  );
}

const ASK_LABEL: Record<AskKind, { label: string; Icon: typeof ShieldCheck }> = {
  auth: { label: "Sign in required", Icon: KeyRound },
  permission: { label: "Permission request", Icon: ShieldCheck },
  survey: { label: "Survey", Icon: ListChecks },
  external: { label: "External request", Icon: ExternalLink },
};

interface OrbitStatusBarProps {
  status: ComposerStatus | null;
  activeTray: OrbitTray | null;
  onTrayChange: (tray: OrbitTray | null) => void;
}

/** Zone 1: what the session is doing. Renders nothing when there's nothing to show. */
export const OrbitStatusBar = memo(function OrbitStatusBar({ status, activeTray, onTrayChange }: OrbitStatusBarProps) {
  // One tray at a time; Escape closes it (a docked request stays — it needs an answer).
  useEscapeScope(!!activeTray && activeTray !== "ask", () => onTrayChange(null));
  if (!hasComposerStatus(status)) return null;
  const toggle = (tray: OrbitTray) => onTrayChange(activeTray === tray ? null : tray);
  const chip = (tray: OrbitTray) => `oc-chip${activeTray === tray ? " is-on" : ""}`;
  const { plan, subagents, queue, memory, comments, ask } = status;
  return (
    <div className="oc-status" role="toolbar" aria-label="Session status">
      {plan?.kind === "steps" && (
        <button type="button" className={`${chip("plan")} is-plan${plan.live ? " is-live" : ""}`} aria-expanded={activeTray === "plan"} onClick={() => toggle("plan")} title={plan.label} aria-label={`Plan: ${plan.label}, ${plan.done} of ${plan.total} done`}>
          {plan.live && <i className="oc-live" aria-hidden="true" />}
          <span className="oc-chip-label">{plan.label}</span>
          <span className="oc-mini" aria-hidden="true"><i style={{ width: `${plan.total ? (plan.done / plan.total) * 100 : 0}%` }} /></span>
          <b>{plan.done}/{plan.total}</b>
        </button>
      )}
      {plan?.kind === "doc" && (
        <button type="button" className={`${chip("plan")} is-plan${plan.live ? " is-live" : ""}`} aria-expanded={activeTray === "plan"} onClick={() => toggle("plan")} title={plan.label}>
          {plan.live ? <i className="oc-live" aria-hidden="true" /> : <BookOpen size={12} aria-hidden="true" />}
          <span className="oc-chip-label">{plan.label}</span>
        </button>
      )}
      {plan?.kind === "working" && <WorkingChip />}
      {subagents && (
        <button type="button" className={chip("subagents")} aria-expanded={activeTray === "subagents"} onClick={() => toggle("subagents")} aria-label={`Subagents · ${subagents.count}${subagents.running ? `, ${subagents.running} running` : ""}`}>
          <span className="oc-stack" aria-hidden="true">{subagents.avatars.map((id) => <SubagentAvatar key={id} sessionId={id} size={15} />)}</span>
          Subagents<b>{subagents.count}</b>
        </button>
      )}
      {queue && (
        <button type="button" className={`${chip("queue")}${queue.failed ? " is-error" : ""}`} aria-expanded={activeTray === "queue"} onClick={() => toggle("queue")} aria-label={`Queue · ${queue.count} pending${queue.failed ? `, ${queue.failed} failed to send` : ""}`}>
          <i className="oc-dot" aria-hidden="true" />Queue<b>{queue.count}</b>
        </button>
      )}
      {ask && activeTray !== "ask" && (() => {
        const { label, Icon } = ASK_LABEL[ask];
        return <button type="button" className="oc-chip is-ask" onClick={() => onTrayChange("ask")}><Icon size={12} aria-hidden="true" />{label}</button>;
      })()}
      <span className="oc-spacer" />
      {memory !== null && (
        <button type="button" className={chip("memory")} aria-expanded={activeTray === "memory"} onClick={() => toggle("memory")} title="Memory read by the agent in this turn">
          <Database size={12} aria-hidden="true" />Memory<b>{memory}</b>
        </button>
      )}
      {comments !== null && (
        <button type="button" className={chip("comments")} aria-expanded={activeTray === "comments"} onClick={() => toggle("comments")}>
          <MessageSquarePlus size={12} aria-hidden="true" />Comments<b>{comments}</b>
        </button>
      )}
    </div>
  );
});

/** "Working" while a turn runs without a plan. Elapsed time is shown by the
 * transcript's live work group. */
function WorkingChip() {
  return (
    <span className="oc-chip is-plan is-live is-static" role="status">
      <i className="oc-live" aria-hidden="true" />
      Working
    </span>
  );
}

/** Plan tray body: the steps (done, current pulsing, pending). */
export function OrbitPlanSteps({ entries }: { entries: readonly PlanEntry[] }) {
  const current = currentPlanStep(entries.filter((entry) => !/fail|error|cancel/i.test(entry.status)));
  return (
    <ol className="oc-steps">
      {entries.map((entry, index) => {
        const state = entry.status === "completed" ? "done" : /fail|error|cancel/i.test(entry.status) ? "failed" : entry === current ? "cur" : "todo";
        return (
          <li key={`${entry.priority ?? "legacy"}:${entry.content}:${index}`} className={`oc-step is-${state}`} aria-current={state === "cur" ? "step" : undefined}>
            <span className="oc-step-ck" aria-hidden="true" />
            <span>{entry.content}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Tray heading row. */
export function OrbitTrayHead({ title, detail, children, onClose }: { title: string; detail?: string; children?: ReactNode; onClose?: () => void }) {
  return (
    <div className="oc-tray-head">
      <b>{title}</b>
      {detail && <span>· {detail}</span>}
      <span className="oc-spacer" />
      {children}
      {onClose
        ? <button type="button" className="oc-icon-btn" onClick={onClose} title="Close (Esc)" aria-label={`Close ${title.toLowerCase()}`}><X /></button>
        : <span className="oc-tray-esc">Esc to close</span>}
    </div>
  );
}

const ORB_LABEL: Record<OrbAction, string> = {
  save: "Save pending message",
  send: "Send",
  queue: "Queue message — sends when this turn ends",
  stop: "Stop",
  sendNow: "Send the next queued message now (stops this turn)",
  idle: "Send",
};

interface OrbitSendOrbProps {
  action: OrbAction;
  disabled: boolean;
  /** Spinner instead of the icon (stopping, saving, creating the session). */
  busy?: boolean;
  onSend: () => void;
  onStop?: () => void;
  onSendNow?: () => void;
  onPointerDown?: PointerEventHandler<HTMLButtonElement>;
  /** Title for the send action (e.g. a shortcut hint). */
  sendTitle?: string;
}

/** The one send / stop button. The arrow morphs into a square while the agent can be stopped. */
export const OrbitSendOrb = memo(function OrbitSendOrb({ action, disabled, busy = false, onSend, onStop, onSendNow, onPointerDown, sendTitle }: OrbitSendOrbProps) {
  const icon = busy ? "spin" : action === "stop" ? "stop" : action === "save" ? "check" : action === "sendNow" ? "skip" : "arrow";
  const onClick = action === "stop" ? onStop : action === "sendNow" ? onSendNow : onSend;
  const sendsText = action === "send" || action === "queue" || action === "save";
  const label = ORB_LABEL[action];
  return (
    <button
      type="button"
      className={`oc-orb is-${action}`}
      data-icon={icon}
      disabled={disabled || action === "idle"}
      onPointerDown={sendsText ? onPointerDown : undefined}
      onClick={onClick}
      aria-label={label}
      title={action === "send" && sendTitle ? sendTitle : label}
    >
      <span className="oc-orb-ic is-arrow"><ArrowUp /></span>
      <span className="oc-orb-ic is-stop"><Square /></span>
      <span className="oc-orb-ic is-check"><Check /></span>
      <span className="oc-orb-ic is-skip"><ChevronsUp /></span>
      <span className="oc-orb-ic is-spin"><Loader2 /></span>
    </button>
  );
});
