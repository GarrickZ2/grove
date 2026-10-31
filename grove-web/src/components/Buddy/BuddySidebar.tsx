import { useRef, useState } from "react";
import { Plus, Search, Settings } from "lucide-react";
import type { BuddySummary } from "../../api/buddies";
import { DialogShell } from "../ui/DialogShell";
import { BuddyListItem } from "./BuddyListItem";

export function BuddySidebar({ items, selectedId, onSelect, onCreate, onGlobalSettings, onBuddySettings, onArchive, onReorder, phone = false, error, loading = false, onRetry, exit }: {
  exit?: React.ReactNode; items: BuddySummary[]; selectedId: string; onSelect: (id: string) => void; onCreate: () => void;
  onGlobalSettings: () => void; onBuddySettings: (id: string) => void; onArchive: (id: string) => void;
  onReorder: (ids: string[]) => void; phone?: boolean; error?: string | null; loading?: boolean; onRetry?: () => void;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [menuId, setMenuId] = useState<string | null>(null);
  const dragged = useRef<string | null>(null);
  const filtered = items.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase()));
  const drop = (target: string) => {
    const source = dragged.current; dragged.current = null;
    if (!source || source === target) return;
    const ids = items.map((item) => item.id).filter((id) => id !== source);
    ids.splice(ids.indexOf(target), 0, source); onReorder(ids);
  };
  return <aside className="buddy-sidebar" aria-label="Buddies">
    <div className="buddy-sidebar-top" data-tauri-drag-region="deep" data-window-drag-strip>{exit}</div>
    <div className="buddy-sidebar-heading"><h1>Buddies</h1>{items.length > 8 && <button type="button" className="orbit-icon-button" aria-label="Search Buddies" aria-expanded={searchOpen} onClick={() => { setSearchOpen(!searchOpen); setQuery(""); }}><Search size={16} /></button>}<button type="button" className="buddy-icon-button" aria-label="Create Buddy" onClick={onCreate}><Plus /></button></div>
    {searchOpen && <label className="buddy-search"><Search size={15} /><input aria-label="Search Buddies" placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} /></label>}
    {error && <p role="alert">{error}<button type="button" className="buddy-button" onClick={onRetry}>Retry</button></p>}
    <div className="buddy-list">{filtered.map((buddy) => <BuddyListItem key={buddy.id} buddy={buddy} selected={buddy.id === selectedId} avatarSize={phone ? 44 : 30} onSelect={() => onSelect(buddy.id)} onMenu={() => setMenuId(buddy.id)} onDrag={() => { dragged.current = buddy.id; }} onDrop={() => drop(buddy.id)} />)}
      {!filtered.length && <p className="buddy-muted">{loading ? "Loading Buddies…" : query ? "No matching Buddies" : "Create your first Buddy"}</p>}
    </div>
    <footer className="orbit-footer"><button className="orbit-row orbit-nav-row" type="button" onClick={onGlobalSettings}><Settings size={18} />Settings</button></footer>
    <DialogShell isOpen={menuId !== null} onClose={() => setMenuId(null)}><div className="buddy-dialog buddy-menu" aria-label="Buddy actions">
      <button type="button" onClick={() => { if (menuId) onBuddySettings(menuId); setMenuId(null); }}>Buddy settings</button>
      <button type="button" onClick={() => { if (menuId) onArchive(menuId); setMenuId(null); }}>Archive Buddy</button>
      <button type="button" onClick={() => setMenuId(null)}>Cancel</button>
    </div></DialogShell>
  </aside>;
}
