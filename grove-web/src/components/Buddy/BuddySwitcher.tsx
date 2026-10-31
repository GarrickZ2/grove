import { useEffect, useRef, useState } from "react";
import { ChevronDown, Plus, LayoutGrid } from "lucide-react";
import type { Buddy } from "../../api/buddies";
import { PickerMenu } from "../ui/PickerMenu";
import { BuddyAvatar } from "./BuddyAvatar";
export function BuddySwitcher({ buddy, onCreate, onTemplates }: { buddy: Buddy; onCreate: () => void; onTemplates: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!open) return; const close = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); }; document.addEventListener("pointerdown", close); return () => document.removeEventListener("pointerdown", close); }, [open]);
  return <div className="buddy-switcher" ref={ref} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } }}><button type="button" className="orbit-row" aria-label="Switch Buddy" aria-expanded={open} onClick={() => setOpen(!open)}><BuddyAvatar id={buddy.id} avatar={buddy.avatar} size={26} state={buddy.status} /><strong>{buddy.name}</strong><span className={`buddy-header-status is-${buddy.status}`}>{buddy.status === "waiting" ? "Waiting for you" : buddy.status === "working" ? "Working" : "Idle"}</span><ChevronDown size={14} /></button>
    {open && <PickerMenu selectedId={buddy.id} items={[{ id: buddy.id, label: buddy.name, description: buddy.role, icon: <BuddyAvatar id={buddy.id} avatar={buddy.avatar} size={30} /> }, { id: "new", label: "New Buddy", group: "Buddies", icon: <Plus size={18} /> }, { id: "templates", label: "Browse templates", icon: <LayoutGrid size={18} /> }]} onSelect={id => { setOpen(false); if (id === "new") onCreate(); if (id === "templates") onTemplates(); }} onEscape={() => setOpen(false)} />}
  </div>;
}
