import { useState, useCallback, useRef, forwardRef, useImperativeHandle, useEffect, useMemo, useLayoutEffect, useSyncExternalStore, Fragment } from "react";
import { createPortal } from "react-dom";
import { userKeymapStore, commandRegistry } from "../../../keyboard";
import {
  X,
  Terminal,
  BarChart3,
  MessageSquare,
  Puzzle,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  MoveHorizontal,
  LayoutGrid,
} from "lucide-react";
import "./ide-layout.css";
import type {
  IDELayoutContainerProps,
  IDELayoutHandle,
  AuxPanelType,
  InfoTabType,
  ArtifactPreviewRequest,
} from "./IDELayout.types";
import { AUX_PANEL_TYPES } from "./IDELayout.types";
import { MultiTabTerminalPanel } from "./MultiTabTerminalPanel";
import { OrbitPhonePanels, type OrbitPhonePanel } from "./OrbitPhonePanels";
import { OrbitWorkspaceBar, OrbitDock, OrbitGrip, type OrbitToolItem } from "./OrbitWorkspace";
import { useSlotElement } from "./useSlotElement";
import {
  orbitSlotFor,
  toggleOrbitPanel,
  openOrbitPanel,
  isOrbitPanelOpen,
  migrateToOrbitSlots,
  terminalPositionOf,
  withAgentRule,
  visibilityToPersist,
  type SurfaceVisibility,
  fitOrbitWidths,
  fitOrbitBottom,
  ORBIT_SIDE_MIN,
  ORBIT_DOCK_MAX,
  ORBIT_CHAT_MIN,
  ORBIT_BOTTOM_MIN,
  ORBIT_BOTTOM_RESERVE,
  type OrbitSlot,
} from "./orbitDock";
import type { PanelMenuItem } from "../../../orbit/ui";
import { ORBIT_PHONE_ACTIONS_SLOT, ORBIT_PHONE_SHOW_CHAT_EVENT } from "../../Layout/OrbitPhoneHeader";
import type { FileNavRequest } from "../../Review";
import { OPEN_SKETCH_EVENT, type OpenSketchDetail } from "../../ui/sketchChipCache";
import { useOpenReviewRequests, type OpenReviewRequest } from "../../../orbit/workspace/openReview";
import { useConfig, useProject } from "../../../context";
import { useIsMobile } from "../../../hooks";
import { useLinkedReviewProjectsState } from "../../../hooks/useLinkedReviewProjects";
import { apiClient } from "../../../api/client";
import { listActivePlugins, type Plugin } from "../../../api/plugins";
import {
  OPEN_PLUGIN_PANEL_EVENT,
  PLUGINS_CHANGED_EVENT,
  type OpenPluginPanelDetail,
} from "../../Plugins/pluginPanelCommands";
import {
  renderPanel,
  renderOrbitPanel,
  panelGlyph,
  getPanelDescriptor,
  buildPanelCatalog,
  panelShortcutDisplay,
  PLUGIN_PANEL_PREFIX,
  type PanelRenderCtx,
  type PanelDescriptor,
} from "../PanelSystem/panelRegistry";

const CHAT_COL_MIN = 420;
const AUX_COL_FLOOR = 280;
const INFO_COL_FLOOR = 320;
const RESIZER_PX = 8;
// Orbit desktop dock defaults (Workspace board).
const ORBIT_AUX_DEFAULT = 520;
const ORBIT_DOCK_DEFAULT = 384;
const ORBIT_BOTTOM_DEFAULT = 260;

function ideLayoutStorageKey(projectId: string, taskId: string) {
  return `grove-idelayout-${projectId}-${taskId}`;
}

interface PersistedIDEState {
  auxType: string | null;
  auxVisible: boolean;
  chatVisible: boolean;
  infoType: string | null;
  infoVisible: boolean;
  terminalTabs: TerminalTab[];
  terminalActiveId: string;
  auxWidth: number;
  infoWidth: number;
  /** Orbit: the terminal docked under the Agent. */
  bottomVisible?: boolean;
  bottomHeight?: number;
}

function loadPersistedState(projectId: string, taskId: string): Partial<PersistedIDEState> {
  try {
    const raw = localStorage.getItem(ideLayoutStorageKey(projectId, taskId));
    if (!raw) return {};
    return JSON.parse(raw) as Partial<PersistedIDEState>;
  } catch {
    return {};
  }
}

function savePersistedState(projectId: string, taskId: string, state: PersistedIDEState) {
  try {
    localStorage.setItem(ideLayoutStorageKey(projectId, taskId), JSON.stringify(state));
  } catch {
    // ignore storage errors
  }
}

function readStoredWidth(fallback: number, persisted?: number): number {
  return typeof persisted === "number" && Number.isFinite(persisted) ? persisted : fallback;
}

function clampWidth(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

interface TerminalTab {
  id: string;
  label: string;
}

interface IDELayoutInternalState {
  // Built-in aux panel (AuxPanelType) or a plugin panel (`plugin:<id>`).
  auxType: string | null;
  auxVisible: boolean;
  chatVisible: boolean;
  // Built-in info panel (InfoTabType) or a right-side plugin (`plugin:<id>`).
  infoType: string | null;
  infoVisible: boolean;
  fileNavRequest: FileNavRequest | null;
  artifactPreviewRequest: ArtifactPreviewRequest | null;
  lastChatIdleAt: number | undefined;
  isChatBusy: boolean;
  terminalTabs: TerminalTab[];
  terminalActiveId: string;
  // Keep-alive: panel types the user has opened at least once. Once a type
  // is in this list it stays mounted (hidden via display:none) so re-opening
  // is instant and doesn't re-fetch data.
  visitedAux: string[];
  visitedInfo: string[];
  /** Orbit desktop: the bottom terminal dock is open / has been opened once. */
  bottomVisible: boolean;
  visitedBottom: boolean;
}

type ToolbarItem = { d: PanelDescriptor; kind: "aux" | "info" };

function Toolbar({
  state,
  update,
  isMobile,
  auxPanels,
  infoPanels,
  leading,
  trailing,
  compact = false,
}: {
  state: IDELayoutInternalState;
  update: (partial: Partial<IDELayoutInternalState>) => void;
  isMobile: boolean;
  // Already filtered by availability + category, from the shared catalog.
  auxPanels: PanelDescriptor[];
  infoPanels: PanelDescriptor[];
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  /** Orbit: inactive buttons are icon-only (CSS), so names come from an instant tooltip. */
  compact?: boolean;
}) {
  const hasOpenPanel = state.auxVisible || state.infoVisible;
  const [tip, setTip] = useState<{ text: string; left: number; top: number } | null>(null);
  const tipProps = (text: string) => compact ? {
    "aria-label": text,
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      setTip({ text, left: r.left + r.width / 2, top: r.bottom + 6 });
    },
    onMouseLeave: () => setTip(null),
  } : { title: text };

  // Real keybinding hints: resolve each panel's `panel.<key>.open` command from
  // the catalog + the user's keymap overrides (NOT a hardcoded guess), and
  // re-render live when the user edits their shortcuts. Plugins have no command
  // → no hint.
  useSyncExternalStore(
    (cb) => userKeymapStore.subscribe(cb),
    () => userKeymapStore.getVersion(),
  );
  useSyncExternalStore(
    (cb) => commandRegistry.subscribe(cb),
    () => commandRegistry.listCommands().length,
  );
  const shortcutFor = panelShortcutDisplay;

  // Aux + info panels share one responsive row (chat stays pinned). As panels
  // grow or the screen narrows, whatever doesn't fit collapses into ⋯ More.
  const items: ToolbarItem[] = useMemo(
    () => [
      ...auxPanels.map((d) => ({ d, kind: "aux" as const })),
      ...infoPanels.map((d) => ({ d, kind: "info" as const })),
    ],
    [auxPanels, infoPanels],
  );

  const isItemActive = (item: ToolbarItem) =>
    item.kind === "aux"
      ? state.auxVisible && state.auxType === item.d.key
      : state.infoVisible && state.infoType === item.d.key;

  const activate = (item: ToolbarItem) => {
    const active = isItemActive(item);
    if (item.kind === "aux") {
      if (isMobile) {
        update(active
          ? { auxVisible: false, chatVisible: true }
          : { auxType: item.d.key, auxVisible: true, chatVisible: false, infoVisible: false });
      } else {
        update(active ? { auxVisible: false } : { auxType: item.d.key, auxVisible: true });
      }
    } else {
      const key = item.d.key;
      if (isMobile) {
        update(active
          ? { infoVisible: false, chatVisible: true }
          : { infoType: key, infoVisible: true, chatVisible: false, auxVisible: false });
      } else {
        update(active ? { infoVisible: false } : { infoType: key, infoVisible: true });
      }
    }
  };

  // Measure each button's width in a hidden row, then fit as many as the
  // visible row allows; remainder goes to the ⋯ overflow menu.
  const rowRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const [visibleCount, setVisibleCount] = useState(items.length);
  const [menuOpen, setMenuOpen] = useState(false);
  // Portal-positioned (fixed) so the menu escapes the row's overflow:hidden
  // clip and any stacking context below it.
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const MENU_W = 220;
  const toggleMenu = () => {
    if (menuOpen) { setMenuOpen(false); return; }
    const r = moreBtnRef.current?.getBoundingClientRect();
    if (r) setMenuPos({ top: r.bottom + 4, left: Math.max(8, r.right - MENU_W) });
    setMenuOpen(true);
  };

  useLayoutEffect(() => {
    const compute = () => {
      const row = rowRef.current;
      const measure = measureRef.current;
      if (!row || !measure) return;
      // Reserve space for the aux↕info divider shown between the two groups.
      const hasBoth = items.some((i) => i.kind === "aux") && items.some((i) => i.kind === "info");
      const avail = row.clientWidth - (hasBoth ? 13 : 0);
      const widths = Array.from(measure.children).map((c) => (c as HTMLElement).offsetWidth + 4);
      const MORE_W = 44;
      let used = 0;
      let n = 0;
      for (let i = 0; i < widths.length; i++) {
        used += widths[i];
        const needMore = i < widths.length - 1;
        if (used + (needMore ? MORE_W : 0) > avail) break;
        n++;
      }
      setVisibleCount(n);
    };
    compute();
    const ro = new ResizeObserver(compute);
    if (rowRef.current) ro.observe(rowRef.current);
    // Button widths change when Orbit reveals the active panel's label.
    for (const child of Array.from(measureRef.current?.children ?? [])) ro.observe(child);
    return () => ro.disconnect();
  }, [items]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener("pointerdown", close);
    // A fixed-positioned menu would detach on scroll/resize — just close it.
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menuOpen]);

  const visible = items.slice(0, visibleCount);
  const overflow = items.slice(visibleCount);

  // Horizontal toolbar button (icon + label via the shared class).
  const renderBtn = (item: ToolbarItem) => {
    const Icon = item.d.icon;
    const sc = shortcutFor(item.d.key);
    const active = isItemActive(item);
    return (
      <button
        key={item.d.key}
        onClick={() => { activate(item); setTip(null); }}
        className={`ide-toolbar__btn ${active ? "ide-toolbar__btn--active" : ""}`}
        {...tipProps(sc ? `${item.d.label} (${sc})` : item.d.label)}
      >
        <Icon size={13} />
        <span>{item.d.label}</span>
      </button>
    );
  };

  // Overflow-menu row: icon + name + shortcut, left-aligned and readable.
  const renderMenuRow = (item: ToolbarItem) => {
    const Icon = item.d.icon;
    const sc = shortcutFor(item.d.key);
    const active = isItemActive(item);
    const hot = hoveredKey === item.d.key;
    return (
      <button
        key={item.d.key}
        onMouseEnter={() => setHoveredKey(item.d.key)}
        onMouseLeave={() => setHoveredKey(null)}
        onClick={() => { activate(item); setMenuOpen(false); }}
        style={{
          display: "flex", alignItems: "center", gap: 8, width: "100%",
          padding: "6px 10px", border: "none", borderRadius: 6, cursor: "pointer",
          fontSize: 13, textAlign: "left",
          background: active
            ? "color-mix(in oklab, var(--color-highlight) 16%, transparent)"
            : hot ? "var(--color-bg-tertiary)" : "transparent",
          color: active ? "var(--color-highlight)" : "var(--color-text)",
        }}
      >
        <Icon size={14} style={{ flexShrink: 0 }} />
        <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {item.d.label}
        </span>
        {sc && (
          <kbd style={{ fontSize: 10, color: "var(--color-text-muted)", fontFamily: "monospace" }}>{sc}</kbd>
        )}
      </button>
    );
  };

  const menuHeader = (text: string) => (
    <div style={{
      padding: "4px 10px 2px", fontSize: 10, fontWeight: 600, letterSpacing: "0.04em",
      color: "var(--color-text-muted)", textTransform: "uppercase",
    }}>{text}</div>
  );

  return (
    <div className="ide-toolbar">
      {leading && <div className="ide-toolbar__leading">{leading}</div>}

      {(() => {
        // On mobile, chat / aux / info are mutually exclusive (they all
        // collapse onto the same grid cell). The button shows active
        // only when chat is the panel actually being rendered. On
        // desktop the panels can coexist, so chat is "active" any time
        // it's visible.
        const chatActive = isMobile
          ? state.chatVisible && !state.auxVisible && !state.infoVisible
          : state.chatVisible;
        return (
      <button
        onClick={() => {
          if (isMobile) {
            update({ chatVisible: true, auxVisible: false, infoVisible: false });
          } else {
            update({ chatVisible: state.chatVisible ? !hasOpenPanel : true });
          }
        }}
        disabled={!isMobile && state.chatVisible && !hasOpenPanel}
        className={`ide-toolbar__btn ide-toolbar__btn--chat ${chatActive ? "ide-toolbar__btn--active" : ""}`}
        {...tipProps(hasOpenPanel ? "Toggle Agent" : "Agent stays visible until another panel is open")}
      >
        <MessageSquare size={13} />
        <span>Agent</span>
      </button>
        );
      })()}
      <div className="ide-toolbar__separator" />

      <div
        ref={rowRef}
        className="ide-toolbar__group"
        style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", position: "relative" }}
      >
        {visible.map((item, i) => {
          const prev = visible[i - 1];
          const sep = prev && prev.kind === "aux" && item.kind === "info";
          return (
            <Fragment key={item.d.key}>
              {sep && <div className="ide-toolbar__separator" />}
              {renderBtn(item)}
            </Fragment>
          );
        })}
        {overflow.length > 0 && (
          <button
            ref={moreBtnRef}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={toggleMenu}
            className={`ide-toolbar__btn ${overflow.some(isItemActive) ? "ide-toolbar__btn--active" : ""}`}
            {...tipProps("More panels")}
          >
            <MoreHorizontal size={13} />
          </button>
        )}
        {menuOpen && menuPos && overflow.length > 0 && createPortal(
          <div
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              position: "fixed", top: menuPos.top, left: menuPos.left, width: MENU_W, zIndex: 9999,
              display: "flex", flexDirection: "column", gap: 1, padding: 4,
              background: "var(--color-bg-secondary)", border: "1px solid var(--color-border)",
              borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
            }}
          >
            {(() => {
              const auxItems = overflow.filter((i) => i.kind === "aux");
              const infoItems = overflow.filter((i) => i.kind === "info");
              return (
                <>
                  {auxItems.length > 0 && menuHeader("Left panel")}
                  {auxItems.map(renderMenuRow)}
                  {auxItems.length > 0 && infoItems.length > 0 && (
                    <div style={{ height: 1, margin: "4px 6px", background: "var(--color-border)" }} />
                  )}
                  {infoItems.length > 0 && menuHeader("Right panel")}
                  {infoItems.map(renderMenuRow)}
                </>
              );
            })()}
          </div>,
          document.body,
        )}
        {/* Hidden measurement row — always all items, for stable widths. */}
        <div
          ref={measureRef}
          aria-hidden
          style={{ position: "absolute", left: 0, top: 0, display: "flex", visibility: "hidden", pointerEvents: "none" }}
        >
          {items.map(renderBtn)}
        </div>
      </div>

      {trailing && (
        <>
          <div className="ide-toolbar__spacer" />
          <div className="ide-toolbar__trailing">{trailing}</div>
        </>
      )}
      {tip && createPortal(<div className="ide-toolbar__tip" style={{ left: tip.left, top: tip.top }}>{tip.text}</div>, document.body)}
    </div>
  );
}

function PanelSlot({
  title,
  icon: Icon,
  onClose,
  side,
  children,
}: {
  title: string;
  icon: typeof Terminal;
  onClose?: () => void;
  side: "left" | "right";
  children: React.ReactNode;
}) {
  return (
    <div className={`ide-panel-slot ide-panel-slot--${side}`}>
      <div className="ide-panel-slot__header">
        <Icon size={14} className="text-[var(--color-text-muted)]" />
        <span className="ide-panel-slot__title">{title}</span>
        <div className="ide-panel-slot__spacer" />
        {onClose && (
          <div className="ide-panel-slot__actions">
            <button onClick={onClose} title="Close">
              <X size={14} />
            </button>
          </div>
        )}
      </div>
      <div className="ide-panel-slot__body">{children}</div>
    </div>
  );
}

export const IDELayoutContainer = forwardRef<IDELayoutHandle, IDELayoutContainerProps>(
  function IDELayoutContainer({ task, projectId, toolbarLeading, toolbarTrailing, phoneActions, isActive = true, onToggleLayoutMode, toolbarMenu }, ref) {
    const { selectedProject, projects } = useProject();
    const { terminalAvailable, config } = useConfig();
    const { isMobile } = useIsMobile();
    // Orbit styling depends only on the interface, never on visibility: a
    // keep-alive page that drops it while hidden flashes Classic chrome for a
    // frame when shown again. Visibility only decides who owns the toolbar slot.
    // On a phone Orbit swaps the toolbar for the header's panel sheet.
    const orbitLayout = config?.web?.interface === "orbit";
    const orbitPhone = orbitLayout && isMobile;
    // Orbit on a desktop: Agent in the centre, a right dock, the terminal below.
    const orbitDesk = orbitLayout && !isMobile;
    const terminalPosition = terminalPositionOf(config?.web?.terminal_position);
    const orbitSlotId = orbitPhone ? ORBIT_PHONE_ACTIONS_SLOT : "orbit-workspace-toolbar";
    // The header slot can mount after this layout (config / page transitions):
    // keep resolving it until it exists.
    const orbitToolbarSlot = useSlotElement(orbitLayout ? orbitSlotId : null, isActive);
    const orbitToolbarTarget = orbitLayout && isActive ? orbitToolbarSlot : null;
    const resizerWidth = orbitLayout ? 1 : RESIZER_PX;
    // Resolve the project this task actually belongs to by its projectId,
    // not the globally-selected project. Blitz lets the user open a task
    // from any project while sidebar still shows a different one; using
    // `selectedProject` here mis-classifies Studio tasks as Coding and
    // surfaces Code Review / Git / Comments tabs that don't apply.
    const taskProject = projects.find((p) => p.id === projectId) ?? selectedProject;
    const isStudio = taskProject?.projectType === "studio";
    const isGitRepo = taskProject?.isGitRepo;
    const { projects: linkedReviewProjects, loaded: linkedReviewLoaded } = useLinkedReviewProjectsState(projectId, task.id);
    const hasLinkedReview = linkedReviewProjects.length > 0;

    // Read persisted state once at mount via useState lazy initializer (avoids repeated localStorage reads)
    const [persisted] = useState<Partial<PersistedIDEState>>(() =>
      loadPersistedState(projectId, task.id),
    );

    // Installed plugins that contribute a workspace panel — rendered as extra
    // aux-panel toolbar buttons (`plugin:<id>`), same as FlexLayout's [+] menu.
    const [panelPlugins, setPanelPlugins] = useState<Plugin[]>([]);
    useEffect(() => {
      let cancelled = false;
      const load = () => {
        listActivePlugins()
          .then((ps) => { if (!cancelled) setPanelPlugins(ps.filter((p) => p.contributes?.panel)); })
          .catch(() => { if (!cancelled) setPanelPlugins([]); });
      };
      load();
      window.addEventListener(PLUGINS_CHANGED_EVENT, load);
      return () => {
        cancelled = true;
        window.removeEventListener(PLUGINS_CHANGED_EVENT, load);
      };
    }, []);

    const [state, setState] = useState<IDELayoutInternalState>(() => {
      const firstTabId = `term-init-${Date.now()}`;
      const terminalTabs = persisted.terminalTabs?.length
        ? persisted.terminalTabs
        : [{ id: firstTabId, label: "Terminal" }];
      const terminalActiveId =
        persisted.terminalActiveId && terminalTabs.some((t) => t.id === persisted.terminalActiveId)
          ? persisted.terminalActiveId
          : terminalTabs[0].id;
      // Orbit on a phone always opens on the chat.
      const auxVisible = !orbitPhone && (persisted.auxVisible ?? false);
      const infoVisible = !orbitPhone && (persisted.infoVisible ?? false) && (!isMobile || !auxVisible);
      let initial: IDELayoutInternalState = {
        auxType: persisted.auxType ?? null,
        auxVisible,
        chatVisible: isMobile ? !auxVisible && !infoVisible : persisted.chatVisible ?? true,
        infoType: persisted.infoType ?? null,
        infoVisible,
        fileNavRequest: null,
        artifactPreviewRequest: null,
        lastChatIdleAt: undefined,
        isChatBusy: false,
        terminalTabs,
        terminalActiveId,
        visitedAux: [],
        visitedInfo: [],
        bottomVisible: orbitDesk && (persisted.bottomVisible ?? false),
        visitedBottom: false,
      };
      if (orbitDesk) initial = withAgentRule(migrateToOrbitSlots(initial, terminalPosition));
      return {
        ...initial,
        visitedAux: initial.auxType ? [initial.auxType] : [],
        visitedInfo: initial.infoType ? [initial.infoType] : [],
        visitedBottom: initial.bottomVisible,
      };
    });
    const [auxWidth, setAuxWidth] = useState(() => readStoredWidth(520, persisted.auxWidth));
    const [infoWidth, setInfoWidth] = useState(() => readStoredWidth(orbitDesk ? ORBIT_DOCK_DEFAULT : 340, persisted.infoWidth));
    const [bottomHeight, setBottomHeight] = useState(() => readStoredWidth(ORBIT_BOTTOM_DEFAULT, persisted.bottomHeight));
    const [auxWasResized, setAuxWasResized] = useState(false);
    const [infoWasResized, setInfoWasResized] = useState(false);
    const navSeqRef = useRef(0);
    const shellRef = useRef<HTMLDivElement>(null);
    // Orbit desktop: the shell's size bounds the docks; a drag follows the pointer.
    const [shellSize, setShellSize] = useState({ w: 0, h: 0 });
    const [orbitResizing, setOrbitResizing] = useState<"aux" | "dock" | "bottom" | null>(null);
    useLayoutEffect(() => {
      const el = shellRef.current;
      if (!orbitDesk || !el) return;
      const measure = () => setShellSize((prev) => {
        const w = Math.round(el.clientWidth);
        const h = Math.round(el.clientHeight);
        return prev.w === w && prev.h === h ? prev : { w, h };
      });
      measure();
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    }, [orbitDesk]);
    // Tracks which side panel was most recently focused so Cmd+W /
    // closeActiveTab closes *that* one instead of always preferring info.
    // Defaults to "info" so behavior matches the previous hardcoded rule
    // until the user explicitly interacts with the aux panel.
    const lastFocusedSideRef = useRef<"aux" | "info" | "bottom">("info");
    // Keep latest state accessible from imperative handle callbacks without
    // invalidating the useImperativeHandle cache on every state change.
    const stateRef = useRef(state);
    useEffect(() => {
      stateRef.current = state;
    }, [state]);

    // Wrap setState so every state transition tags the active panel as
    // "visited" — once visited a panel stays mounted (display:none when
    // hidden) so re-opening is instant and doesn't refetch data.
    // Orbit desktop: the Agent stays visible unless a left panel is open.
    const orbitDeskRef = useRef(orbitDesk);
    useEffect(() => { orbitDeskRef.current = orbitDesk; }, [orbitDesk]);
    const setStateTagged = useCallback(
      (updater: (prev: IDELayoutInternalState) => IDELayoutInternalState) => {
        setState((prev) => {
          const updated = updater(prev);
          const next = orbitDeskRef.current ? withAgentRule(updated) : updated;
          let visitedAux = next.visitedAux;
          let visitedInfo = next.visitedInfo;
          if (next.auxVisible && next.auxType && !visitedAux.includes(next.auxType)) {
            visitedAux = [...visitedAux, next.auxType];
          }
          if (next.infoVisible && next.infoType && !visitedInfo.includes(next.infoType)) {
            visitedInfo = [...visitedInfo, next.infoType];
          }
          const visitedBottom = next.visitedBottom || next.bottomVisible;
          return visitedAux === next.visitedAux && visitedInfo === next.visitedInfo && visitedBottom === next.visitedBottom
            ? next
            : { ...next, visitedAux, visitedInfo, visitedBottom };
        });
      },
      [],
    );

    const update = useCallback(
      (partial: Partial<IDELayoutInternalState>) => {
        setStateTagged((prev) => {
          const next = { ...prev, ...partial };
          if (!next.auxVisible && !next.infoVisible && !next.chatVisible) {
            next.chatVisible = true;
          }
          return next;
        });
      },
      [setStateTagged],
    );
    // Most recently used surface — opened via toolbar/shortcut or clicked into.
    // Decides which one survives when the window narrows into the stacked
    // single-pane layout.
    const lastSurfaceRef = useRef<"aux" | "info" | "chat">("chat");
    const prevSurfacesRef = useRef(state);
    useEffect(() => {
      const prev = prevSurfacesRef.current;
      prevSurfacesRef.current = state;
      if (state.auxVisible && (!prev.auxVisible || prev.auxType !== state.auxType)) {
        lastSurfaceRef.current = "aux";
      } else if (state.infoVisible && (!prev.infoVisible || prev.infoType !== state.infoType)) {
        lastSurfaceRef.current = "info";
      } else if (state.chatVisible && !prev.chatVisible) {
        lastSurfaceRef.current = "chat";
      }
    }, [state]);

    // Below the desktop breakpoint ide-layout.css stacks every surface in one
    // grid cell and relies on state to keep exactly one visible. Mount and the
    // toolbar enforce that, but narrowing a desktop window with several
    // surfaces open did not — they painted on top of each other. Collapse to
    // the last-used surface (falling back to chat) on that transition.
    // The last arrangement the user chose on a desktop-width window (seeded
    // from what was saved). The stacked collapse below is automatic, so it is
    // never saved, and widening the window again brings that arrangement back.
    const desktopVisibilityRef = useRef<SurfaceVisibility>({
      auxType: persisted.auxType ?? null,
      auxVisible: persisted.auxVisible ?? false,
      chatVisible: persisted.chatVisible ?? true,
      infoVisible: persisted.infoVisible ?? false,
    });
    const wasMobileRef = useRef(isMobile);
    useEffect(() => {
      const wasMobile = wasMobileRef.current;
      wasMobileRef.current = isMobile;
      if (!isMobile && wasMobile && !orbitPhone) {
        const desktop = desktopVisibilityRef.current;
        setStateTagged((prev) => ({
          ...prev,
          auxVisible: desktop.auxVisible && !!prev.auxType,
          infoVisible: desktop.infoVisible && !!prev.infoType,
          chatVisible: desktop.chatVisible,
        }));
        return;
      }
      if (!isMobile || wasMobile) return;
      setStateTagged((prev) => {
        const aux = prev.auxVisible && !!prev.auxType;
        const info = prev.infoVisible && !!prev.infoType;
        const chat = prev.chatVisible || (!aux && !info);
        if (Number(aux) + Number(info) + Number(chat) <= 1) return prev;
        const last = lastSurfaceRef.current;
        const keep = last === "aux" && aux ? "aux"
          : last === "info" && info ? "info"
          : chat ? "chat"
          : aux ? "aux" : "info";
        return {
          ...prev,
          auxVisible: keep === "aux",
          infoVisible: keep === "info",
          chatVisible: keep === "chat",
        };
      });
    }, [isMobile, orbitPhone, setStateTagged]);

    useEffect(() => {
      if (!orbitPhone) return;
      const showChat = () => update({ chatVisible: true, auxVisible: false, infoVisible: false });
      window.addEventListener(ORBIT_PHONE_SHOW_CHAT_EVENT, showChat);
      return () => window.removeEventListener(ORBIT_PHONE_SHOW_CHAT_EVENT, showChat);
    }, [orbitPhone, update]);

    // Entering the Orbit desktop layout (e.g. widening from a phone width):
    // terminal / graph move out of the left column into their docks.
    // So does an open terminal when its position setting changes.
    const placedRef = useRef({ orbitDesk, terminalPosition });
    useEffect(() => {
      const placed = placedRef.current;
      placedRef.current = { orbitDesk, terminalPosition };
      if (!orbitDesk || (placed.orbitDesk && placed.terminalPosition === terminalPosition)) return;
      setStateTagged((prev) => migrateToOrbitSlots(prev, terminalPosition));
    }, [orbitDesk, terminalPosition, setStateTagged]);

    const handleNavigateToFile = useCallback(
      async (filePath: string, line?: number, mode?: "diff" | "full"): Promise<boolean> => {
        // Probe existence via the existing /file/raw route (HEAD reuses the
        // GET handler in axum). 404 → caller renders a markdown fallback
        // and we never open the panel for a phantom path.
        try {
          const probeUrl = `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/file/raw?path=${encodeURIComponent(filePath)}`;
          await apiClient.head(probeUrl);
          // 4xx = file truly missing → bail. 5xx is server flake; be
          // optimistic and let the panel render its own fallback rather
          // than denying the user the chance to open it.
        } catch (error) {
          const status = (error as { status?: number })?.status;
          if (status !== undefined && status >= 400 && status < 500) return false;
          // Network failure (offline, dev server restart) — don't punish
          // the user; open the panel and let its content fetch fall back.
        }
        navSeqRef.current += 1;
        const seq = navSeqRef.current;
        if (isStudio) {
          update({ artifactPreviewRequest: { file: filePath, seq } });
        } else {
          update({ fileNavRequest: { file: filePath, line, mode, seq } });
        }
        setStateTagged((prev) => ({
          ...prev,
          auxType: isStudio ? "artifacts" : "review",
          auxVisible: true,
          ...(isMobile ? { chatVisible: false, infoVisible: false } : {}),
        }));
        return true;
      },
      [isStudio, isMobile, update, setStateTagged, projectId, task.id],
    );

    const handleChatBecameIdle = useCallback(() => {
      update({ lastChatIdleAt: Date.now() });
    }, [update]);

    // Global listener: a SketchChip click dispatches OPEN_SKETCH_EVENT. When
    // the target task is this one, open the Sketch aux panel so the chip
    // feels like navigation. Only Studio tasks have a sketch panel.
    useEffect(() => {
      if (!isStudio) return;
      const handler = (e: Event) => {
        const detail = (e as CustomEvent<OpenSketchDetail>).detail;
        if (!detail) return;
        if (detail.projectId !== projectId || detail.taskId !== task.id) return;
        setStateTagged((prev) => {
          if (prev.auxVisible && prev.auxType === "sketch") return prev;
          return { ...prev, auxType: "sketch", auxVisible: true };
        });
      };
      window.addEventListener(OPEN_SKETCH_EVENT, handler);
      return () => window.removeEventListener(OPEN_SKETCH_EVENT, handler);
    }, [isStudio, projectId, task.id, setStateTagged]);

    useEffect(() => {
      const handler = (e: Event) => {
        const detail = (e as CustomEvent<{ chatId?: string }>).detail;
        update({ chatVisible: true });
        if (detail?.chatId) {
          setTimeout(() => {
            window.dispatchEvent(
              new CustomEvent("grove:select-chat", { detail: { chatId: detail.chatId } }),
            );
          }, 100);
        }
      };
      window.addEventListener("grove:open-chat", handler);
      return () => window.removeEventListener("grove:open-chat", handler);
    }, [update]);

    // Global listener: a plugin keybinding opens its panel in the column its
    // manifest chose (`side`: right → info column, else aux column).
    useEffect(() => {
      const handler = (e: Event) => {
        const detail = (e as CustomEvent<OpenPluginPanelDetail>).detail;
        if (!detail || detail.projectId !== projectId || detail.taskId !== task.id) return;
        const plugin = panelPlugins.find((p) => p.id === detail.pluginId);
        if (!plugin) return;
        const key = `${PLUGIN_PANEL_PREFIX}${plugin.id}`;
        if (plugin.contributes?.panel?.side === "right") {
          setStateTagged((prev) =>
            prev.infoVisible && prev.infoType === key ? prev : { ...prev, infoType: key, infoVisible: true });
        } else {
          setStateTagged((prev) =>
            prev.auxVisible && prev.auxType === key ? prev : { ...prev, auxType: key, auxVisible: true });
        }
      };
      window.addEventListener(OPEN_PLUGIN_PANEL_EVENT, handler);
      return () => window.removeEventListener(OPEN_PLUGIN_PANEL_EVENT, handler);
    }, [projectId, task.id, panelPlugins, setStateTagged]);

    // "Open in Review" from elsewhere (Orbit Dashboard, Comments panel): see
    // orbit/workspace/openReview.ts. Taken on mount (the caller navigated here)
    // and on the event (this workspace was already showing). A Studio task
    // only knows whether it has a Review once its linked Projects load, so the
    // request waits for that instead of being dropped.
    const openReviewPanel = useCallback((request: OpenReviewRequest) => {
      if (isStudio && !hasLinkedReview) return;
      const showPanel = () => setStateTagged((prev) => (
        prev.auxVisible && prev.auxType === "review"
          ? prev
          : { ...prev, auxType: "review", auxVisible: true, ...(isMobile ? { chatVisible: false, infoVisible: false } : {}) }
      ));
      // A Studio task's own files open in Artifacts, so only jump for coding tasks.
      if (!request.file || isStudio) {
        showPanel();
        return;
      }
      const mode = isGitRepo === false ? "full" : request.mode;
      // A file that no longer exists (deleted in the change) still opens the panel.
      void handleNavigateToFile(request.file, request.line, mode).then((opened) => { if (!opened) showPanel(); });
    }, [isStudio, hasLinkedReview, isGitRepo, isMobile, setStateTagged, handleNavigateToFile]);

    useOpenReviewRequests(projectId, task.id, !isStudio || linkedReviewLoaded, openReviewPanel);

    const handleBusyStateChange = useCallback((busy: boolean) => {
      update({ isChatBusy: busy });
    }, [update]);

    const startResize = useCallback((side: "aux" | "info", event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const sw = shellRef.current?.getBoundingClientRect().width ?? window.innerWidth;
      const s = stateRef.current;
      const otherSide = side === "aux" ? "info" : "aux";
      const otherVisible = otherSide === "info"
        ? Boolean(s.infoVisible && s.infoType)
        : Boolean(s.auxVisible && s.auxType);
      const otherFloor = otherSide === "info" ? INFO_COL_FLOOR : AUX_COL_FLOOR;
      const maxSide = otherVisible
        ? sw - CHAT_COL_MIN - resizerWidth * 2 - otherFloor
        : sw - CHAT_COL_MIN - resizerWidth;
      const maxSideWidth = Math.max(side === "aux" ? AUX_COL_FLOOR : INFO_COL_FLOOR, Math.floor(maxSide));

      // Use the actually-rendered panel width as the baseline. When the layout
      // is using the default fr-ratio (auxWasResized/infoWasResized = false),
      // auxWidth/infoWidth state doesn't match the visible width, so starting
      // from the state value would cause the panel to jump on first drag.
      // The aux/info side is wrapped in a `display: contents` div, which has
      // no layout box (getBoundingClientRect returns 0). Drill into the first
      // child (or fall back to the sibling itself for non-wrapped panels like
      // chat/terminal).
      const measureSibling = (el: Element | null): number | null => {
        if (!el) return null;
        const node = el as HTMLElement;
        const rect = node.getBoundingClientRect();
        if (rect.width > 0) return rect.width;
        const child = node.firstElementChild as HTMLElement | null;
        return child ? child.getBoundingClientRect().width : null;
      };
      const resizerEl = event.currentTarget;
      const startAuxWidth =
        side === "aux"
          ? measureSibling(resizerEl.previousElementSibling) ?? auxWidth
          : auxWidth;
      const startInfoWidth =
        side === "info"
          ? measureSibling(resizerEl.nextElementSibling) ?? infoWidth
          : infoWidth;

      const handlePointerMove = (moveEvent: PointerEvent) => {
        if (side === "aux") {
          setAuxWasResized(true);
          const next = clampWidth(startAuxWidth + moveEvent.clientX - startX, 280, maxSideWidth);
          setAuxWidth(next);
        } else {
          setInfoWasResized(true);
          const next = clampWidth(startInfoWidth + startX - moveEvent.clientX, 280, Math.min(maxSideWidth, 760));
          setInfoWidth(next);
        }
      };

      // While dragging, disable pointer events on iframes (plugin panels,
      // terminals) — otherwise the pointer crossing an iframe makes it swallow
      // mousemove and the drag stutters/sticks.
      document.body.classList.add("grove-resizing");

      const handlePointerUp = () => {
        document.body.classList.remove("grove-resizing");
        document.removeEventListener("pointermove", handlePointerMove);
        document.removeEventListener("pointerup", handlePointerUp);
      };

      document.addEventListener("pointermove", handlePointerMove);
      document.addEventListener("pointerup", handlePointerUp);
    }, [auxWidth, infoWidth, resizerWidth]);

    // Persist layout state whenever relevant fields change
    useEffect(() => {
      const current: SurfaceVisibility = {
        auxType: state.auxType, auxVisible: state.auxVisible, chatVisible: state.chatVisible, infoVisible: state.infoVisible,
      };
      if (!isMobile) desktopVisibilityRef.current = current;
      const saved = visibilityToPersist(current, desktopVisibilityRef.current, isMobile, orbitLayout);
      savePersistedState(projectId, task.id, {
        auxType: state.auxType,
        auxVisible: saved.auxVisible,
        chatVisible: saved.chatVisible,
        infoType: state.infoType,
        infoVisible: saved.infoVisible,
        terminalTabs: state.terminalTabs,
        terminalActiveId: state.terminalActiveId,
        auxWidth: Math.round(auxWidth),
        infoWidth: Math.round(infoWidth),
        bottomVisible: state.bottomVisible,
        bottomHeight: Math.round(bottomHeight),
      });
    }, [
      projectId, task.id,
      state.auxType, state.auxVisible, state.chatVisible,
      state.infoType, state.infoVisible,
      state.terminalTabs, state.terminalActiveId,
      auxWidth, infoWidth, state.bottomVisible, bottomHeight, isMobile, orbitLayout,
    ]);

    const slotOf = useCallback((key: string): OrbitSlot =>
      orbitSlotFor(key, getPanelDescriptor(key, panelPlugins)?.category ?? "aux", terminalPosition), [panelPlugins, terminalPosition]);

    useImperativeHandle(
      ref,
      () => ({
        focusPanel: (type: AuxPanelType) => {
          if (orbitDesk) {
            setStateTagged((prev) => openOrbitPanel(prev, type, slotOf(type)));
            return;
          }
          setStateTagged((prev) => {
            if (prev.auxType === type && prev.auxVisible) return prev;
            return { ...prev, auxType: type, auxVisible: true };
          });
        },
        focusAuxPanel: (type: AuxPanelType) => {
          // Toggle semantics — must match the toolbar button EXACTLY, including
          // its mobile/desktop split (see `activate`). On mobile the surfaces
          // are STACKED (chat overlays aux/info), so opening one must hide the
          // others — omitting `chatVisible: false` here is what made the
          // shortcut render Chat overlaid on top of Review. On desktop they sit
          // side by side, so Chat is intentionally left untouched.
          if (orbitDesk) {
            // Orbit: terminal docks below, graph in the right dock.
            setStateTagged((prev) => toggleOrbitPanel(prev, type, slotOf(type)));
            return;
          }
          setStateTagged((prev) => {
            const active = prev.auxVisible && prev.auxType === type;
            if (isMobile) {
              return active
                ? { ...prev, auxVisible: false, chatVisible: true }
                : { ...prev, auxType: type, auxVisible: true, chatVisible: false, infoVisible: false };
            }
            return active
              ? { ...prev, auxVisible: false }
              : { ...prev, auxType: type, auxVisible: true };
          });
        },
        focusInfoPanel: (type: InfoTabType) => {
          if (orbitDesk) {
            setStateTagged((prev) => toggleOrbitPanel(prev, type, "dock"));
            return;
          }
          setStateTagged((prev) => {
            const active = prev.infoVisible && prev.infoType === type;
            if (isMobile) {
              return active
                ? { ...prev, infoVisible: false, chatVisible: true }
                : { ...prev, infoType: type, infoVisible: true, chatVisible: false, auxVisible: false };
            }
            return active
              ? { ...prev, infoVisible: false }
              : { ...prev, infoType: type, infoVisible: true };
          });
        },
        focusChat: () => {
          // Same toggle rule for Chat: pressing `i` again hides it unless
          // that would leave the workbench with no visible surface (no aux,
          // no info), in which case we force it to stay visible.
          setStateTagged((prev) => {
            if (!prev.chatVisible) return { ...prev, chatVisible: true };
            const hasOtherSurface =
              (prev.auxVisible && !!prev.auxType) || (prev.infoVisible && !!prev.infoType);
            if (!hasOtherSurface) return prev;
            return { ...prev, chatVisible: false };
          });
        },
        showChat: () => {
          setStateTagged((prev) => prev.chatVisible ? prev : { ...prev, chatVisible: true });
        },
        selectTabByIndex: () => {
          // IDE Layout has no tab concept — Cmd+1..9 should fall through to
          // the outer sidebar navigation instead of trying to focus an aux
          // panel. Returning "no_tabs" tells TasksPage's Cmd+1..9 handler to
          // delegate to onNavByIndex.
          return "no_tabs" as const;
        },
        selectAdjacentTab: (delta: number) => {
          const auxTypes = AUX_PANEL_TYPES.filter((type) =>
            (type !== "artifacts" || isStudio) &&
            (type !== "sketch" || isStudio) &&
            (type !== "review" || !isStudio || hasLinkedReview) &&
            (type !== "terminal" || terminalAvailable) &&
            // Orbit docks these outside the left column.
            (!orbitDesk || slotOf(type) === "aux")
          );
          if (auxTypes.length === 0) return false;
          setStateTagged((prev) => {
            if (!prev.auxVisible || !prev.auxType) {
              const idx = delta > 0 ? 0 : auxTypes.length - 1;
              return { ...prev, auxType: auxTypes[idx], auxVisible: true };
            }
            const currentIdx = auxTypes.indexOf(prev.auxType as AuxPanelType);
            const nextIdx = (currentIdx + delta + auxTypes.length) % auxTypes.length;
            return { ...prev, auxType: auxTypes[nextIdx] };
          });
          return true;
        },
        addTerminalTab: () => {
          const current = stateRef.current;
          if (orbitDesk && terminalPosition === "bottom") {
            // Orbit: the terminal is the bottom dock. Reuse the first tab the
            // first time it opens; otherwise add a tab next to what's running.
            if (!current.bottomVisible && current.terminalTabs.length > 0) {
              const reusedId = current.terminalTabs[0].id;
              setStateTagged((prev) => ({ ...prev, bottomVisible: true, terminalActiveId: reusedId }));
              return reusedId;
            }
            const id = `term-run-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
            setStateTagged((prev) => ({
              ...prev,
              terminalTabs: [...prev.terminalTabs, { id, label: `Terminal (${prev.terminalTabs.length + 1})` }],
              terminalActiveId: id,
              bottomVisible: true,
            }));
            return id;
          }
          const terminalWasOpen =
            current.auxVisible && current.auxType === "terminal";

          // First-time use (user hasn't opened Terminal yet): reuse the
          // auto-created empty tab instead of spawning a second one.
          if (!terminalWasOpen && current.terminalTabs.length > 0) {
            const reusedId = current.terminalTabs[0].id;
            setStateTagged((prev) => ({
              ...prev,
              auxType: "terminal",
              auxVisible: true,
              terminalActiveId: reusedId,
            }));
            return reusedId;
          }

          // Terminal is already open — spawn a new tab so we don't clobber
          // whatever the user has running.
          const newId = `term-run-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
          setStateTagged((prev) => ({
            ...prev,
            terminalTabs: [...prev.terminalTabs, { id: newId, label: `Terminal (${prev.terminalTabs.length + 1})` }],
            terminalActiveId: newId,
            auxType: "terminal",
            auxVisible: true,
          }));
          return newId;
        },
        closeActiveTab: () => {
          if (orbitDesk && lastFocusedSideRef.current === "bottom" && stateRef.current.bottomVisible) {
            setStateTagged((prev) => ({ ...prev, bottomVisible: false }));
            lastFocusedSideRef.current = "info";
            return;
          }
          setStateTagged((prev) => {
            // Prefer closing the side that was most recently focused. Fall
            // back to whichever side is visible if the recorded side isn't.
            const preferAux =
              (lastFocusedSideRef.current === "aux" && prev.auxVisible) ||
              (lastFocusedSideRef.current === "info" && !prev.infoVisible && prev.auxVisible);
            const next = preferAux
              ? { ...prev, auxVisible: false }
              : prev.infoVisible
                ? { ...prev, infoVisible: false }
                : { ...prev, auxVisible: false };
            if (!next.auxVisible && !next.infoVisible && !next.chatVisible) {
              next.chatVisible = true;
            }
            return next;
          });
        },
      }),
      [isStudio, hasLinkedReview, terminalAvailable, setStateTagged, isMobile, orbitDesk, terminalPosition, slotOf],
    );

    // Shared render context (registry-driven). onClose differs per column;
    // terminal is injected because IDE Layout uses a multi-tab terminal slot
    // rather than FlexLayout's per-tab terminal.
    const buildCtx = useCallback((onClose: () => void): PanelRenderCtx => ({
      projectId,
      task,
      isStudio,
      isGitRepo,
      terminalAvailable,
      orbitHeader: orbitLayout,
      isActive,
      onClose,
      fileNavRequest: state.fileNavRequest,
      artifactPreviewRequest: state.artifactPreviewRequest,
      lastChatIdleAt: state.lastChatIdleAt,
      isChatBusy: state.isChatBusy,
      onChatBecameIdle: handleChatBecameIdle,
      onUserMessageSent: handleChatBecameIdle,
      onBusyStateChange: handleBusyStateChange,
      renderTerminal: () => (
        <MultiTabTerminalPanel
          projectId={projectId}
          task={task}
          side="left"
          tabs={state.terminalTabs}
          activeId={state.terminalActiveId}
          onTabsChange={(tabs, activeId) => update({ terminalTabs: tabs, terminalActiveId: activeId })}
          onClose={() => update({ auxVisible: false })}
        />
      ),
      plugins: panelPlugins,
      linkedReviewProjects,
    }), [projectId, task, isStudio, isGitRepo, terminalAvailable, orbitLayout, isActive, state.fileNavRequest, state.artifactPreviewRequest, state.lastChatIdleAt, state.isChatBusy, handleChatBecameIdle, handleBusyStateChange, state.terminalTabs, state.terminalActiveId, update, panelPlugins, linkedReviewProjects]);

    // Aux column. Terminal renders its own multi-tab header (no slot);
    // everything else is wrapped in PanelSlot with the registry's label/icon.
    const renderAuxContent = useCallback((type: string) => {
      const closeAux = () => update({ auxVisible: false });
      if (type === "terminal") return renderPanel("terminal", buildCtx(closeAux));
      const d = getPanelDescriptor(type, panelPlugins);
      return (
        <PanelSlot
          title={d?.label ?? "Panel"}
          icon={(d?.icon ?? Puzzle) as typeof Terminal}
          side="left"
          onClose={closeAux}
        >
          {renderPanel(type, buildCtx(closeAux))}
        </PanelSlot>
      );
    }, [buildCtx, panelPlugins, update]);

    // Chat is the only panel that needs file navigation — inject it here (kept
    // out of the shared ctx so aux/info panels don't capture the ref-reader).
    const renderChat = useCallback(
      () => renderPanel("chat", { ...buildCtx(() => {}), navigateToFile: handleNavigateToFile }),
      [buildCtx, handleNavigateToFile],
    );

    const renderInfoContent = useCallback((type: string) => {
      const closeInfo = () => update({ infoVisible: false });
      const d = getPanelDescriptor(type, panelPlugins);
      return (
        <PanelSlot
          title={d?.label ?? "Panel"}
          icon={(d?.icon ?? BarChart3) as typeof Terminal}
          side="right"
          onClose={closeInfo}
        >
          <div className="ide-info-content">{renderPanel(type, buildCtx(closeInfo))}</div>
        </PanelSlot>
      );
    }, [buildCtx, panelPlugins, update]);

    const showAux = Boolean(state.auxVisible && state.auxType);
    const showInfo = Boolean(state.infoVisible && state.infoType);
    const showChat = state.chatVisible || (!showAux && !showInfo);
    const isAuxChatPair = showAux && showChat && !showInfo;
    const isChatInfoPair = !showAux && showChat && showInfo;
    const useDefaultAuxPairRatio = isAuxChatPair && !auxWasResized;
    const useDefaultInfoPairRatio = isChatInfoPair && !infoWasResized;

    const auxMaxCSS = (() => {
      if (useDefaultAuxPairRatio || !showChat) return `${auxWidth}px`;
      const reserved = CHAT_COL_MIN + resizerWidth + (showInfo ? resizerWidth + INFO_COL_FLOOR : 0);
      return `min(${auxWidth}px, calc(100% - ${reserved}px))`;
    })();
    const infoMaxCSS = (() => {
      if (useDefaultInfoPairRatio || !showChat) return `${infoWidth}px`;
      const reserved = CHAT_COL_MIN + resizerWidth + (showAux ? resizerWidth + AUX_COL_FLOOR : 0);
      return `min(${infoWidth}px, calc(100% - ${reserved}px))`;
    })();

    const auxColumn = useDefaultAuxPairRatio
      ? "minmax(360px, 7fr)"
      : showChat
        ? `minmax(${AUX_COL_FLOOR}px, ${auxMaxCSS})`
        : "minmax(360px, 1fr)";
    const chatColumn = useDefaultAuxPairRatio
      ? `minmax(${CHAT_COL_MIN}px, 3fr)`
      : useDefaultInfoPairRatio
        ? `minmax(${CHAT_COL_MIN}px, 6fr)`
        : `minmax(${CHAT_COL_MIN}px, 1fr)`;
    const infoColumn = useDefaultInfoPairRatio
      ? "minmax(320px, 4fr)"
      : showChat
        ? `minmax(${INFO_COL_FLOOR}px, ${infoMaxCSS})`
        : "minmax(360px, 1fr)";
    const gridColumns = [
      showAux ? auxColumn : null,
      showAux && (showChat || showInfo) ? `${resizerWidth}px` : null,
      showChat ? chatColumn : null,
      showChat && showInfo ? `${resizerWidth}px` : null,
      showInfo ? infoColumn : null,
    ].filter(Boolean).join(" ");
    // Toolbar buttons come straight from the shared catalog, split by column.
    const catalog = buildPanelCatalog(panelPlugins, { isStudio, terminalAvailable, hasLinkedReview });
    const auxPanels = catalog.filter((d) => d.category === "aux");
    const infoPanels = catalog.filter((d) => d.category === "info");
    const toolbar = (
      <Toolbar
        state={state}
        update={update}
        isMobile={isMobile}
        auxPanels={auxPanels}
        infoPanels={infoPanels}
        leading={toolbarLeading}
        trailing={toolbarTrailing}
        compact={orbitLayout}
      />
    );

    const phonePanelList: OrbitPhonePanel[] = [
      ...auxPanels.map((d) => ({ d, kind: "aux" as const })),
      ...infoPanels.map((d) => ({ d, kind: "info" as const })),
    ];
    const phoneOpenPanel = phonePanelList.find((panel) => panel.kind === "aux"
      ? state.auxVisible && state.auxType === panel.d.key
      : state.infoVisible && state.infoType === panel.d.key) ?? null;
    // Same mutually-exclusive switching the mobile toolbar does.
    const phonePanels = (
      <OrbitPhonePanels
        panels={phonePanelList}
        openPanel={phoneOpenPanel}
        actions={phoneActions}
        onShowChat={() => update({ chatVisible: true, auxVisible: false, infoVisible: false })}
        onOpen={(panel) => update(panel.kind === "aux"
          ? { auxType: panel.d.key, auxVisible: true, chatVisible: false, infoVisible: false }
          : { infoType: panel.d.key, infoVisible: true, chatVisible: false, auxVisible: false })}
      />
    );

    if (orbitDesk) {
      const dockable = catalog.filter((d) => d.category !== "chat");
      const dockPanels = dockable
        .filter((d) => slotOf(d.key) === "dock")
        .map((d, i) => ({ d, rank: d.key.startsWith(PLUGIN_PANEL_PREFIX) ? 2 : d.key === "graph" ? 1 : 0, i }))
        .sort((a, b) => a.rank - b.rank || a.i - b.i)
        .map((x) => x.d);
      const leftPanels = dockable.filter((d) => slotOf(d.key) === "aux");
      const terminalPanel = dockable.find((d) => slotOf(d.key) === "bottom");
      const toolFor = (d: PanelDescriptor): OrbitToolItem => {
        const slot = slotOf(d.key);
        return {
          key: d.key,
          label: d.label,
          icon: panelGlyph(d, true),
          shortcut: panelShortcutDisplay(d.key),
          active: isOrbitPanelOpen(state, d.key, slot),
          onToggle: () => {
            if (slot === "bottom") lastFocusedSideRef.current = "bottom";
            setStateTagged((prev) => toggleOrbitPanel(prev, d.key, slot));
          },
        };
      };
      // The terminal draws its own tab bar in whichever dock it sits.
      const orbitTerminal = (onClose: () => void) => (
        <MultiTabTerminalPanel
          orbit
          projectId={projectId}
          task={task}
          side="left"
          tabs={state.terminalTabs}
          activeId={state.terminalActiveId}
          onTabsChange={(tabs, activeId) => update({ terminalTabs: tabs, terminalActiveId: activeId })}
          onClose={onClose}
        />
      );
      const orbitShowAux = Boolean(state.auxVisible && state.auxType && slotOf(state.auxType) === "aux");
      const orbitShowDock = Boolean(state.infoVisible && state.infoType);
      const orbitShowChat = state.chatVisible || !orbitShowAux;
      const orbitShowBottom = terminalPosition === "bottom" && state.bottomVisible && terminalAvailable;
      const chatDescriptor = getPanelDescriptor("chat");
      // The Agent leads the strip. It can only be hidden behind a left panel,
      // so without one it reads as on and does nothing.
      const agentTool: OrbitToolItem | null = chatDescriptor ? {
        key: "chat",
        label: "Agent",
        tip: !orbitShowAux ? "Agent · open a left panel to hide it" : orbitShowChat ? "Hide Agent" : "Show Agent",
        icon: panelGlyph(chatDescriptor, true),
        shortcut: panelShortcutDisplay("chat"),
        active: orbitShowChat,
        disabled: !orbitShowAux,
        primary: true,
        onToggle: () => update({ chatVisible: !orbitShowChat }),
      } : null;
      const fitted = fitOrbitWidths(shellSize.w, { aux: auxWidth, dock: infoWidth }, { aux: orbitShowAux, dock: orbitShowDock, chat: orbitShowChat });
      // With the Agent hidden the left panel takes the whole centre.
      const auxSize = orbitShowChat ? fitted.aux : Math.max(ORBIT_SIDE_MIN, shellSize.w - (orbitShowDock ? fitted.dock : 0));
      const bottomSize = fitOrbitBottom(shellSize.h, bottomHeight);

      // Workspace-level rows live in the toolbar's ⋯, never in a panel's.
      const sizesChanged = auxWidth !== ORBIT_AUX_DEFAULT || infoWidth !== ORBIT_DOCK_DEFAULT || bottomHeight !== ORBIT_BOTTOM_DEFAULT;
      const workspaceMenu: PanelMenuItem[] = [
        ...(orbitShowAux
          ? [orbitShowChat
            ? { id: "hide-agent", label: "Hide Agent", icon: PanelLeftOpen, onSelect: () => update({ chatVisible: false }) }
            : { id: "show-agent", label: "Show Agent", icon: PanelLeftClose, onSelect: () => update({ chatVisible: true }) }]
          : []),
        ...(sizesChanged
          ? [{
            id: "reset-sizes",
            label: "Reset panel sizes",
            icon: MoveHorizontal,
            onSelect: () => { setAuxWidth(ORBIT_AUX_DEFAULT); setInfoWidth(ORBIT_DOCK_DEFAULT); setBottomHeight(ORBIT_BOTTOM_DEFAULT); },
          }]
          : []),
        ...(onToggleLayoutMode ? [{ id: "free-layout", label: "Switch to free layout", icon: LayoutGrid, onSelect: onToggleLayoutMode }] : []),
      ];
      const toolbarRows = (toolbarMenu ?? []).map((row, i) => (i === 0 && workspaceMenu.length ? { ...row, separator: true } : row));

      const startOrbitResize = (which: "aux" | "dock" | "bottom", event: React.PointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        const startX = event.clientX;
        const startY = event.clientY;
        const centre = orbitShowChat ? ORBIT_CHAT_MIN : 0;
        const startAux = fitted.aux;
        const startDock = fitted.dock;
        const startBottom = bottomSize;
        const auxMax = shellSize.w - centre - (orbitShowDock ? fitted.dock : 0);
        const dockMax = Math.min(ORBIT_DOCK_MAX, shellSize.w - centre - (orbitShowAux ? fitted.aux : 0));
        const bottomMax = shellSize.h - ORBIT_BOTTOM_RESERVE;
        setOrbitResizing(which);
        document.body.classList.add("grove-resizing");
        const onMove = (e: PointerEvent) => {
          if (which === "aux") setAuxWidth(clampWidth(startAux + e.clientX - startX, ORBIT_SIDE_MIN, Math.max(ORBIT_SIDE_MIN, auxMax)));
          else if (which === "dock") setInfoWidth(clampWidth(startDock + startX - e.clientX, ORBIT_SIDE_MIN, Math.max(ORBIT_SIDE_MIN, dockMax)));
          else setBottomHeight(clampWidth(startBottom + startY - e.clientY, ORBIT_BOTTOM_MIN, Math.max(ORBIT_BOTTOM_MIN, bottomMax)));
        };
        const onUp = () => {
          document.body.classList.remove("grove-resizing");
          setOrbitResizing(null);
          document.removeEventListener("pointermove", onMove);
          document.removeEventListener("pointerup", onUp);
        };
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
      };

      const bar = (
        <OrbitWorkspaceBar
          title={task.name}
          branch={task.branch || undefined}
          state={state.isChatBusy ? "working" : task.status === "archived" ? "archived" : undefined}
          leading={toolbarLeading}
          groups={[
            agentTool ? [agentTool] : [],
            dockPanels.map(toolFor),
            [
              ...leftPanels.map(toolFor),
              ...(terminalPanel ? [toolFor(terminalPanel)] : []),
            ],
          ]}
          trailing={toolbarTrailing}
          menu={[...workspaceMenu, ...toolbarRows]}
        />
      );

      return (
        <div className="ide-workbench is-orbit is-orbit-desk">
          {orbitToolbarTarget && createPortal(bar, orbitToolbarTarget)}
          <div ref={shellRef} className="ows-shell orbit-ui">
            <div className="ows-main">
              <div className="ows-row">
                <OrbitDock open={orbitShowAux} axis="x" size={auxSize} resizing={orbitResizing === "aux" || !shellSize.w} className="is-left">
                  <div
                    className="ows-pane"
                    onFocusCapture={() => { lastFocusedSideRef.current = "aux"; lastSurfaceRef.current = "aux"; }}
                    onMouseDownCapture={() => { lastFocusedSideRef.current = "aux"; lastSurfaceRef.current = "aux"; }}
                  >
                    {state.visitedAux.filter((type) => slotOf(type) === "aux").map((type) => (
                      <div key={type} className="ows-pane" style={{ display: state.auxType === type ? "flex" : "none" }}>
                        {type === "terminal"
                          ? orbitTerminal(() => update({ auxVisible: false, chatVisible: true }))
                          : renderOrbitPanel(type, buildCtx(() => update({ auxVisible: false, chatVisible: true })))}
                      </div>
                    ))}
                  </div>
                </OrbitDock>
                {orbitShowAux && orbitShowChat && (
                  <OrbitGrip axis="x" label="Resize panel" onPointerDown={(e) => startOrbitResize("aux", e)} onDoubleClick={() => setAuxWidth(ORBIT_AUX_DEFAULT)} />
                )}
                <div
                  className="ide-chat-surface"
                  style={{ display: orbitShowChat ? "block" : "none" }}
                  onFocusCapture={() => { lastSurfaceRef.current = "chat"; }}
                  onMouseDownCapture={() => { lastSurfaceRef.current = "chat"; }}
                >
                  {renderChat()}
                </div>
              </div>
              {orbitShowBottom && (
                <OrbitGrip axis="y" label="Resize terminal" onPointerDown={(e) => startOrbitResize("bottom", e)} onDoubleClick={() => setBottomHeight(ORBIT_BOTTOM_DEFAULT)} />
              )}
              <OrbitDock open={orbitShowBottom} axis="y" size={bottomSize} resizing={orbitResizing === "bottom" || !shellSize.h} className="is-bottom">
                <div
                  className="ows-pane"
                  onFocusCapture={() => { lastFocusedSideRef.current = "bottom"; }}
                  onMouseDownCapture={() => { lastFocusedSideRef.current = "bottom"; }}
                >
                  {state.visitedBottom && terminalAvailable && terminalPosition === "bottom" && (
                    orbitTerminal(() => update({ bottomVisible: false }))
                  )}
                </div>
              </OrbitDock>
            </div>
            {orbitShowDock && (
              <OrbitGrip axis="x" label="Resize dock" onPointerDown={(e) => startOrbitResize("dock", e)} onDoubleClick={() => setInfoWidth(ORBIT_DOCK_DEFAULT)} />
            )}
            <OrbitDock open={orbitShowDock} axis="x" size={fitted.dock} resizing={orbitResizing === "dock" || !shellSize.w} className="is-right">
              <div
                className="ows-pane"
                onFocusCapture={() => { lastFocusedSideRef.current = "info"; lastSurfaceRef.current = "info"; }}
                onMouseDownCapture={() => { lastFocusedSideRef.current = "info"; lastSurfaceRef.current = "info"; }}
              >
                {state.visitedInfo.map((type) => (
                  <div key={type} className="ows-pane" style={{ display: state.infoType === type ? "flex" : "none" }}>
                    {renderOrbitPanel(type, buildCtx(() => update({ infoVisible: false })))}
                  </div>
                ))}
              </div>
            </OrbitDock>
          </div>
        </div>
      );
    }

    return (
      <div className={`ide-workbench${orbitLayout ? " is-orbit" : ""}${orbitPhone ? " is-phone" : ""}${isMobile ? " is-stacked" : ""}`}>
        {/* In Orbit the toolbar lives in the window header; a hidden page renders none. */}
        {orbitLayout ? orbitToolbarTarget && createPortal(orbitPhone ? phonePanels : toolbar, orbitToolbarTarget) : toolbar}
        <div
          ref={shellRef}
          className="ide-layout"
          style={{
            gridTemplateColumns: gridColumns,
          } as React.CSSProperties}
        >
          {state.visitedAux.length > 0 && (
            <div
              className="ide-aux-host"
              style={{ display: showAux ? "flex" : "none" }}
              onFocusCapture={() => { lastFocusedSideRef.current = "aux"; lastSurfaceRef.current = "aux"; }}
              onMouseDownCapture={() => { lastFocusedSideRef.current = "aux"; lastSurfaceRef.current = "aux"; }}
            >
              {state.visitedAux.map((type) => {
                const isActive = state.auxType === type;
                return (
                  <div
                    key={type}
                    className="ide-aux-pane"
                    style={{ display: isActive ? "flex" : "none" }}
                  >
                    {renderAuxContent(type)}
                  </div>
                );
              })}
            </div>
          )}
          {showAux && (showChat || showInfo) && (
            <div className="ide-resizer ide-resizer--aux" onPointerDown={(event) => startResize("aux", event)} />
          )}
          <div
            className="ide-chat-surface"
            style={{ display: showChat ? "block" : "none" }}
            onFocusCapture={() => { lastSurfaceRef.current = "chat"; }}
            onMouseDownCapture={() => { lastSurfaceRef.current = "chat"; }}
          >
            {renderChat()}
          </div>
          {showChat && showInfo && (
            <div className="ide-resizer ide-resizer--info" onPointerDown={(event) => startResize("info", event)} />
          )}
          {state.visitedInfo.length > 0 && (
            <div
              className="ide-info-host"
              style={{ display: showInfo ? "flex" : "none" }}
              onFocusCapture={() => { lastFocusedSideRef.current = "info"; lastSurfaceRef.current = "info"; }}
              onMouseDownCapture={() => { lastFocusedSideRef.current = "info"; lastSurfaceRef.current = "info"; }}
            >
              {state.visitedInfo.map((type) => {
                const isActive = state.infoType === type;
                return (
                  <div
                    key={type}
                    className="ide-info-pane"
                    style={{ display: isActive ? "flex" : "none" }}
                  >
                    {renderInfoContent(type)}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  },
);
