import type { ReactNode } from "react";
import { ArrowLeft, PanelRight } from "lucide-react";
import type { Buddy } from "../../api/buddies";
import { BuddyAvatar } from "./BuddyAvatar";
import { BuddyConnectButton } from "./BuddyConnectButton";

export function BuddyConversationHeader({ buddy, panelOpen, onPanel, onBack, phone = false, leading, switcher }: { leading?: ReactNode; switcher?: ReactNode; buddy: Buddy; panelOpen: boolean; onPanel: () => void; onBack?: () => void; phone?: boolean }) {
  const running = buddy.running_delegations > 0 ? `${buddy.running_delegations} delegation${buddy.running_delegations === 1 ? "" : "s"} running` : "";
  const status = buddy.status === "waiting" ? "Waiting for you" : buddy.waiting_delegations > 0 ? "A subagent needs you" : buddy.status === "working" ? running ? `Working · ${running}` : "Working…" : running ? `Idle · ${running}` : "Idle";
  const tone = buddy.status === "waiting" || buddy.waiting_delegations > 0 ? "waiting" : buddy.status;
  return <header className="buddy-conversation-header" data-tauri-drag-region="deep" data-window-drag-strip>
    {leading}
    {phone && <button type="button" className="orbit-icon-button buddy-icon-button" aria-label="Back to Buddies" onClick={onBack}><ArrowLeft /></button>}
    {switcher ?? <><BuddyAvatar id={buddy.id} avatar={buddy.avatar} size={phone ? 30 : 26} state={buddy.status} />
    <div className="buddy-header-copy"><h2>{buddy.name}</h2><p className={`buddy-header-status is-${tone}`}>{status}</p></div></>}
    <BuddyConnectButton buddy={buddy} />
    <button type="button" className="orbit-icon-button buddy-icon-button" aria-label={panelOpen ? "Close Buddy panel" : "Open Buddy panel"} aria-expanded={panelOpen} onClick={onPanel}><PanelRight /></button>
  </header>;
}
