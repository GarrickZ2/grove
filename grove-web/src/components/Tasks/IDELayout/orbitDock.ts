// Orbit desktop workspace: where each panel docks and how toolbar toggles
// change the layout state. Pure, so the IDE container and tests share it.
//
//   aux    — left of the Agent (Review, Editor, Artifacts, Sketch, left plugins)
//   dock   — the right dock, one panel at a time (Info, Git, Notes, Comments,
//            Agent graph, right plugins)
//   bottom — the terminal, docked under the Agent. A setting can move it to
//            the left column instead, where it takes turns with the other
//            left panels.
//
// Workbench (and Orbit on a phone) keep the classic three columns.

import type { PanelCategory } from "../PanelSystem/panelRegistry";

export type OrbitSlot = "aux" | "dock" | "bottom";

/** Where the terminal docks; the `web.terminal_position` setting. */
export type TerminalPosition = "bottom" | "left";

export function terminalPositionOf(value: string | undefined): TerminalPosition {
  return value === "left" ? "left" : "bottom";
}

export function orbitSlotFor(key: string, category: PanelCategory, terminal: TerminalPosition = "bottom"): OrbitSlot {
  if (key === "terminal") return terminal === "left" ? "aux" : "bottom";
  if (key === "graph") return "dock";
  return category === "info" ? "dock" : "aux";
}

/** The slice of IDE layout state the Orbit toggles touch. */
export interface OrbitDockState {
  auxType: string | null;
  auxVisible: boolean;
  chatVisible: boolean;
  infoType: string | null;
  infoVisible: boolean;
  bottomVisible: boolean;
}

export function isOrbitPanelOpen(state: OrbitDockState, key: string, slot: OrbitSlot): boolean {
  if (slot === "bottom") return state.bottomVisible;
  if (slot === "dock") return state.infoVisible && state.infoType === key;
  return state.auxVisible && state.auxType === key;
}

/** Toolbar / shortcut toggle: opens the panel in its slot, or closes it if it is the one showing. */
export function toggleOrbitPanel<S extends OrbitDockState>(state: S, key: string, slot: OrbitSlot): S {
  const open = isOrbitPanelOpen(state, key, slot);
  if (slot === "bottom") return { ...state, bottomVisible: !open };
  if (slot === "dock") return open ? { ...state, infoVisible: false } : { ...state, infoType: key, infoVisible: true };
  // Closing the left panel brings the Agent back: the centre is never empty.
  return open
    ? { ...state, auxVisible: false, chatVisible: true }
    : { ...state, auxType: key, auxVisible: true };
}

/** Opens (never closes) the panel in its slot. */
export function openOrbitPanel<S extends OrbitDockState>(state: S, key: string, slot: OrbitSlot): S {
  return isOrbitPanelOpen(state, key, slot) ? state : toggleOrbitPanel(state, key, slot);
}

/** Layout state moved to the Orbit slots: what Workbench saved (terminal / graph
 *  in the left column), or an open terminal when its position setting changed. */
export function migrateToOrbitSlots<S extends OrbitDockState>(state: S, terminal: TerminalPosition = "bottom"): S {
  if (terminal === "left") {
    if (state.bottomVisible && !(state.auxVisible && state.auxType)) return { ...state, bottomVisible: false, auxType: "terminal", auxVisible: true };
    if (state.auxType === "terminal") return state;
  } else if (state.auxType === "terminal") {
    return { ...state, auxType: null, auxVisible: false, bottomVisible: state.bottomVisible || state.auxVisible };
  }
  if (state.auxType === "graph") {
    const showGraph = state.auxVisible;
    return {
      ...state,
      auxType: null,
      auxVisible: false,
      ...(showGraph ? { infoType: "graph", infoVisible: true } : {}),
    };
  }
  return state;
}

export const ORBIT_CHAT_MIN = 420;
export const ORBIT_SIDE_MIN = 280;
export const ORBIT_DOCK_MAX = 760;
export const ORBIT_BOTTOM_MIN = 140;
/** Room the Agent keeps above the terminal. */
export const ORBIT_BOTTOM_RESERVE = 220;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(min, max), Math.max(min, value));

/** Widths that fit the shell: the Agent keeps ORBIT_CHAT_MIN while it is shown. */
export function fitOrbitWidths(
  shellWidth: number,
  wanted: { aux: number; dock: number },
  shown: { aux: boolean; dock: boolean; chat: boolean },
): { aux: number; dock: number } {
  if (shellWidth <= 0) return wanted;
  const centre = shown.chat ? ORBIT_CHAT_MIN : 0;
  const dock = shown.dock
    ? clamp(wanted.dock, ORBIT_SIDE_MIN, Math.min(ORBIT_DOCK_MAX, shellWidth - centre - (shown.aux ? ORBIT_SIDE_MIN : 0)))
    : clamp(wanted.dock, ORBIT_SIDE_MIN, ORBIT_DOCK_MAX);
  const aux = clamp(wanted.aux, ORBIT_SIDE_MIN, shellWidth - centre - (shown.dock ? dock : 0));
  return { aux, dock };
}

export function fitOrbitBottom(shellHeight: number, wanted: number): number {
  if (shellHeight <= 0) return wanted;
  return clamp(wanted, ORBIT_BOTTOM_MIN, shellHeight - ORBIT_BOTTOM_RESERVE);
}

/** Orbit: the Agent can only be hidden behind an open left panel — never leave the centre empty. */
export function withAgentRule<S extends Pick<OrbitDockState, "auxType" | "auxVisible" | "chatVisible">>(state: S): S {
  return state.chatVisible || (state.auxVisible && state.auxType) ? state : { ...state, chatVisible: true };
}

export type SurfaceVisibility = Pick<OrbitDockState, "auxType" | "auxVisible" | "chatVisible" | "infoVisible">;

/**
 * What the layout saves. While the window is stacked (narrow), surfaces are
 * collapsed to one automatically — that is not the user's choice, so the
 * last desktop arrangement is saved instead. In Orbit the Agent rule applies.
 */
export function visibilityToPersist(
  current: SurfaceVisibility,
  lastDesktop: SurfaceVisibility,
  stacked: boolean,
  orbit: boolean,
): SurfaceVisibility {
  const v = stacked ? lastDesktop : current;
  return orbit ? withAgentRule(v) : v;
}
