import type { ReactNode } from "react";
import { ArrowLeft, PanelRight, SlidersHorizontal } from "lucide-react";
import type { Buddy } from "../../api/buddies";
import { BuddyAvatar } from "./BuddyAvatar";

export function BuddyConversationHeader({ buddy, panelOpen, onSettings, onPanel, onBack, phone = false, leading, switcher }: { leading?: ReactNode; switcher?: ReactNode; buddy: Buddy; panelOpen: boolean; onSettings: () => void; onPanel: () => void; onBack?: () => void; phone?: boolean }) {
  const status = buddy.status === "waiting" ? "Waiting for you" : buddy.status === "working" ? buddy.running_delegations > 0 ? `Working · ${buddy.running_delegations} delegation${buddy.running_delegations === 1 ? "" : "s"} running` : "Working…" : "Idle";
  return <header className="buddy-conversation-header" data-tauri-drag-region="deep" data-window-drag-strip>
    {leading}
    {phone && <button type="button" className="orbit-icon-button buddy-icon-button" aria-label="Back to Buddies" onClick={onBack}><ArrowLeft /></button>}
    {switcher ?? <><BuddyAvatar id={buddy.id} avatar={buddy.avatar} size={phone ? 30 : 26} state={buddy.status} />
    <div className="buddy-header-copy"><h2>{buddy.name}</h2><p className={`buddy-header-status is-${buddy.status}`}>{status}</p></div></>}
    <button type="button" className="orbit-icon-button buddy-icon-button" aria-label="Buddy settings" onClick={onSettings}><SlidersHorizontal /></button>
    <button type="button" className="orbit-icon-button buddy-icon-button" aria-label={panelOpen ? "Close Buddy panel" : "Open Buddy panel"} aria-expanded={panelOpen} onClick={onPanel}><PanelRight /></button>
  </header>;
}
