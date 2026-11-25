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
import { LaptopBenchContext, type LaptopBench } from "./LaptopBenchContext";
import { OrbitFoldPanelPicker, OrbitLaptopStrip, OrbitPhonePanels, type OrbitPhonePanel } from "./OrbitPhonePanels";
import { ORBIT_FOLD_MENU_EVENT, useBookFold, useLaptopFold } from "../../../hooks/useBookFold";
import { newSessionEnd, useNewSession } from "../../Orbit/newSessionDrafts";
import { OrbitWorkspaceBar, OrbitDock, OrbitGrip, OrbitFoldDeck, type OrbitToolItem } from "./OrbitWorkspace";
import { useSlotElement } from "./useSlotElement";
import { ORBIT_DUO_RAIL_SLOT, rightInset, useDuoRail } from "../../../hooks/useDuoRail";
import { OrbitDuoRailTools } from "../../Layout/OrbitDuoRail";
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
import { OPEN_DESIGN_EVENT, type OpenDesignDetail } from "../../Studio/DesignPage/designModel";
import { OPEN_BROWSER_EVENT, type OpenBrowserDetail } from "../../../api/browser";
import { useOpenReviewRequests, type OpenReviewRequest } from "../../../orbit/workspace/openReview";
import { useConfig, useProject } from "../../../context";
import { usePanelOrder } from "../PanelSystem/usePanelOrder";
import { useIsMobile } from "../../../hooks";
import { useLinkedReviewProjects } from "../../../hooks/useLinkedReviewProjects";
import { apiClient } from "../../../api/client";
import { studioArtifactResolves } from "../TaskInfoPanel/tabs/artifactsModel";
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
  panelShortLabel,
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

type SplitMode = "split" | "chat" | "panel";
const SPLIT_MODE_KEY = "grove:phone-split-mode";
const WIDE_SCREEN_QUERY = "(min-width: 760px)";
const SPLIT_RATIO_KEY = "grove:phone-split-ratio";
/** Each side keeps room for its own controls. */
const SPLIT_PANE_MIN = 320;
const clampSplit = (ratio: number, width = 0) => {
  const min = Math.min(.5, Math.max(.3, width ? SPLIT_PANE_MIN / width : 0));
  return Math.min(1 - min, Math.max(min, ratio));
};
function readSplitRatio(): number {
  try {
    const value = Number(localStorage.getItem(SPLIT_RATIO_KEY));
    if (value > 0 && value < 1) return clampSplit(value);
  } catch { /* private mode */ }
  return .5;
}
function readSplitMode(): SplitMode {
  try {
    const value = localStorage.getItem(SPLIT_MODE_KEY);
    if (value === "chat" || value === "panel") return value;
  } catch { /* private mode */ }
  return "split";
}
function subscribeWideScreen(onChange: () => void) {
  const query = window.matchMedia(WIDE_SCREEN_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
function readWideScreen() {
  return window.matchMedia(WIDE_SCREEN_QUERY).matches;
}

export const IDELayoutContainer = forwardRef<IDELayoutHandle, IDELayoutContainerProps>(
  function IDELayoutContainer({ task, projectId, toolbarLeading, toolbarTrailing, phoneActions, isActive = true, toolbarMenu }, ref) {
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
    // A phone half-folded like a book keeps this desktop layout, split at the
    // crease. It has no room for a bottom dock, so the terminal takes the left
    // screen; the slot migration below moves it there and back.
    const bookFold = useBookFold();
    const foldable = orbitDesk ? bookFold : null;
    // Folded like a laptop: the Agent or a panel above, the toolbar and Composer below.
    const laptopFold = useLaptopFold();
    const foldLaptop = orbitDesk ? laptopFold : null;
    // The same folds on a touch screen, which always has the phone layout: two
    // panes split at the crease instead of one at a time.
    const phoneBook = orbitPhone ? bookFold : null;
    const phoneLaptop = orbitPhone ? laptopFold : null;
    // Laptop fold, no panel open: the place on the lower screen the chat fills with its workbench.
    const [benchSlot, setBenchSlot] = useState<HTMLElement | null>(null);
    const terminalPosition = foldable || foldLaptop ? "left" : terminalPositionOf(config?.web?.terminal_position);
    // iPhone Duo in the iOS app: the panel toggles go onto the rail beside the
    // screen and the header keeps the Session's title. Not on a laptop fold,
    // whose bottom deck holds them.
    const duoRail = useDuoRail();
    // A phone's panel button sits in the header, or in iPhone Duo's column when there is one.
    const orbitSlotId = orbitPhone ? (duoRail ? ORBIT_DUO_RAIL_SLOT : ORBIT_PHONE_ACTIONS_SLOT) : "orbit-workspace-toolbar";
    // The header slot can mount after this layout (config / page transitions):
    // keep resolving it until it exists.
    const orbitToolbarSlot = useSlotElement(orbitLayout ? orbitSlotId : null, isActive);
    const orbitToolbarTarget = orbitLayout && isActive ? orbitToolbarSlot : null;
    const duoRailSlot = useSlotElement(orbitDesk && duoRail ? ORBIT_DUO_RAIL_SLOT : null, isActive);
    const duoRailTarget = orbitDesk && duoRail && isActive && !foldLaptop ? duoRailSlot : null;
    const resizerWidth = orbitLayout ? 1 : RESIZER_PX;
    // Resolve the project this task actually belongs to by its projectId,
    // not the globally-selected project. Blitz lets the user open a task
    // from any project while sidebar still shows a different one; using
    // `selectedProject` here mis-classifies Studio tasks as Coding and
    // surfaces Code Review / Git / Comments tabs that don't apply.
    const taskProject = projects.find((p) => p.id === projectId) ?? selectedProject;
    const isStudio = taskProject?.projectType === "studio";
    const isGitRepo = taskProject?.isGitRepo;
    const linkedReviewProjects = useLinkedReviewProjects(projectId, task.id);
    const panelOrder = usePanelOrder(isStudio);

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
    // Where the shell starts on screen, to place the crease inside it.
    const [shellOrigin, setShellOrigin] = useState({ x: 0, y: 0 });
    const phoneFolded = !!phoneBook || !!phoneLaptop;
    /** A phone not folded shows the chat or one panel, never both. */
    const phoneSingle = orbitPhone && !phoneFolded;
    // iPhone Duo opened flat (or any touch screen this wide): a panel opens
    // beside the conversation. One switch picks split, chat only or panel
    // only, and is remembered.
    const wideScreen = useSyncExternalStore(subscribeWideScreen, readWideScreen, () => false);
    const phoneWide = phoneSingle && wideScreen;
    const [splitMode, setSplitModeState] = useState<SplitMode>(readSplitMode);
    const setSplitMode = useCallback((mode: SplitMode) => {
      setSplitModeState(mode);
      try { localStorage.setItem(SPLIT_MODE_KEY, mode); } catch { /* private mode */ }
    }, []);
    // Split view: the panel's share of the width, dragged at the divider and remembered.
    const [splitRatio, setSplitRatio] = useState(readSplitRatio);
    const applySplit = useCallback((wanted: number) => {
      const el = shellRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const ratio = clampSplit(wanted, rect.width);
      el.style.setProperty("--split-at", `${ratio * 100}%`);
      el.style.setProperty("--split-left", `${ratio}fr`);
      el.style.setProperty("--split-right", `${1 - ratio}fr`);
      // Where the conversation's column starts, for the header over it. Only the
      // page on screen says so: sessions kept alive behind it have splits too.
      const stage = el.closest(".orbit-phone-stage")?.getBoundingClientRect();
      if (rect.width > 0) document.documentElement.style.setProperty("--grove-split-x", `${Math.round(rect.left - (stage?.left ?? 0) + rect.width * ratio)}px`);
    }, []);
    const startSplitDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
      const el = shellRef.current;
      if (!el) return;
      event.preventDefault();
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      handle.classList.add("is-dragging");
      const rect = el.getBoundingClientRect();
      let ratio = splitRatio;
      const move = (e: PointerEvent) => {
        ratio = clampSplit((e.clientX - rect.left) / rect.width, rect.width);
        applySplit(ratio);
      };
      const end = () => {
        handle.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        handle.removeEventListener("lostpointercapture", end);
        handle.classList.remove("is-dragging");
        setSplitRatio(ratio);
        try { localStorage.setItem(SPLIT_RATIO_KEY, String(ratio)); } catch { /* private mode */ }
      };
      handle.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
      handle.addEventListener("lostpointercapture", end);
    }, [applySplit, splitRatio]);
    useLayoutEffect(() => {
      const el = shellRef.current;
      if (!phoneFolded || !el) return;
      const measure = () => {
        const rect = el.getBoundingClientRect();
        const x = Math.round(rect.left);
        const y = Math.round(rect.top);
        setShellOrigin((prev) => (prev.x === x && prev.y === y ? prev : { x, y }));
      };
      measure();
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      window.addEventListener("resize", measure);
      return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
    }, [phoneFolded]);
    // A book fold keeps the floating header over the Agent's screen.
    const bookLeft = phoneBook ? Math.max(0, phoneBook.left - shellOrigin.x) : null;
    const bookGap = phoneBook?.gap ?? 0;
    useEffect(() => {
      if (bookLeft === null || !isActive) return;
      const root = document.documentElement;
      root.style.setProperty("--grove-fold-left", `${bookLeft + bookGap}px`);
      return () => { root.style.removeProperty("--grove-fold-left"); };
    }, [bookLeft, bookGap, isActive]);
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
      // Orbit on a phone always comes back on the chat, as it opens. iOS can
      // report a wider window for a moment when the app is switched away and
      // back; the desktop arrangement restored meanwhile must not stick.
      if (orbitPhone) {
        setStateTagged((prev) => ({ ...prev, chatVisible: true, auxVisible: false, infoVisible: false }));
        return;
      }
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
        // The file server reaches more than the Artifacts panel lists; a
        // Studio link the panel can't open falls back to plain text.
        if (isStudio && !(await studioArtifactResolves(projectId, task.id, filePath))) return false;
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

    // A new Session starts on the composer alone; panels already open when it
    // starts from this workspace stay. What was put away comes back (and is
    // what gets saved) unless the new Session is sent.
    const writingNew = useNewSession(projectId, task.id) && orbitDesk;
    const putAwayRef = useRef<Pick<IDELayoutInternalState, "auxVisible" | "infoVisible" | "bottomVisible" | "chatVisible"> | null>(null);
    const wasWritingRef = useRef(false);
    const wasActiveRef = useRef(false);
    useLayoutEffect(() => {
      const started = writingNew && !wasWritingRef.current;
      const ended = !writingNew && wasWritingRef.current;
      const alreadyHere = wasActiveRef.current;
      wasWritingRef.current = writingNew;
      wasActiveRef.current = isActive;
      if (started) {
        const { auxVisible, infoVisible, bottomVisible, chatVisible } = stateRef.current;
        if (alreadyHere) {
          update({ chatVisible: true });
        } else {
          putAwayRef.current = { auxVisible, infoVisible, bottomVisible, chatVisible };
          update({ auxVisible: false, infoVisible: false, bottomVisible: false, chatVisible: true });
        }
      } else if (ended) {
        const putAway = putAwayRef.current;
        putAwayRef.current = null;
        if (putAway && newSessionEnd(projectId, task.id) === "left") update(putAway);
      }
    }, [writingNew, isActive, projectId, task.id, update]);

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
          return { ...prev, auxType: "sketch", auxVisible: true, ...(phoneSingle ? { chatVisible: false, infoVisible: false } : {}) };
        });
      };
      window.addEventListener(OPEN_SKETCH_EVENT, handler);
      return () => window.removeEventListener(OPEN_SKETCH_EVENT, handler);
    }, [isStudio, projectId, task.id, setStateTagged, phoneSingle]);

    // Likewise for a design:// chip and the Design panel; the panel itself
    // picks which design and page to show.
    useEffect(() => {
      if (!isStudio) return;
      const handler = (e: Event) => {
        const detail = (e as CustomEvent<OpenDesignDetail>).detail;
        if (!detail || detail.projectId !== projectId || detail.taskId !== task.id) return;
        setStateTagged((prev) => {
          if (prev.auxVisible && prev.auxType === "design" && !(phoneSingle && prev.chatVisible)) return prev;
          // The phone shows one thing at a time: the design replaces the chat.
          return { ...prev, auxType: "design", auxVisible: true, ...(phoneSingle ? { chatVisible: false, infoVisible: false } : {}) };
        });
      };
      window.addEventListener(OPEN_DESIGN_EVENT, handler);
      return () => window.removeEventListener(OPEN_DESIGN_EVENT, handler);
    }, [isStudio, projectId, task.id, setStateTagged, phoneSingle]);

    // An agent started using the browser: show it unless another panel is open.
    useEffect(() => {
      const handler = (e: Event) => {
        const detail = (e as CustomEvent<OpenBrowserDetail>).detail;
        if (detail?.projectId !== projectId || detail.taskId !== task.id) return;
        setStateTagged((prev) => (prev.auxVisible ? prev : { ...prev, auxType: "browser", auxVisible: true }));
      };
      window.addEventListener(OPEN_BROWSER_EVENT, handler);
      return () => window.removeEventListener(OPEN_BROWSER_EVENT, handler);
    }, [projectId, task.id, setStateTagged]);

    useEffect(() => {
      const handler = (e: Event) => {
        const detail = (e as CustomEvent<{ chatId?: string }>).detail;
        // The phone shows one thing at a time (a fold shows a panel beside
        // the chat): unfolded, the chat replaces the panel that opened it.
        update(orbitPhone && !phoneFolded ? { chatVisible: true, auxVisible: false, infoVisible: false } : { chatVisible: true });
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
    }, [update, orbitPhone, phoneFolded]);

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
    // and on the event (this workspace was already showing).
    const openReviewPanel = useCallback((request: OpenReviewRequest) => {
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
    }, [isStudio, isGitRepo, isMobile, setStateTagged, handleNavigateToFile]);

    useOpenReviewRequests(projectId, task.id, true, openReviewPanel);

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
        document.removeEventListener("pointercancel", handlePointerUp);
      };

      document.addEventListener("pointermove", handlePointerMove);
      document.addEventListener("pointerup", handlePointerUp);
      // A touch the system takes over ends in pointercancel, not pointerup.
      document.addEventListener("pointercancel", handlePointerUp);
    }, [auxWidth, infoWidth, resizerWidth]);

    // Persist layout state whenever relevant fields change
    useEffect(() => {
      const current: SurfaceVisibility = {
        auxType: state.auxType, auxVisible: state.auxVisible, chatVisible: state.chatVisible, infoVisible: state.infoVisible,
      };
      const putAway = putAwayRef.current;
      if (putAway) Object.assign(current, { auxVisible: putAway.auxVisible, infoVisible: putAway.infoVisible, chatVisible: putAway.chatVisible });
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
        bottomVisible: putAway ? putAway.bottomVisible : state.bottomVisible,
        bottomHeight: Math.round(bottomHeight),
      });
    }, [
      projectId, task.id,
      state.auxType, state.auxVisible, state.chatVisible,
      state.infoType, state.infoVisible,
      state.terminalTabs, state.terminalActiveId,
      auxWidth, infoWidth, state.bottomVisible, bottomHeight, isMobile, orbitLayout, writingNew,
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
            (type !== "design" || isStudio) &&
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
      [isStudio, terminalAvailable, setStateTagged, isMobile, orbitDesk, terminalPosition, slotOf],
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
          onClose={orbitPhone ? undefined : () => update({ auxVisible: false })}
        />
      ),
      plugins: panelPlugins,
      linkedReviewProjects,
    }), [projectId, task, isStudio, isGitRepo, terminalAvailable, orbitLayout, isActive, state.fileNavRequest, state.artifactPreviewRequest, state.lastChatIdleAt, state.isChatBusy, handleChatBecameIdle, handleBusyStateChange, state.terminalTabs, state.terminalActiveId, update, panelPlugins, linkedReviewProjects, orbitPhone]);

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
          onClose={orbitPhone ? undefined : closeAux}
        >
          {renderPanel(type, buildCtx(closeAux))}
        </PanelSlot>
      );
    }, [buildCtx, panelPlugins, update, orbitPhone]);

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
          onClose={orbitPhone ? undefined : closeInfo}
        >
          <div className="ide-info-content">{renderPanel(type, buildCtx(closeInfo))}</div>
        </PanelSlot>
      );
    }, [buildCtx, panelPlugins, update, orbitPhone]);

    const panelAux = Boolean(state.auxVisible && state.auxType);
    const panelInfo = Boolean(state.infoVisible && state.infoType);
    const wideSplit = phoneWide && (panelAux || panelInfo);
    const showAux = panelAux && !(wideSplit && splitMode === "chat");
    const showInfo = panelInfo && !(wideSplit && splitMode === "chat");
    const showChat = wideSplit ? splitMode !== "panel" : state.chatVisible || (!showAux && !showInfo);
    const splitOn = wideSplit && showChat && (showAux || showInfo);
    useLayoutEffect(() => {
      if (!splitOn || !isActive) return;
      applySplit(splitRatio);
      const el = shellRef.current;
      if (!el) return;
      const ro = new ResizeObserver(() => applySplit(splitRatio));
      ro.observe(el);
      return () => ro.disconnect();
    }, [splitOn, isActive, splitRatio, applySplit]);
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
    const catalog = buildPanelCatalog(panelPlugins, { isStudio, terminalAvailable });
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

    const phonePanelList: OrbitPhonePanel[] = panelOrder
      .order([...auxPanels, ...infoPanels])
      .map((d) => ({ d, kind: d.category === "info" ? "info" : "aux" }));
    const phoneOpenPanel = phonePanelList.find((panel) => panel.kind === "aux"
      ? state.auxVisible && state.auxType === panel.d.key
      : state.infoVisible && state.infoType === panel.d.key) ?? null;
    // Same mutually-exclusive switching the mobile toolbar does.
    const openPhonePanel = (panel: OrbitPhonePanel) => update(panel.kind === "aux"
      ? { auxType: panel.d.key, auxVisible: true, chatVisible: false, infoVisible: false }
      : { infoType: panel.d.key, infoVisible: true, chatVisible: false, auxVisible: false });
    const phonePanels = (
      <OrbitPhonePanels
        panels={phonePanelList}
        openPanel={phoneOpenPanel}
        actions={phoneActions}
        onShowChat={() => update({ chatVisible: true, auxVisible: false, infoVisible: false })}
        onOpen={openPhonePanel}
        compact={orbitPhone && duoRail}
        layout={wideSplit ? { mode: splitMode, onChange: setSplitMode } : undefined}
      />
    );

    if (orbitDesk) {
      const dockable = panelOrder.order(catalog.filter((d) => d.category !== "chat"));
      const toolFor = (d: PanelDescriptor): OrbitToolItem => {
        const slot = slotOf(d.key);
        return {
          key: d.key,
          label: d.label,
          name: panelShortLabel(d),
          icon: panelGlyph(d, true),
          shortcut: panelShortcutDisplay(d.key),
          active: (foldBook || foldLaptop) && slot === "dock" ? orbitShowDock && state.infoType === d.key : isOrbitPanelOpen(state, d.key, slot),
          onToggle: () => {
            if (slot === "bottom") lastFocusedSideRef.current = "bottom";
            // Beside the Agent a book fold has one screen for panels, so the
            // panel just asked for takes it.
            const oneScreen = foldLaptop || (foldBook && state.chatVisible);
            if (oneScreen && slot === "dock" && !(orbitShowDock && state.infoType === d.key)) {
              update({ infoType: d.key, infoVisible: true, auxVisible: false });
              return;
            }
            if (oneScreen && slot === "aux" && orbitShowDock && !orbitShowAux) {
              update({ auxType: d.key, auxVisible: true, infoVisible: false });
              return;
            }
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
      // With the sidebar open the workspace no longer starts at the screen's
      // edge, so the crease means nothing to it: back to the plain layout.
      // Spans the page (sidebar closed); the page itself stops short of iPhone Duo's column.
      const foldBook = foldable && shellSize.w >= window.innerWidth - rightInset() - 1 ? foldable : null;
      // Two screens show two of the three: the Agent keeps its place if it was
      // open, and the hidden dock returns when the phone flattens.
      const orbitShowDock = Boolean(state.infoVisible && state.infoType)
        && !(foldBook && orbitShowAux && state.chatVisible)
        && !(foldLaptop && orbitShowAux);
      // The Composer lives in the Agent's surface, so a laptop fold always keeps it; a panel covers the transcript.
      const orbitShowChat = !!foldLaptop || writingNew || state.chatVisible || !orbitShowAux;
      // Panels on the left screen, the Agent on the right, as with a left panel.
      const foldDockLeft = !!foldBook && orbitShowDock && !orbitShowAux;
      const foldPicker = !!foldBook && !orbitShowAux && !orbitShowDock;
      const orbitShowBottom = terminalPosition === "bottom" && state.bottomVisible && terminalAvailable;
      const chatDescriptor = getPanelDescriptor("chat");
      // The Agent leads the strip. It can only be hidden behind a left panel,
      // so without one it reads as on and does nothing.
      const agentTool: OrbitToolItem | null = chatDescriptor && !writingNew ? {
        key: "chat",
        label: "Agent",
        tip: foldLaptop ? "Agent" : !orbitShowAux ? "Agent · open a left panel to hide it" : orbitShowChat ? "Hide Agent" : "Show Agent",
        icon: panelGlyph(chatDescriptor, true),
        shortcut: panelShortcutDisplay("chat"),
        active: foldLaptop ? !orbitShowAux && !orbitShowDock : orbitShowChat,
        disabled: foldLaptop ? false : !orbitShowAux,
        primary: true,
        onToggle: () => update(foldLaptop ? { auxVisible: false, infoVisible: false, chatVisible: true } : { chatVisible: !orbitShowChat }),
      } : null;
      const fitted = fitOrbitWidths(shellSize.w, { aux: auxWidth, dock: infoWidth }, { aux: orbitShowAux, dock: orbitShowDock, chat: orbitShowChat });
      // With the Agent hidden the left panel takes the whole centre.
      const auxSize = foldBook
        ? foldBook.left
        : orbitShowChat ? fitted.aux : Math.max(ORBIT_SIDE_MIN, shellSize.w - (orbitShowDock ? fitted.dock : 0));
      const dockSize = foldBook
        ? (foldDockLeft ? foldBook.left : shellSize.w - foldBook.left)
        : fitted.dock;
      const bottomSize = fitOrbitBottom(shellSize.h, bottomHeight);

      // Workspace-level rows live in the toolbar's ⋯, never in a panel's.
      const workspaceMenu: PanelMenuItem[] = [
        ...(orbitShowAux && !writingNew
          ? [orbitShowChat
            ? { id: "hide-agent", label: "Hide Agent", icon: PanelLeftOpen, onSelect: () => update({ chatVisible: false }) }
            : { id: "show-agent", label: "Show Agent", icon: PanelLeftClose, onSelect: () => update({ chatVisible: true }) }]
          : []),
      ];
      const toolbarRows = (writingNew ? [] : toolbarMenu ?? []).map((row, i) => (i === 0 && workspaceMenu.length ? { ...row, separator: true } : row));

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
          document.removeEventListener("pointercancel", onUp);
        };
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
        // A touch the system takes over ends in pointercancel, not pointerup.
        document.addEventListener("pointercancel", onUp);
      };

      const foldPickerPanels: OrbitPhonePanel[] = dockable.filter((d) => slotOf(d.key) !== "bottom").map((d) => ({ d, kind: slotOf(d.key) === "aux" ? "aux" : "info" }));
      const openFoldPanel = ({ d, kind }: OrbitPhonePanel) => update(kind === "aux"
        ? { auxType: d.key, auxVisible: true }
        : { infoType: d.key, infoVisible: true });

      const agentGroup = agentTool ? [agentTool] : [];
      const { shown, more } = panelOrder.split(dockable);
      const bar = (
        <OrbitWorkspaceBar
          title={writingNew ? undefined : task.name}
          branch={writingNew ? undefined : task.branch || undefined}
          state={writingNew ? undefined : state.isChatBusy ? "working" : task.status === "archived" ? "archived" : undefined}
          leading={toolbarLeading}
          groups={duoRailTarget ? [] : [agentGroup, shown.map(toolFor)]}
          more={duoRailTarget ? [] : panelOrder.group(more).map((group) => group.map(toolFor))}
          onMove={(move) => panelOrder.move(dockable.map((d) => d.key), move)}
          trailing={writingNew ? undefined : toolbarTrailing}
          menu={[...workspaceMenu, ...toolbarRows]}
          foldRight={foldBook ? shellSize.w - foldBook.left : undefined}
          quiet={writingNew}
        />
      );

      return (
        <div className="ide-workbench is-orbit is-orbit-desk">
          {orbitToolbarTarget && !foldLaptop && createPortal(bar, orbitToolbarTarget)}
          {duoRailTarget && createPortal(<OrbitDuoRailTools groups={[agentGroup, dockable.map(toolFor)]} />, duoRailTarget)}
          <div
            ref={shellRef}
            className={`ows-shell orbit-ui${foldBook ? " is-fold" : ""}${writingNew && !foldBook && !foldLaptop ? " is-new" : ""}${foldDockLeft ? " is-fold-dock-left" : ""}${foldLaptop ? " is-fold-laptop" : ""}`}
            style={foldLaptop ? ({ "--fold-top": `${foldLaptop.top + foldLaptop.gap}px` } as React.CSSProperties) : undefined}
          >
            {foldLaptop && (
              <OrbitFoldDeck
                title={task.name}
                branch={task.branch || undefined}
                state={state.isChatBusy ? "working" : undefined}
                tools={[
                  ...(agentTool ? [agentTool] : []),
                  ...dockable.map(toolFor),
                ]}
                menu={[...workspaceMenu.filter((item) => item.id !== "hide-agent" && item.id !== "show-agent"), ...toolbarRows]}
                onOpenSidebar={() => window.dispatchEvent(new Event(ORBIT_FOLD_MENU_EVENT))}
              />
            )}
            <div className="ows-main">
              <div className="ows-row">
                <OrbitDock open={orbitShowAux || foldPicker} axis="x" size={auxSize} resizing={orbitResizing === "aux" || !shellSize.w} className="is-left">
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
                    {foldPicker && <OrbitFoldPanelPicker panels={foldPickerPanels} onOpen={openFoldPanel} />}
                  </div>
                </OrbitDock>
                {orbitShowAux && orbitShowChat && !foldBook && !foldLaptop && (
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
            {orbitShowDock && !foldBook && !foldLaptop && (
              <OrbitGrip axis="x" label="Resize dock" onPointerDown={(e) => startOrbitResize("dock", e)} onDoubleClick={() => setInfoWidth(ORBIT_DOCK_DEFAULT)} />
            )}
            <OrbitDock open={orbitShowDock} axis="x" size={dockSize} resizing={orbitResizing === "dock" || !shellSize.w} className="is-right">
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

    const laptopBench: LaptopBench | null = phoneLaptop && benchSlot && !showAux && !showInfo
      ? { slot: benchSlot, projectId, taskId: task.id, branch: task.branch, actions: phoneActions ?? [] }
      : null;

    return (
      <LaptopBenchContext.Provider value={laptopBench}>
      <div
        className={`ide-workbench${orbitLayout ? " is-orbit" : ""}${orbitPhone ? " is-phone" : ""}${orbitPhone && duoRail ? " is-rail" : ""}${isMobile ? " is-stacked" : ""}${phoneBook ? " is-fold-book" : ""}${phoneLaptop ? " is-fold-laptop" : ""}${phoneLaptop && !showAux && !showInfo ? " is-laptop-idle" : ""}${splitOn ? " is-split" : ""}${isActive ? " is-shown" : ""}`}
        style={phoneBook
          ? ({ "--fold-left": `${Math.max(0, phoneBook.left - shellOrigin.x)}px`, "--fold-gap": `${phoneBook.gap}px` } as React.CSSProperties)
          : phoneLaptop
            ? ({ "--fold-top": `${Math.max(0, phoneLaptop.top - shellOrigin.y)}px`, "--fold-gap": `${phoneLaptop.gap}px`, "--fold-deck-top": `${phoneLaptop.top + phoneLaptop.gap}px` } as React.CSSProperties)
            : undefined}
      >
        {/* In Orbit the toolbar lives in the window header; a hidden page renders none. */}
        {/* Laptop fold: the panels live in the lower screen's work bar, not the header. */}
        {orbitLayout ? orbitToolbarTarget && createPortal(orbitPhone ? (phoneLaptop ? null : phonePanels) : toolbar, orbitToolbarTarget) : toolbar}
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
          {/* A fold's panel screen while no panel is open: pick one for it. */}
          {phoneBook && !showAux && !showInfo && <OrbitFoldPanelPicker panels={phonePanelList} onOpen={openPhonePanel} />}
          {phoneLaptop && (
            <OrbitLaptopStrip
              panels={phonePanelList}
              openPanel={phoneOpenPanel}
              onOpen={openPhonePanel}
              onClose={() => update({ chatVisible: true, auxVisible: false, infoVisible: false })}
              actions={phoneActions}
            />
          )}
          {phoneLaptop && !showAux && !showInfo && <div ref={setBenchSlot} className="orbit-laptop-bench" />}
          {splitOn && (
            <div className="orbit-split-handle" data-no-swipe="" role="separator" aria-orientation="vertical" aria-label="Resize" onPointerDown={startSplitDrag}>
              <i />
            </div>
          )}
          <div
            className="ide-chat-surface"
            style={{ display: showChat || phoneFolded ? "block" : "none" }}
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
      </LaptopBenchContext.Provider>
    );
  },
);
