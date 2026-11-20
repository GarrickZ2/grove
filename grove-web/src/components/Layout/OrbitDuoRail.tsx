import { Menu, PanelLeft, SquarePen } from "lucide-react";
import type { OrbitToolItem } from "../Tasks/IDELayout/OrbitWorkspace";
import { ORBIT_DUO_RAIL_SLOT, useDuoRailSide } from "../../hooks/useDuoRail";
import "./orbit-duo-rail.css";

interface OrbitDuoRailProps {
  /** Phone layout: the button opens the drawer. Desktop: it shows or hides the sidebar. */
  phone: boolean;
  sidebarOpen: boolean;
  onMenu: () => void;
  onNew: () => void;
  newDisabled?: boolean;
}

/**
 * iPhone Duo's column beside the screen, in the iOS app: New under the
 * system pill, and at the bottom the sidebar plus the open Session's panels
 * (portalled into the slot by the workspace).
 */
export function OrbitDuoRail({ phone, sidebarOpen, onMenu, onNew, newDisabled }: OrbitDuoRailProps) {
  const side = useDuoRailSide();
  return (
    <nav className={`orbit-duo-rail orbit-ui${side === "left" ? " is-left" : ""}`} aria-label="Grove">
      <button type="button" className="orbit-duo-new" aria-label="New session" title="New session" disabled={newDisabled} onClick={onNew}>
        <SquarePen size={19} strokeWidth={1.9} />
      </button>
      <div className="orbit-duo-dock">
        <button
          type="button"
          className={`orbit-duo-tool${!phone && sidebarOpen ? " is-on" : ""}`}
          aria-label={phone ? "Open menu" : sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          aria-pressed={phone ? undefined : sidebarOpen}
          onClick={onMenu}
        >
          {phone ? <Menu size={20} strokeWidth={1.8} /> : <PanelLeft size={20} strokeWidth={1.8} />}
        </button>
        <div id={ORBIT_DUO_RAIL_SLOT} className="orbit-duo-slot" />
      </div>
    </nav>
  );
}

/** The workspace's panel toggles, stacked for the rail. */
export function OrbitDuoRailTools({ groups }: { groups: OrbitToolItem[][] }) {
  const tools = groups.flat();
  if (!tools.length) return null;
  return (
    <div className="orbit-duo-tools" role="toolbar" aria-label="Panels">
      <span className="orbit-duo-sep" aria-hidden="true" />
      <div className="orbit-duo-scroll">
      {tools.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.key}
            type="button"
            className={`orbit-duo-tool${item.active ? " is-on" : ""}`}
            aria-pressed={item.active}
            aria-label={item.label}
            title={item.tip ?? item.label}
            data-orbit-tool={item.key}
            disabled={item.disabled}
            onClick={item.onToggle}
          >
            <Icon size={20} />
          </button>
        );
      })}
      </div>
    </div>
  );
}
