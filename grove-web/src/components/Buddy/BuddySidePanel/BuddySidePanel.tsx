import { useRef, useState } from "react";
import { X } from "lucide-react";
import type { Buddy } from "../../../api/buddies";
import { BuddySettings } from "./BuddySettings";
import { BuddyRoutines } from "./BuddyRoutines";
import { MemoryPage } from "../../Memory/MemoryPage";
import { readBuddyPreference, writeBuddyPreference } from "../buddyStorage";

export type BuddyPanelTab = "routines" | "memory" | "settings";
export function BuddySidePanel({ buddy, tab, onTab, onChanged, onArchive, onClose }: { buddy: Buddy; tab: BuddyPanelTab; onTab: (tab: BuddyPanelTab) => void; onChanged: (buddy: Buddy) => void; onArchive: () => void; onClose: () => void }) {
  const [width, setWidth] = useState(() => Math.max(320, Math.min(Math.max(320, window.innerWidth - 600), Number(readBuddyPreference("panel-width", "340")) || 340)));
  const drag = useRef<{ x: number; width: number } | null>(null);
  const resize = (next: number) => { const value = Math.round(Math.max(320, Math.min(Math.max(320, window.innerWidth - 600), next))); setWidth(value); writeBuddyPreference("panel-width", String(value)); };
  return <aside className="buddy-side-panel" style={{ width }} aria-label="Buddy panel">
    <button type="button" role="separator" aria-label="Resize Buddy panel" aria-orientation="vertical" aria-valuenow={width} aria-valuemin={320} className="buddy-panel-resizer" onPointerDown={(event) => { drag.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (drag.current) resize(drag.current.width + drag.current.x - event.clientX); }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); resize(width + (event.key === "ArrowLeft" ? 20 : -20)); } }} />
    <div className="buddy-panel-tabs" role="tablist" aria-label="Buddy panel tabs">{(["routines", "memory", "settings"] as const).map((item) => <button type="button" role="tab" key={item} id={`buddy-tab-${item}`} aria-controls="buddy-panel-content" aria-selected={item === tab} onClick={() => onTab(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}<button type="button" className="buddy-icon-button" aria-label="Close panel" onClick={onClose}><X /></button></div>
    <div id="buddy-panel-content" className="buddy-panel-content" role="tabpanel" aria-labelledby={`buddy-tab-${tab}`} key={`${buddy.id}-${tab}`}>
      {tab === "settings" ? <BuddySettings buddy={buddy} onChanged={onChanged} onArchive={onArchive} /> : tab === "memory" ? <MemoryPage buddy={buddy} /> : <BuddyRoutines buddy={buddy} onMemory={() => onTab("memory")} />}
    </div>
  </aside>;
}
