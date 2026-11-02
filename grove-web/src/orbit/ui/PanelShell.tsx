import {
  Component,
  useCallback,
  useContext,
  useMemo,
  useState,
  type CSSProperties,
  type ElementType,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, MoreHorizontal, RotateCw, X, type LucideIcon } from "lucide-react";
import { usePopover } from "./usePopover";
import { PanelSlotsContext, type PanelHue, type PanelMenuItem, type PanelSlots } from "./panelSlots";
import "./panel-shell.css";

/*
 * PanelShell — the one frame every Orbit workspace panel sits in.
 *
 * The shell owns the panel's chrome: a 48px header with the coloured glyph
 * tile, the title, a muted context line, the ⋯ menu and close. It also owns
 * the body container (padded + scrolling, or edge-to-edge) and catches render
 * errors with a retry. The workspace (IDE layout / FlexLayout) renders it via
 * `renderOrbitPanel` in `components/Tasks/PanelSystem/panelRegistry.tsx`;
 * a panel's static meta (hue, glyph, default context, body mode) lives on its
 * registry entry as `orbit: OrbitPanelMeta`.
 *
 * ── Contract for panel bodies (Info, Git, Notes, Comments, Artifacts, Graph…)
 *
 * In Orbit a body renders CONTENT ONLY: no outer border/card, no title row,
 * no close button, no outer padding. A `scroll` body (Info, Git, Notes,
 * Comments) sits in a 12px-padded box whose height is bounded: scroll inside
 * yourself (h-full + overflow-auto) or let the shell scroll you. A `fill`
 * body (Graph, Artifacts, Editor, Review, Sketch, plugins) is edge to edge
 * and does not scroll — manage your own overflow.
 *
 * A body can add to the header, from anywhere inside it:
 *
 *   <PanelHeaderContext>3 agents</PanelHeaderContext>
 *       Replaces the registry's default context text (muted, after the title).
 *
 *   <PanelHeaderActions><Button variant="ghost" size="sm" iconOnly …/></PanelHeaderActions>
 *       Extra header buttons, placed before ⋯. Keep them to one or two
 *       28px ghost icon buttons (`Button size="sm" variant="ghost" iconOnly`).
 *
 *   usePanelMenuItems(items)
 *       Adds rows to the ⋯ menu, above the workspace's own rows. `items`
 *       must be memoized (useMemo) — a new array every render re-registers.
 *
 *   useInPanelShell()
 *       True when rendered inside a PanelShell (all three above are no-ops
 *       outside one, e.g. in Workbench).
 *
 * Content states, so every panel reads the same:
 *   <PanelEmpty icon title action>why this panel exists</PanelEmpty>
 *   <PanelLoading />                       skeleton boxes
 *   <PanelError title onRetry actions>the cause, in a sentence</PanelError>
 */

/** Extra header buttons from the body, placed before ⋯. */
export function PanelHeaderActions({ children }: { children: ReactNode }) {
  const slots = useContext(PanelSlotsContext);
  return slots?.actions ? createPortal(children, slots.actions) : null;
}

/** Replaces the header's default context text. */
export function PanelHeaderContext({ children }: { children: ReactNode }) {
  const slots = useContext(PanelSlotsContext);
  return slots?.context ? createPortal(children, slots.context) : null;
}

export interface PanelShellProps {
  /** Tile glyph: a lucide icon, or any component taking `className` + `size`. */
  glyph: ElementType;
  hue: PanelHue;
  title: ReactNode;
  /** Muted text after the title (a body can replace it with PanelHeaderContext). */
  context?: ReactNode;
  /** The workspace's own ⋯ rows (listed after the body's). */
  menu?: PanelMenuItem[];
  onClose?: () => void;
  /** `scroll`: 12px padded, scrolls if the body doesn't (default). `fill`: edge to edge, no scroll. */
  body?: "scroll" | "fill";
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

export function PanelShell({ glyph: Glyph, hue, title, context, menu, onClose, body = "scroll", className, style, children }: PanelShellProps) {
  const [actions, setActions] = useState<HTMLElement | null>(null);
  const [contextSlot, setContextSlot] = useState<HTMLElement | null>(null);
  const [bodyMenu, setBodyMenuState] = useState<PanelMenuItem[]>([]);
  const setBodyMenu = useCallback((items: PanelMenuItem[]) => setBodyMenuState(items), []);
  const slots = useMemo<PanelSlots>(() => ({ actions, context: contextSlot, setBodyMenu }), [actions, contextSlot, setBodyMenu]);
  const menuItems = useMemo(() => [...bodyMenu, ...(menu ?? [])], [bodyMenu, menu]);
  const tileStyle = { "--oui-panel-a": hue.from, "--oui-panel-b": hue.to } as CSSProperties;

  return (
    <section className={`oui-panel orbit-ui${className ? ` ${className}` : ""}`} style={style}>
      <header className="oui-panel-head">
        <span className="oui-panel-tile" style={tileStyle} aria-hidden="true"><Glyph className="oui-panel-glyph" size={14} /></span>
        <h2 className="oui-panel-title">
          <span className="oui-panel-name">{title}</span>
          {context ? <small className="oui-panel-ctx-default">{context}</small> : null}
          <small ref={setContextSlot} className="oui-panel-ctx-slot" />
        </h2>
        <span ref={setActions} className="oui-panel-actions" />
        {menuItems.length > 0 ? <PanelMenuButton items={menuItems} label="Panel actions" /> : null}
        {onClose ? (
          <button type="button" className="oui-panel-ib" aria-label="Close panel" title="Close panel" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        ) : null}
      </header>
      <PanelSlotsContext.Provider value={slots}>
        <div className={`oui-panel-body is-${body}`}>
          <PanelErrorBoundary>{children}</PanelErrorBoundary>
        </div>
      </PanelSlotsContext.Provider>
    </section>
  );
}

/** ⋯ button with a compact menu (icon, label, shortcut). Also used by the workspace toolbar. */
export function PanelMenuButton({ items, label }: { items: PanelMenuItem[]; label: string }) {
  const { open, close, toggle, rootRef } = usePopover();
  return (
    <span ref={rootRef} className="oui-pop-anchor">
      <button type="button" className={`oui-panel-ib${open ? " is-open" : ""}`} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        <MoreHorizontal aria-hidden="true" />
      </button>
      {open ? (
        <div className="oui-pop oui-panel-menu" role="menu" aria-label={label}>
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className={`oui-panel-menu-item${item.danger ? " is-danger" : ""}`}
                onClick={() => { close(); item.onSelect(); }}
              >
                {Icon ? <Icon aria-hidden="true" /> : <span className="oui-panel-menu-gap" />}
                <span className="oui-panel-menu-label">{item.label}</span>
                {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </span>
  );
}

/* ── Content states ─────────────────────────────────────────────────────── */

interface PanelEmptyProps {
  icon: LucideIcon | ElementType;
  title: ReactNode;
  /** What the panel is for, in a sentence. */
  children?: ReactNode;
  /** The first step (usually one primary Button). */
  action?: ReactNode;
}

/** Nothing here yet: says what the panel is for and offers the first step. */
export function PanelEmpty({ icon: Icon, title, children, action }: PanelEmptyProps) {
  return (
    <div className="oui-panel-empty">
      <span className="oui-panel-empty-ic" aria-hidden="true"><Icon /></span>
      <b>{title}</b>
      {children ? <span className="oui-panel-empty-body">{children}</span> : null}
      {action ? <div className="oui-panel-empty-acts">{action}</div> : null}
    </div>
  );
}

/** Skeleton boxes while the body's first load is in flight. */
export function PanelLoading({ boxes = 2, label = "Loading" }: { boxes?: number; label?: string }) {
  const widths = [["60%", "40%", "80%"], ["90%", "70%", "82%"], ["72%", "54%", "64%"]];
  return (
    <div className="oui-panel-loading" role="status" aria-label={label}>
      {Array.from({ length: boxes }, (_, i) => (
        <div key={i} className="oui-panel-skbox">
          {widths[i % widths.length].map((w, j) => (
            <span key={j} className={`oui-skel${i === 0 && j === 2 ? " is-tall" : ""}`} style={{ width: w }} />
          ))}
        </div>
      ))}
    </div>
  );
}

interface PanelErrorProps {
  /** What failed, e.g. "Couldn't read the worktree". */
  title: ReactNode;
  /** The cause, and what it means. */
  children?: ReactNode;
  onRetry?: () => void;
  /** The retry is in flight (spins the icon, disables the button). */
  retrying?: boolean;
  /** Other ways out, next to Try again. */
  actions?: ReactNode;
}

/** A failure that names the cause and offers a way out. */
export function PanelError({ title, children, onRetry, retrying = false, actions }: PanelErrorProps) {
  return (
    <div className="oui-panel-error" role="alert">
      <div className="oui-panel-error-card">
        <AlertTriangle aria-hidden="true" />
        <div>
          <b>{title}</b>
          {children ? <span>{children}</span> : null}
        </div>
      </div>
      {onRetry || actions ? (
        <div className="oui-panel-error-acts">
          {onRetry ? (
            <button type="button" className="oui-btn oui-btn-secondary oui-btn-sm" onClick={onRetry} disabled={retrying}>
              <RotateCw className={retrying ? "oui-spin" : undefined} aria-hidden="true" />
              Try again
            </button>
          ) : null}
          {actions}
        </div>
      ) : null}
    </div>
  );
}

interface BoundaryState {
  error: Error | null;
  attempt: number;
}

/** A body that throws shows PanelError; Try again remounts it. */
class PanelErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<BoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[PanelShell] panel body crashed", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <PanelError
          title="This panel stopped working"
          onRetry={() => this.setState((s) => ({ error: null, attempt: s.attempt + 1 }))}
        >
          {this.state.error.message || "It hit an unexpected error while rendering."}
        </PanelError>
      );
    }
    return <div key={this.state.attempt} className="oui-panel-content">{this.props.children}</div>;
  }
}
