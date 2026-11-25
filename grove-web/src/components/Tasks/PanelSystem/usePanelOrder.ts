import { useMemo, useState } from "react";
import { patchConfig } from "../../../api";
import { useBanner, useConfig } from "../../../context";
import { fullPanelOrder, groupPanels, movePanel, orderPanels, splitPanels, type PanelMove } from "./panelOrder";

/** The user's panel order for this kind of task, and how to change it. */
export function usePanelOrder(isStudio: boolean) {
  const { config, refresh } = useConfig();
  const { showBanner } = useBanner();
  const field = isStudio ? "panel_order_studio" : "panel_order_coding";
  // Shown until the saved config comes back, so a dropped panel doesn't jump.
  const [pending, setPending] = useState<string[] | null>(null);
  const saved = pending ?? config?.web?.[field];
  return useMemo(() => ({
    order: <T extends { key: string }>(panels: readonly T[]) => orderPanels(panels, saved, isStudio),
    split: <T extends { key: string }>(panels: readonly T[]) => splitPanels(panels, saved, isStudio),
    group: <T extends { key: string }>(ordered: readonly T[]) => groupPanels(ordered, isStudio),
    move: (available: readonly string[], move: PanelMove) => {
      const current = fullPanelOrder(available, saved, isStudio);
      const next = movePanel(current, move);
      if (next.every((key, i) => key === current[i])) return;
      setPending(next);
      void patchConfig({ web: { [field]: next } })
        .then(refresh)
        .catch(() => showBanner("Failed to save the panel order", "error"))
        .finally(() => setPending((value) => (value === next ? null : value)));
    },
  }), [saved, isStudio, field, refresh, showBanner]);
}
