import { createContext, useContext, useEffect, type ElementType } from "react";

/* Shared by PanelShell and panel bodies: the header-slot context, the hooks a
   body uses to contribute to the header, and the glyph tile hues. See the
   contract at the top of PanelShell.tsx. */

export interface PanelHue {
  from: string;
  to: string;
}

/** Glyph tile colours (Panels board): one hue per panel kind. */
export const PANEL_HUES = {
  stone: { from: "#a8a29e", to: "#57534e" },
  orange: { from: "#fdba74", to: "#c2410c" },
  blue: { from: "#93c5fd", to: "#1d4ed8" },
  amber: { from: "#fcd34d", to: "#d97706" },
  green: { from: "#6ee7b7", to: "#047857" },
  pink: { from: "#f9a8d4", to: "#db2777" },
  indigo: { from: "#a5b4fc", to: "#4338ca" },
  violet: { from: "#c4b5fd", to: "#6d28d9" },
  teal: { from: "#5eead4", to: "#0f766e" },
  slate: { from: "#94a3b8", to: "#334155" },
} as const satisfies Record<string, PanelHue>;

export interface PanelMenuItem {
  id: string;
  label: string;
  icon?: ElementType;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Display string for the keyboard shortcut, e.g. "⌘W". */
  shortcut?: string;
  /** Hairline above this row (starts a new group). */
  separator?: boolean;
}

export interface PanelSlots {
  leading: HTMLElement | null;
  actions: HTMLElement | null;
  context: HTMLElement | null;
  setBodyMenu: (items: PanelMenuItem[]) => void;
}

export const PanelSlotsContext = createContext<PanelSlots | null>(null);

/** True inside a PanelShell. */
export function useInPanelShell(): boolean {
  return useContext(PanelSlotsContext) !== null;
}

/** Adds rows to the ⋯ menu. Pass a memoized array. */
export function usePanelMenuItems(items: PanelMenuItem[]): void {
  const slots = useContext(PanelSlotsContext);
  const setBodyMenu = slots?.setBodyMenu;
  useEffect(() => {
    if (!setBodyMenu) return;
    setBodyMenu(items);
    return () => setBodyMenu([]);
  }, [setBodyMenu, items]);
}

