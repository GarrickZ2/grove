import { useOrbitInterface } from '../../orbit/ui/interfaceContext';
import { useInPanelShell } from '../../orbit/ui/panelSlots';

/**
 * Review renders its Orbit presentation only inside an Orbit workspace panel
 * (PanelShell owns the header there). Everywhere else — Workbench, the
 * standalone /review page — it keeps the legacy chrome.
 */
export function useOrbitReview(): boolean {
  const orbit = useOrbitInterface();
  const inShell = useInPanelShell();
  return orbit && inShell;
}
