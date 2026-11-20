import { useEffect, useState, type ElementType, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AppWindow, Columns2, LayoutGrid, MessageSquare, MoreHorizontal } from "lucide-react";
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
  /** In iPhone Duo's column: every panel as its own button, scrolling when the
   *  column runs out; the sheet keeps only the workspace actions. */
  compact?: boolean;
  /** A wide screen with a panel open: how the panel and the chat share it. */
  layout?: { mode: "split" | "chat" | "panel"; onChange: (mode: "split" | "chat" | "panel") => void };
}

const LAYOUTS = [
  { mode: "split", label: "Panel and chat side by side", Icon: Columns2 },
  { mode: "chat", label: "Chat only", Icon: MessageSquare },
  { mode: "panel", label: "Panel only", Icon: AppWindow },
] as const;

/**
 * Orbit on a phone: the header's workspace controls. Panels open full screen
 * in place of the chat; the open one shows as a chip that closes back to it.
 */
export function OrbitPhonePanels({ panels, openPanel, onOpen, onShowChat, actions, compact, layout }: OrbitPhonePanelsProps) {
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    if (!sheetOpen) return;
    document.documentElement.classList.add("grove-sheet-open");
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setSheetOpen(false); };
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("keydown", escape);
      document.documentElement.classList.remove("grove-sheet-open");
    };
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
      {!compact && openPanel && OpenIcon && (
        <div className="orbit-phone-switch" role="radiogroup" aria-label="Show">
          <button type="button" role="radio" aria-checked={false} aria-label="Agent" title="Agent" onClick={onShowChat}>
            <MessageSquare size={16} strokeWidth={1.8} />
          </button>
          <button type="button" role="radio" aria-checked className="is-on" aria-label={openPanel.d.label}>
            <OpenIcon size={15} strokeWidth={1.8} /><span>{openPanel.d.label}</span>
          </button>
        </div>
      )}
      {compact ? (
        <>
          {layout ? (
            <div className="orbit-duo-layout" role="radiogroup" aria-label="Layout">
              {LAYOUTS.map(({ mode, label, Icon }) => (
                <button key={mode} type="button" role="radio" aria-checked={layout.mode === mode} aria-label={label} title={label} className={`orbit-duo-tool${layout.mode === mode ? " is-on" : ""}`} onClick={() => layout.onChange(mode)}>
                  <Icon size={19} strokeWidth={1.8} />
                </button>
              ))}
            </div>
          ) : (
            <button type="button" className={`orbit-duo-tool${!openPanel ? " is-on" : ""}`} aria-label="Agent" title="Agent" aria-pressed={!openPanel} onClick={onShowChat}>
              <MessageSquare size={20} strokeWidth={1.8} />
            </button>
          )}
          {/* Agent and the actions stay put; only the panels scroll between them. */}
          <div className="orbit-duo-scroll">
            {panels.map((panel) => {
              const Icon = panel.d.icon;
              const on = openPanel?.d.key === panel.d.key && openPanel.kind === panel.kind;
              return (
                <button key={`${panel.kind}:${panel.d.key}`} type="button" className={`orbit-duo-tool${on ? " is-on" : ""}`} aria-label={panel.d.label} title={panel.d.label} aria-pressed={on} onClick={() => (on ? onShowChat() : onOpen(panel))}>
                  <Icon size={20} strokeWidth={1.8} />
                </button>
              );
            })}
          </div>
          {!!actions?.length && (
            <button type="button" className="orbit-duo-tool" aria-label="Workspace actions" aria-expanded={sheetOpen} onClick={() => setSheetOpen(true)}>
              <MoreHorizontal size={20} strokeWidth={1.8} />
            </button>
          )}
        </>
      ) : (
        <button type="button" className="orbit-phone-button" aria-label="Workspace panels" aria-expanded={sheetOpen} onClick={() => setSheetOpen(true)}>
          <LayoutGrid size={18} strokeWidth={1.8} />
        </button>
      )}
      {sheetOpen && createPortal(
        <div className="orbit-phone-sheet" role="dialog" aria-label="Workspace">
          <button type="button" className="orbit-phone-sheet__backdrop" aria-label="Close" onClick={() => setSheetOpen(false)} />
          <div className="orbit-phone-sheet__panel">
            <div className="orbit-phone-sheet__grabber" />
            {!compact && <div className="orbit-phone-sheet__grid">
              {tile("chat", "Agent", <MessageSquare size={18} />, !openPanel, onShowChat)}
              {panels.map((panel) => {
                const Icon = panel.d.icon;
                return tile(panel.d.key, panel.d.label, <Icon size={18} />, openPanel?.d.key === panel.d.key && openPanel.kind === panel.kind, () => onOpen(panel));
              })}
            </div>}
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

/**
 * Laptop fold, the lower screen's work bar: every panel in one row that
 * swipes sideways, then the workspace actions. The open panel's tab closes it.
 */
export function OrbitLaptopStrip({ panels, openPanel, onOpen, onClose, actions }: {
  panels: OrbitPhonePanel[];
  openPanel: OrbitPhonePanel | null;
  onOpen: (panel: OrbitPhonePanel) => void;
  onClose: () => void;
  actions?: OrbitPhoneAction[];
}) {
  return (
    <div className="orbit-laptop-strip" role="toolbar" aria-label="Panels">
      {panels.map((panel) => {
        const Icon = panel.d.icon;
        const on = openPanel?.d.key === panel.d.key && openPanel.kind === panel.kind;
        return (
          <button
            key={`${panel.kind}:${panel.d.key}`}
            type="button"
            className={`orbit-laptop-tab${on ? " is-on" : ""}`}
            aria-pressed={on}
            aria-label={panel.d.label}
            onClick={() => (on ? onClose() : onOpen(panel))}
          >
            <Icon size={16} strokeWidth={1.8} />
            <span>{panel.d.label}</span>
          </button>
        );
      })}
      {!!actions?.length && <span className="orbit-laptop-strip__sep" aria-hidden="true" />}
      {actions?.map(({ id, label, icon: Icon, onClick, variant, disabled }) => (
        <button key={id} type="button" disabled={disabled} className={`orbit-laptop-tab is-action${variant && variant !== "default" ? ` is-${variant}` : ""}`} onClick={onClick}>
          <Icon size={16} strokeWidth={1.8} />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

/** The left screen of a book fold while no panel is open: pick one to sit beside the Agent. */
export function OrbitFoldPanelPicker({ panels, onOpen }: { panels: OrbitPhonePanel[]; onOpen: (panel: OrbitPhonePanel) => void }) {
  return (
    <div className="orbit-fold-picker">
      <p className="orbit-fold-picker__hint">Open a panel beside the Agent</p>
      <div className="orbit-fold-picker__grid">
        {panels.map((panel) => {
          const Icon = panel.d.icon;
          return (
            <button key={panel.d.key} type="button" className="orbit-phone-sheet__tile" onClick={() => onOpen(panel)}>
              <span className="orbit-phone-sheet__tile-icon"><Icon size={18} /></span>
              <span className="orbit-phone-sheet__tile-label">{panel.d.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
