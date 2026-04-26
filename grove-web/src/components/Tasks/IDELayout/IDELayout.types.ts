import type { Task } from "../../../data/types";

// ── Layout Mode ──
export type LayoutMode = "flex" | "ide";

// ── Panel Categories ──
export type AuxPanelType = "terminal" | "editor" | "review" | "graph" | "artifacts" | "sketch";
export type InfoTabType = "stats" | "git" | "notes" | "comments";
export const AUX_PANEL_TYPES: AuxPanelType[] = ["terminal", "editor", "review", "graph", "artifacts", "sketch"];
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
}

export interface IDELayoutHandle {
  focusPanel: (type: AuxPanelType) => void;
  focusAuxPanel: (type: AuxPanelType) => void;
  focusInfoPanel: (type: InfoTabType) => void;
  focusChat: () => void;
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
