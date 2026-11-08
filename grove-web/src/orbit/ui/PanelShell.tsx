import {
  Component,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ElementType,
  type ErrorInfo,
  type MouseEvent as ReactMouseEvent,
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
 * The shell owns the panel's chrome: a 40px header with the coloured glyph
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
 *   <PanelHeaderLeading>…</PanelHeaderLeading>
 *       A control that belongs with the title, right after it (the Project a
 *       panel is showing). At most one, 180px wide.
 *
 *   <PanelHeaderActions><Button variant="ghost" size="sm" iconOnly …/></PanelHeaderActions>
 *       Extra header buttons, placed before ⋯. Keep them to one or two
 *       28px ghost icon buttons (`Button size="sm" variant="ghost" iconOnly`).
 *
 *   usePanelMenuItems(items)
 *       The panel's ⋯ menu rows. The ⋯ only appears when a body registers
 *       rows (workspace-level actions live in the toolbar's ⋯). `items`
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

/** A control beside the title. */
export function PanelHeaderLeading({ children }: { children: ReactNode }) {
  const slots = useContext(PanelSlotsContext);
  return slots?.leading ? createPortal(children, slots.leading) : null;
}

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
  onClose?: () => void;
  /** `scroll`: 12px padded, scrolls if the body doesn't (default). `fill`: edge to edge, no scroll. */
  body?: "scroll" | "fill";
  /**
   * Free layout: the tab strip already shows the glyph and title, so the
   * shell draws no header and puts the panel's own actions (body actions +
   * ⋯) into this element in the tab strip instead. Close is the tab's ×.
   */
  actionsTarget?: HTMLElement | null;
  /** Set with `actionsTarget`: render without a header. */
  headless?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

export function PanelShell({ glyph: Glyph, hue, title, context, onClose, body = "scroll", actionsTarget, headless = false, className, style, children }: PanelShellProps) {
  const [leading, setLeading] = useState<HTMLElement | null>(null);
  const [actions, setActions] = useState<HTMLElement | null>(null);
  const [contextSlot, setContextSlot] = useState<HTMLElement | null>(null);
  const [bodyMenu, setBodyMenuState] = useState<PanelMenuItem[]>([]);
  const setBodyMenu = useCallback((items: PanelMenuItem[]) => setBodyMenuState(items), []);
  const slots = useMemo<PanelSlots>(() => ({ leading, actions, context: contextSlot, setBodyMenu }), [leading, actions, contextSlot, setBodyMenu]);
  const tileStyle = { "--oui-panel-a": hue.from, "--oui-panel-b": hue.to } as CSSProperties;
  // A panel's ⋯ holds only its own rows; with none, there is no ⋯.
  // In a tab strip the menu is portaled so the strip's overflow can't clip it.
  const menuButton = bodyMenu.length > 0 ? <PanelMenuButton items={bodyMenu} label="Panel actions" portal={headless} /> : null;

  return (
    <section className={`oui-panel orbit-ui${headless ? " is-headless" : ""}${className ? ` ${className}` : ""}`} style={style}>
      {headless ? (
        <>
          {/* Context has no place in the tab strip; the slot stays so PanelHeaderContext is harmless. */}
          <small ref={setContextSlot} hidden />
          {actionsTarget && createPortal(
            <span className="oui-panel-inline orbit-ui">
              <span ref={setLeading} className="oui-panel-leading" />
              <span ref={setActions} className="oui-panel-actions" />
              {menuButton}
            </span>,
            actionsTarget,
          )}
        </>
      ) : (
        <header className="oui-panel-head">
          <span className="oui-panel-tile" style={tileStyle} aria-hidden="true"><Glyph className="oui-panel-glyph" size={12} /></span>
          <h2 className="oui-panel-title">
            <span className="oui-panel-name">{title}</span>
            <span ref={setLeading} className="oui-panel-leading" />
            {context ? <small className="oui-panel-ctx-default" title={typeof context === "string" ? context : undefined}>{context}</small> : null}
            <small ref={setContextSlot} className="oui-panel-ctx-slot" />
          </h2>
          <span ref={setActions} className="oui-panel-actions" />
          {menuButton}
          {onClose ? (
            <button type="button" className="oui-panel-ib" aria-label="Close panel" title="Close panel" onClick={onClose}>
              <X aria-hidden="true" />
            </button>
          ) : null}
        </header>
      )}
      <PanelSlotsContext.Provider value={slots}>
        <div className={`oui-panel-body is-${body}`}>
          <PanelErrorBoundary>{children}</PanelErrorBoundary>
        </div>
      </PanelSlotsContext.Provider>
    </section>
  );
}

/** ⋯ button with a compact menu (icon, label, shortcut). Also used by the
 *  workspace toolbar. `portal`: render the menu fixed on document.body, for
 *  hosts that clip overflow (FlexLayout's tab strip). */
export function PanelMenuButton({ items, label, portal = false }: { items: PanelMenuItem[]; label: string; portal?: boolean }) {
  const { open, close, toggle, rootRef } = usePopover();
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open, close]);
  const onToggle = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const r = event.currentTarget.getBoundingClientRect();
    setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    toggle();
  };
  const menu = (fixed: boolean) => (
    <div
      className={`oui-pop oui-panel-menu${fixed ? " orbit-ui" : ""}`}
      role="menu"
      aria-label={label}
      style={fixed && pos ? { position: "fixed", top: pos.top, right: pos.right } : undefined}
      // Keeps usePopover's outside-pointer close from firing on the portaled menu.
      onPointerDown={(e) => e.stopPropagation()}
    >
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <Fragment key={item.id}>
            {item.separator ? <span className="oui-panel-menu-sep" role="separator" /> : null}
            <button
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
          </Fragment>
        );
      })}
    </div>
  );
  return (
    <span ref={rootRef} className="oui-pop-anchor">
      <button type="button" className={`oui-panel-ib${open ? " is-open" : ""}`} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={onToggle}>
        <MoreHorizontal aria-hidden="true" />
      </button>
      {open ? (portal && pos ? createPortal(menu(true), document.body) : menu(false)) : null}
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
