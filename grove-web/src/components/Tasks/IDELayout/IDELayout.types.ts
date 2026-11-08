import type { Task } from "../../../data/types";
import type { OrbitPhoneAction } from "./OrbitPhonePanels";
import type { PanelMenuItem } from "../../../orbit/ui";

// ── Layout Mode ──
export type LayoutMode = "flex" | "ide";

// ── Panel Categories ──
export type AuxPanelType = "terminal" | "editor" | "review" | "graph" | "artifacts" | "sketch" | "browser";
export type InfoTabType = "stats" | "git" | "notes" | "comments";
export const AUX_PANEL_TYPES: AuxPanelType[] = ["terminal", "editor", "review", "graph", "artifacts", "sketch", "browser"];
export const INFO_PANEL_TYPES: InfoTabType[] = ["stats", "git", "notes", "comments"];

export interface ArtifactPreviewRequest {
  file: string;
  seq: number;
}

// ── Component Props ──
export interface IDELayoutContainerProps {
  task: Task;
  projectId: string;
  toolbarLeading?: React.ReactNode;
  toolbarTrailing?: React.ReactNode;
  /** Orbit on a phone: the workspace actions, listed in the panel sheet. */
  phoneActions?: OrbitPhoneAction[];
  isActive?: boolean;
  /** Flip the workspace between this layout and the free (FlexLayout) one. */
  onToggleLayoutMode?: () => void;
  /** Orbit: extra rows for the toolbar's ⋯ (git overflow actions). */
  toolbarMenu?: PanelMenuItem[];
}

export interface IDELayoutHandle {
  focusPanel: (type: AuxPanelType) => void;
  focusAuxPanel: (type: AuxPanelType) => void;
  focusInfoPanel: (type: InfoTabType) => void;
  focusChat: () => void;
  /** Show Chat without toggling; other open panels stay as they are. */
  showChat: () => void;
  selectTabByIndex: (index: number) => "handled" | "no_tabs" | "out_of_range";
  selectAdjacentTab: (delta: number) => boolean;
  closeActiveTab: () => void;
  /**
   * Create a new Terminal tab, make it active, and ensure the Terminal aux
   * panel is visible. Returns the new tab's id (equals the terminal's
   * instanceId, used as the cache key suffix).
   */
  addTerminalTab: () => string;
}
