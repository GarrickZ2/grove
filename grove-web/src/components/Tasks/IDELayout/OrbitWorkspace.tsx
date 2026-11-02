import { useEffect, useRef, useState, type CSSProperties, type ElementType, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "framer-motion";
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
}

export function OrbitWorkspaceBar({ title, branch, state, leading, groups, trailing }: OrbitWorkspaceBarProps) {
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
    <div className="ows-bar orbit-ui">
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
                    className={`ows-tb${item.active ? " is-on" : ""}`}
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
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
      {trailing ? <div className="ows-bar-trailing">{trailing}</div> : null}
      {tip && createPortal(
        <div className="ows-tip" role="tooltip" style={{ left: tip.left, top: tip.top }}>
          {tip.item.label}{tip.item.shortcut ? <kbd>{tip.item.shortcut}</kbd> : null}
        </div>,
        document.body,
      )}
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
