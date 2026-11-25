import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ElementType, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "framer-motion";
import { ChevronDown, Menu } from "lucide-react";
import { PanelMenuButton, usePopover, type PanelMenuItem } from "../../../orbit/ui";
import { MORE, type PanelMove } from "../PanelSystem/panelOrder";
import { useToolDrag } from "./useToolDrag";
import "./orbit-workspace.css";

/* Orbit desktop workspace chrome: the window-header toolbar and the docks
   that grow from 0 when a panel opens. */

export interface OrbitToolItem {
  key: string;
  label: string;
  /** What the strip and the panel lists show, where it's shorter than `label`. */
  name?: string;
  icon: ElementType;
  /** Display string of the panel's shortcut. */
  shortcut?: string;
  active: boolean;
  disabled?: boolean;
  onToggle: () => void;
  /** The Agent: accent-tinted when shown, always first in the strip. */
  primary?: boolean;
  /** Tooltip text when it differs from `label`. */
  tip?: string;
}

interface OrbitWorkspaceBarProps {
  /** Left out while a new Session is being written: its composer names the task. */
  title?: string;
  branch?: string;
  /** `working`: the agent is busy; `archived`: read-only task. */
  state?: "working" | "archived";
  leading?: ReactNode;
  /** The strip's tool groups, separated by a hairline. */
  groups: OrbitToolItem[][];
  /** Panels under More, in groups. One that is open is on the strip too. */
  more?: OrbitToolItem[][];
  /** A panel was dragged to another place. */
  onMove?: (move: PanelMove) => void;
  trailing?: ReactNode;
  /** Workspace-level actions (layout, sizes, git overflow) under the toolbar's ⋯. */
  menu?: PanelMenuItem[];
  /** Book fold: the right screen's width, which the tools keep to, clear of the crease. */
  foldRight?: number;
  /** Bare icons on the page itself: no strip, dividers or header line. */
  quiet?: boolean;
}

/** Room kept for the task's name before panels move under More. */
const TITLE_RESERVE = 120;
const TOOLS_PADDING = 6;
const TOOL_GAP = 2;
const NO_GROUPS: OrbitToolItem[][] = [];
const NO_KEYS: ReadonlySet<string> = new Set();

function outerWidth(el: HTMLElement): number {
  const cs = getComputedStyle(el);
  return el.getBoundingClientRect().width + (parseFloat(cs.marginLeft) || 0) + (parseFloat(cs.marginRight) || 0);
}

/**
 * Which of the strip's panels don't fit beside the title and the trailing
 * actions and go under More. The last ones go first, those that aren't open
 * before those that are; the Agent always stays, and the panel just dropped
 * on the strip stays where it was put.
 */
function overflowingTools(
  groups: OrbitToolItem[][],
  room: number,
  widths: { of: (key: string) => number; more: number; separator: number },
  { more, keep }: { more: boolean; keep: string | null },
): ReadonlySet<string> {
  const needed = (hidden: ReadonlySet<string>) => {
    let total = TOOLS_PADDING + (more || hidden.size ? widths.more + widths.separator : 0);
    let shownGroups = 0;
    for (const group of groups) {
      const shown = group.filter((item) => !hidden.has(item.key));
      if (shown.length === 0) continue;
      if (shownGroups++ > 0) total += widths.separator;
      total += shown.reduce((sum, item) => sum + widths.of(item.key), 0) + TOOL_GAP * (shown.length - 1);
    }
    return total;
  };
  const order = groups.flat().filter((item) => !item.primary).reverse();
  const stays = (item: OrbitToolItem) => item.active || item.key === keep;
  const candidates = [...order.filter((item) => !stays(item)), ...order.filter(stays)];
  const hidden = new Set<string>();
  for (const item of candidates) {
    if (needed(hidden) <= room) break;
    hidden.add(item.key);
  }
  return hidden;
}

/** The panels that aren't on the strip. */
function MoreTools({ groups, open, target, onToggle, onClose, rootRef, dragging, itemProps }: {
  groups: OrbitToolItem[][];
  open: boolean;
  /** A dragged panel would go under More. */
  target: boolean;
  onToggle: () => void;
  onClose: () => void;
  rootRef: React.RefObject<HTMLSpanElement | null>;
  dragging: string | null;
  itemProps: (item: OrbitToolItem) => object;
}) {
  return (
    <span ref={rootRef} className="oui-pop-anchor">
      <button type="button" className={`ows-tb ows-more${open ? " is-open" : ""}${target ? " is-target" : ""}`} aria-haspopup="menu" aria-expanded={open} data-tool-more="" onClick={onToggle}>
        <span className="ows-tb-label">More</span>
        <ChevronDown className="ows-more-chevron" size={13} aria-hidden="true" />
      </button>
      {open && groups.length > 0 ? (
        <div className="oui-pop oui-panel-menu" role="menu" aria-label="More panels">
          {groups.map((group, gi) => (
            <div key={gi} role="none">
              {gi > 0 ? <span className="oui-panel-menu-sep" role="separator" /> : null}
              {group.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.key}
                    type="button"
                    role="menuitem"
                    aria-label={item.label}
                    className={`oui-panel-menu-item${dragging === item.key ? " is-dragged" : ""}`}
                    disabled={item.disabled}
                    onClick={() => { onClose(); item.onToggle(); }}
                    {...itemProps(item)}
                  >
                    <Icon size={14} aria-hidden="true" />
                    <span className="oui-panel-menu-label">{item.name ?? item.label}</span>
                    {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
    </span>
  );
}

export function OrbitWorkspaceBar({ title, branch, state, leading, groups, more: moreItems = NO_GROUPS, onMove, trailing, menu, foldRight, quiet }: OrbitWorkspaceBarProps) {
  const labels = !foldRight;
  const [tip, setTip] = useState<{ item: OrbitToolItem; left: number; top: number } | null>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(tipTimer.current), []);
  const showTip = (item: OrbitToolItem, el: HTMLElement) => {
    clearTimeout(tipTimer.current);
    // The strip already shows the name; a tip is for what it doesn't.
    if (labels && !item.tip && !item.shortcut) return;
    const r = el.getBoundingClientRect();
    tipTimer.current = setTimeout(() => setTip({ item, left: r.left + r.width / 2, top: r.bottom + 8 }), 400);
  };
  const hideTip = () => { clearTimeout(tipTimer.current); setTip(null); };
  // An open panel from More shows on the strip until it's closed. The book
  // fold's strip has no More: it scrolls.
  const pinned = new Set(groups.flat().map((item) => item.key));
  const visibleGroups = [...groups, moreItems.flat().filter((item) => item.active || !labels)].filter((g) => g.length > 0);

  // Panels that don't fit move under More. The book fold keeps its scrolling
  // strip of bare icons.
  const barRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const more = usePopover<HTMLSpanElement>();
  const [dropped, setDropped] = useState<string | null>(null);
  const drag = useToolDrag({
    onStart: hideTip,
    onOverMore: () => more.setOpen(true),
    onMove: (move, onStrip) => { setDropped(onStrip ? move.key : null); onMove?.(move); },
  });
  // While dragging there is always a More to drop on.
  const needsMore = labels && (!!drag.dragging || moreItems.flat().some((item) => !item.active));
  const [hiddenTools, setHiddenTools] = useState<ReadonlySet<string>>(NO_KEYS);
  const groupsRef = useRef(visibleGroups);
  useLayoutEffect(() => { groupsRef.current = visibleGroups; });
  const toolsSignature = visibleGroups.map((g) => g.map((i) => `${i.key}:${i.name ?? i.label}:${i.active ? 1 : 0}`).join(",")).join("|");
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar || foldRight) {
      setHiddenTools(NO_KEYS);
      return;
    }
    const fit = () => {
      const tools = bar.querySelector<HTMLElement>(":scope > .ows-tools");
      const measure = measureRef.current;
      if (!measure) return;
      const widths = new Map<string, number>();
      for (const el of Array.from(measure.children) as HTMLElement[]) widths.set(el.dataset.measure ?? "", el.offsetWidth);
      const cs = getComputedStyle(bar);
      const gap = parseFloat(cs.columnGap) || 0;
      let room = bar.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      let rendered = 0;
      for (const child of Array.from(bar.children) as HTMLElement[]) {
        if (child === measure || child.getClientRects().length === 0) continue;
        rendered++;
        if (child === tools) continue;
        if (child.classList.contains("ows-bar-spacer")) { room -= parseFloat(getComputedStyle(child).minWidth) || 0; continue; }
        if (child.classList.contains("ows-bar-title")) {
          const name = child.querySelector<HTMLElement>(".ows-bar-name");
          const wanted = Math.min((name?.scrollWidth ?? 0) + (child.querySelector(".ows-bar-branch") ? parseFloat(getComputedStyle(child).columnGap) || 0 : 0), TITLE_RESERVE);
          room -= Math.max(wanted, parseFloat(getComputedStyle(child).minWidth) || 0);
          continue;
        }
        room -= outerWidth(child);
      }
      room -= gap * Math.max(0, rendered - 1);
      const next = overflowingTools(groupsRef.current, room, {
        of: (key) => widths.get(key) ?? 0,
        more: widths.get(MORE) ?? 0,
        separator: quiet ? 11 : 7,
      }, { more: needsMore, keep: dropped });
      setHiddenTools((prev) => (prev.size === next.size && [...next].every((k) => prev.has(k)) ? prev : next));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(bar);
    // Names change width when their font arrives.
    if (measureRef.current) ro.observe(measureRef.current);
    for (const child of Array.from(bar.children)) {
      if (child !== measureRef.current && !child.classList.contains("ows-tools") && !child.classList.contains("ows-bar-spacer") && !child.classList.contains("ows-bar-title")) ro.observe(child);
    }
    return () => ro.disconnect();
  }, [foldRight, quiet, toolsSignature, needsMore, dropped, title, branch, state]);

  const shownGroups = visibleGroups.map((g) => g.filter((item) => !hiddenTools.has(item.key))).filter((g) => g.length > 0);
  // What the strip has no room for leads the menu.
  const moreGroups = labels
    ? [
      groups.flat().filter((item) => hiddenTools.has(item.key)),
      ...moreItems.map((g) => g.filter((item) => !item.active || hiddenTools.has(item.key))),
    ].filter((g) => g.length > 0)
    : NO_GROUPS;
  const dragProps = (item: OrbitToolItem) => (onMove && labels && !item.primary ? drag.itemProps(item.key, pinned.has(item.key)) : {});
  const draggedItem = drag.dragging ? [...groups, ...moreItems].flat().find((item) => item.key === drag.dragging?.key) : undefined;
  const DraggedIcon = draggedItem?.icon;

  return (
    <div ref={barRef} className={`ows-bar orbit-ui${foldRight ? " is-fold" : ""}${quiet ? " is-quiet" : ""}`} style={foldRight ? ({ "--fold-right": `${foldRight}px` } as React.CSSProperties) : undefined}>
      {leading ? <div className="ows-bar-leading">{leading}</div> : null}
      {title ? (
        <h1 className="ows-bar-title" title={branch ? `${title} · ${branch}` : title}>
          <span className="ows-bar-name">{title}</span>
          {branch ? <small className="ows-bar-branch">{branch}</small> : null}
        </h1>
      ) : null}
      {state === "working" ? (
        <span className="ows-state is-working"><i aria-hidden="true" />Working</span>
      ) : state === "archived" ? (
        <span className="ows-state is-archived">Archived</span>
      ) : null}
      <span className="ows-bar-spacer" />
      {shownGroups.length > 0 ? (
        <div className={`ows-tools${labels ? " has-names" : ""}`} role="toolbar" aria-label="Panels">
          {shownGroups.map((group, gi) => (
            <div key={gi} className="ows-tools-group">
              {gi > 0 ? <span className="ows-tsep" aria-hidden="true" /> : null}
              {group.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.key}
                    type="button"
                    className={`ows-tb${item.active ? " is-on" : ""}${item.primary ? " is-primary" : ""}${drag.dragging?.key === item.key ? " is-dragged" : ""}`}
                    aria-pressed={item.active}
                    aria-label={item.label} data-orbit-tool={item.key}
                    disabled={item.disabled}
                    onClick={() => { hideTip(); item.onToggle(); }}
                    onMouseEnter={(e) => showTip(item, e.currentTarget)}
                    onMouseLeave={hideTip}
                    onFocus={(e) => showTip(item, e.currentTarget)}
                    onBlur={hideTip}
                    {...dragProps(item)}
                  >
                    <Icon className="ows-tb-icon" size={15} />
                    {labels || item.primary ? <span className="ows-tb-label">{item.name ?? item.label}</span> : null}
                  </button>
                );
              })}
            </div>
          ))}
          {moreGroups.length > 0 || needsMore ? (
            <div className="ows-tools-group">
              <span className="ows-tsep" aria-hidden="true" />
              <MoreTools groups={moreGroups} open={more.open} target={drag.dragging?.line === null && drag.dragging.target === MORE} onToggle={more.toggle} onClose={more.close} rootRef={more.rootRef} dragging={drag.dragging?.key ?? null} itemProps={dragProps} />
            </div>
          ) : null}
        </div>
      ) : null}
      {labels ? (
        <div ref={measureRef} className="ows-measure" aria-hidden="true">
          {visibleGroups.flat().map((item) => {
            const Icon = item.icon;
            return (
              <span key={item.key} data-measure={item.key} className={`ows-tb${item.primary ? " is-primary" : ""}`}>
                <Icon className="ows-tb-icon" size={15} />
                <span className="ows-tb-label">{item.name ?? item.label}</span>
              </span>
            );
          })}
          <span data-measure={MORE} className="ows-tb ows-more"><span className="ows-tb-label">More</span><ChevronDown className="ows-more-chevron" size={13} /></span>
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
          {tip.item.tip ?? (labels ? null : tip.item.label)}{tip.item.shortcut ? <kbd>{tip.item.shortcut}</kbd> : null}
        </div>,
        document.body,
      )}
      {drag.dragging && draggedItem && DraggedIcon && createPortal(
        <div className="orbit-ui ows-drag-layer">
          {drag.dragging.line ? <i className={`ows-drop is-${drag.dragging.line.axis}`} style={{ left: drag.dragging.line.left, top: drag.dragging.line.top, [drag.dragging.line.axis === "x" ? "height" : "width"]: drag.dragging.line.length }} /> : null}
          <span className="ows-drag" style={{ left: drag.dragging.x, top: drag.dragging.y }}>
            <DraggedIcon className="ows-tb-icon" size={15} />{draggedItem.name ?? draggedItem.label}
          </span>
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
              <span>{item.name ?? item.label}</span>
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
