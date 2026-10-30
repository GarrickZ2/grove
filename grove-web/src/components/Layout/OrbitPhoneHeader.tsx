import { Menu, SquarePen } from "lucide-react";
import { isIosClient } from "../../utils/platform";
import "./orbit-sidebar.css";

// A narrowed macOS desktop window keeps its traffic lights over the header's top-left corner.
const hasMacControls = !isIosClient && typeof window !== "undefined"
  && ("__TAURI__" in window || "__TAURI_INTERNALS__" in window)
  && /Mac/i.test(navigator.platform || "");

/** Portal targets: a visible Session fills the title, its workspace fills the actions. */
export const ORBIT_PHONE_TITLE_SLOT = "orbit-phone-title";
export const ORBIT_PHONE_ACTIONS_SLOT = "orbit-phone-actions";
/** Opening a Session on a phone lands on its chat, not on a panel left open earlier. */
export const ORBIT_PHONE_SHOW_CHAT_EVENT = "grove:orbit-phone-show-chat";

interface OrbitPhoneHeaderProps {
  /** Shown while no Session claims the title slot. */
  title: string;
  onMenu: () => void;
  onNew: () => void;
  newDisabled?: boolean;
}

/** Orbit's phone top bar: drawer button, page / Session title, New. */
export function OrbitPhoneHeader({ title, onMenu, onNew, newDisabled }: OrbitPhoneHeaderProps) {
  return (
    // Empty header space drags the desktop window (App's mousedown handler skips buttons).
    <header className={`orbit-phone-header${hasMacControls ? " has-mac-controls" : ""}`} data-tauri-drag-region="deep" data-window-drag-strip>
      <button type="button" className="orbit-phone-button" aria-label="Open menu" onClick={onMenu}><Menu size={20} strokeWidth={1.8} /></button>
      <div className="orbit-phone-title">
        <div id={ORBIT_PHONE_TITLE_SLOT} className="orbit-phone-title-slot" />
        <span className="orbit-phone-title-fallback">{title}</span>
      </div>
      <div className="orbit-phone-actions">
        <div id={ORBIT_PHONE_ACTIONS_SLOT} className="orbit-phone-actions-slot" />
        <button type="button" className="orbit-phone-button" aria-label="New session" title="New session" disabled={newDisabled} onClick={onNew}><SquarePen size={18} strokeWidth={1.8} /></button>
      </div>
    </header>
  );
}
