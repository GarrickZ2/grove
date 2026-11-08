import { useEffect, useRef, useState, type CSSProperties, type ElementType, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "framer-motion";
import { Menu } from "lucide-react";
import { PanelMenuButton, type PanelMenuItem } from "../../../orbit/ui";
import "./orbit-workspace.css";

/* Orbit desktop workspace chrome: the window-header toolbar and the docks
   that grow from 0 when a panel opens. */

export interface OrbitToolItem {
  key: string;
  label: string;
  icon: ElementType;
  /** Display string of the panel's shortcut. */
  shortcut?: string;
  active: boolean;
  disabled?: boolean;
  onToggle: () => void;
  /** The Agent: a labelled pill, accent-tinted when shown, first in the strip. */
  primary?: boolean;
  /** Tooltip text when it differs from `label`. */
  tip?: string;
}

interface OrbitWorkspaceBarProps {
  title: string;
  branch?: string;
  /** `working`: the agent is busy; `archived`: read-only task. */
  state?: "working" | "archived";
  leading?: ReactNode;
  /** Tool groups, separated by a hairline. */
  groups: OrbitToolItem[][];
  trailing?: ReactNode;
  /** Workspace-level actions (layout, sizes, git overflow) under the toolbar's ⋯. */
  menu?: PanelMenuItem[];
  /** Book fold: the right screen's width, which the tools keep to, clear of the crease. */
  foldRight?: number;
}

export function OrbitWorkspaceBar({ title, branch, state, leading, groups, trailing, menu, foldRight }: OrbitWorkspaceBarProps) {
  const [tip, setTip] = useState<{ item: OrbitToolItem; left: number; top: number } | null>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(tipTimer.current), []);
  const showTip = (item: OrbitToolItem, el: HTMLElement) => {
    clearTimeout(tipTimer.current);
    const r = el.getBoundingClientRect();
    tipTimer.current = setTimeout(() => setTip({ item, left: r.left + r.width / 2, top: r.bottom + 8 }), 400);
  };
  const hideTip = () => { clearTimeout(tipTimer.current); setTip(null); };
  const visibleGroups = groups.filter((g) => g.length > 0);

  return (
    <div className={`ows-bar orbit-ui${foldRight ? " is-fold" : ""}`} style={foldRight ? ({ "--fold-right": `${foldRight}px` } as React.CSSProperties) : undefined}>
      {leading ? <div className="ows-bar-leading">{leading}</div> : null}
      <h1 className="ows-bar-title" title={branch ? `${title} · ${branch}` : title}>
        <span className="ows-bar-name">{title}</span>
        {branch ? <small className="ows-bar-branch">{branch}</small> : null}
      </h1>
      {state === "working" ? (
        <span className="ows-state is-working"><i aria-hidden="true" />Working</span>
      ) : state === "archived" ? (
        <span className="ows-state is-archived">Archived</span>
      ) : null}
      <span className="ows-bar-spacer" />
      {visibleGroups.length > 0 ? (
        <div className="ows-tools" role="toolbar" aria-label="Panels">
          {visibleGroups.map((group, gi) => (
            <div key={gi} className="ows-tools-group">
              {gi > 0 ? <span className="ows-tsep" aria-hidden="true" /> : null}
              {group.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.key}
                    type="button"
                    className={`ows-tb${item.active ? " is-on" : ""}${item.primary ? " is-primary" : ""}`}
                    aria-pressed={item.active}
                    aria-label={item.label} data-orbit-tool={item.key}
                    disabled={item.disabled}
                    onClick={() => { hideTip(); item.onToggle(); }}
                    onMouseEnter={(e) => showTip(item, e.currentTarget)}
                    onMouseLeave={hideTip}
                    onFocus={(e) => showTip(item, e.currentTarget)}
                    onBlur={hideTip}
                  >
                    <Icon className="ows-tb-icon" size={15} />
                    {item.primary ? <span className="ows-tb-label">{item.label}</span> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
      {trailing || menu?.length ? (
        <div className="ows-bar-trailing">
          {trailing}
          {menu?.length ? <PanelMenuButton items={menu} label="Workspace actions" /> : null}
        </div>
      ) : null}
      {tip && createPortal(
        <div className="ows-tip" role="tooltip" style={{ left: tip.left, top: tip.top }}>
          {tip.item.tip ?? tip.item.label}{tip.item.shortcut ? <kbd>{tip.item.shortcut}</kbd> : null}
        </div>,
        document.body,
      )}
    </div>
  );
}

interface OrbitFoldDeckProps {
  title: string;
  branch?: string;
  state?: "working" | "archived";
  tools: OrbitToolItem[];
  /** Commit and Merge show as buttons; the rest stay under ⋯. */
  menu: PanelMenuItem[];
  onOpenSidebar: () => void;
}

const DECK_BUTTONS = new Set(["commit", "merge"]);

/** Laptop fold: the lower screen's controls above the Composer — the task and
    its main actions, then every panel as a labelled tile. */
export function OrbitFoldDeck({ title, branch, state, tools, menu, onOpenSidebar }: OrbitFoldDeckProps) {
  const ref = useRef<HTMLDivElement>(null);
  // The Composer starts where the deck ends.
  useEffect(() => {
    const el = ref.current;
    const host = el?.parentElement;
    if (!el || !host) return;
    const sync = () => host.style.setProperty("--fold-deck", `${el.offsetHeight}px`);
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => { ro.disconnect(); host.style.removeProperty("--fold-deck"); };
  }, []);
  const buttons = menu.filter((item) => DECK_BUTTONS.has(item.id));
  const rest = menu.filter((item) => !DECK_BUTTONS.has(item.id)).map((item, i) => (i === 0 ? { ...item, separator: false } : item));

  return (
    <div ref={ref} className="ows-deck orbit-ui">
      <div className="ows-deck-head">
        <button type="button" className="ows-deck-icon" aria-label="Open sidebar" onClick={onOpenSidebar}>
          <Menu size={20} strokeWidth={1.8} />
        </button>
        <div className="ows-deck-title" title={branch ? `${title} · ${branch}` : title}>
          <span>{title}</span>
          {branch ? <small>{branch}</small> : null}
        </div>
        {state === "working" ? <span className="ows-state is-working"><i aria-hidden="true" />Working</span> : null}
        {buttons.map((item) => {
          const Icon = item.icon;
          return (
            <button key={item.id} type="button" className="ows-deck-action" disabled={item.disabled} onClick={item.onSelect}>
              {Icon ? <Icon size={15} strokeWidth={1.8} /> : null}
              {item.label}
            </button>
          );
        })}
        {rest.length ? <PanelMenuButton items={rest} label="Workspace actions" /> : null}
      </div>
      <div className="ows-deck-grid" role="toolbar" aria-label="Panels">
        {tools.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.key}
              type="button"
              className={`ows-deck-tile${item.active ? " is-on" : ""}`}
              aria-pressed={item.active}
              aria-label={item.label}
              data-orbit-tool={item.key}
              disabled={item.disabled}
              onClick={item.onToggle}
            >
              <Icon className="ows-deck-tile-icon" size={20} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface OrbitDockProps {
  open: boolean;
  axis: "x" | "y";
  /** Open size in px. */
  size: number;
  /** A drag is resizing it: follow the pointer, no spring. */
  resizing?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

/**
 * A dock that grows from 0 to `size` with a spring when it opens. The content
 * keeps its full size while the clip animates, so terminals and editors never
 * reflow through tiny sizes. Closed docks stay mounted (keep-alive) but inert.
 */
export function OrbitDock({ open, axis, size, resizing = false, className, style, children }: OrbitDockProps) {
  const reduced = useReducedMotion();
  const prop = axis === "x" ? "width" : "height";
  const transition = reduced || resizing
    ? { duration: 0 }
    : { type: "spring" as const, duration: 0.46, bounce: 0.16 };
  return (
    <motion.div
      className={`ows-dock is-${axis}${open ? " is-open" : ""}${className ? ` ${className}` : ""}`}
      style={style}
      initial={false}
      animate={{ [prop]: open ? size : 0 }}
      transition={transition}
    >
      <div className="ows-dock-inner" style={{ [prop]: size }} aria-hidden={!open} inert={!open}>{children}</div>
    </motion.div>
  );
}

interface OrbitGripProps {
  /** `x` resizes a width (vertical hairline), `y` a height. */
  axis: "x" | "y";
  label: string;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onDoubleClick?: () => void;
}

/** Resize handle sitting on the hairline between two docks. */
export function OrbitGrip({ axis, label, onPointerDown, onDoubleClick }: OrbitGripProps) {
  return (
    <div className={`ows-grip-host is-${axis}`}>
      <div
        className={`ows-grip is-${axis}`}
        role="separator"
        aria-orientation={axis === "y" ? "horizontal" : "vertical"}
        aria-label={label}
        title={onDoubleClick ? `${label} (double-click to reset)` : label}
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
      />
    </div>
  );
}
