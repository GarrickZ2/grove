import { useEffect, useState, type ElementType, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { LayoutGrid, MessageSquare, X } from "lucide-react";
import type { PanelDescriptor } from "../PanelSystem/panelRegistry";

export type OrbitPhonePanel = { d: PanelDescriptor; kind: "aux" | "info" };
/** A workspace action (Commit / Merge / …), listed under the panels. */
export interface OrbitPhoneAction {
  id: string;
  label: string;
  icon: ElementType;
  onClick: () => void;
  variant?: "default" | "warning" | "danger";
  disabled?: boolean;
}

interface OrbitPhonePanelsProps {
  panels: OrbitPhonePanel[];
  /** The panel shown instead of the chat, if any. */
  openPanel: OrbitPhonePanel | null;
  onOpen: (panel: OrbitPhonePanel) => void;
  onShowChat: () => void;
  actions?: OrbitPhoneAction[];
}

/**
 * Orbit on a phone: the header's workspace controls. Panels open full screen
 * in place of the chat; the open one shows as a chip that closes back to it.
 */
export function OrbitPhonePanels({ panels, openPanel, onOpen, onShowChat, actions }: OrbitPhonePanelsProps) {
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    if (!sheetOpen) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setSheetOpen(false); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [sheetOpen]);

  const OpenIcon = openPanel?.d.icon;
  const tile = (key: string, label: string, icon: ReactNode, active: boolean, onClick: () => void) => (
    <button key={key} type="button" className={`orbit-phone-sheet__tile${active ? " is-active" : ""}`} onClick={() => { onClick(); setSheetOpen(false); }}>
      <span className="orbit-phone-sheet__tile-icon">{icon}</span>
      <span className="orbit-phone-sheet__tile-label">{label}</span>
    </button>
  );

  return (
    <>
      {openPanel && OpenIcon && (
        <button type="button" className="orbit-phone-panel-chip" aria-label={`Close ${openPanel.d.label}`} onClick={onShowChat}>
          <OpenIcon size={14} /><span>{openPanel.d.label}</span><X size={14} />
        </button>
      )}
      <button type="button" className="orbit-phone-button" aria-label="Workspace panels" aria-expanded={sheetOpen} onClick={() => setSheetOpen(true)}>
        <LayoutGrid size={18} strokeWidth={1.8} />
      </button>
      {sheetOpen && createPortal(
        <div className="orbit-phone-sheet" role="dialog" aria-label="Workspace">
          <button type="button" className="orbit-phone-sheet__backdrop" aria-label="Close" onClick={() => setSheetOpen(false)} />
          <div className="orbit-phone-sheet__panel">
            <div className="orbit-phone-sheet__grabber" />
            <div className="orbit-phone-sheet__grid">
              {tile("chat", "Agent", <MessageSquare size={18} />, !openPanel, onShowChat)}
              {panels.map((panel) => {
                const Icon = panel.d.icon;
                return tile(panel.d.key, panel.d.label, <Icon size={18} />, openPanel?.d.key === panel.d.key && openPanel.kind === panel.kind, () => onOpen(panel));
              })}
            </div>
            {!!actions?.length && (
              <div className="orbit-phone-sheet__actions">
                {actions.map(({ id, label, icon: Icon, onClick, variant, disabled }) => (
                  // An action leaves the sheet; its own dialog takes over from there.
                  <button key={id} type="button" disabled={disabled} className={`orbit-phone-sheet__action${variant && variant !== "default" ? ` is-${variant}` : ""}`} onClick={() => { setSheetOpen(false); onClick(); }}>
                    <Icon size={16} /><span>{label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
