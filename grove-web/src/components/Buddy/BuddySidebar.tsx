import { useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Mail, MailOpen, Pin, PinOff, Plus, Search, Settings, SlidersHorizontal, Trash2 } from "lucide-react";
import type { BuddySummary } from "../../api/buddies";
import { useSortable } from "../../hooks/useSortable";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";
import { BuddyListItem } from "./BuddyListItem";
import { BuddyPinTile } from "./BuddyPinTile";
import { BuddySwipeRow } from "./BuddySwipeRow";

export function BuddySidebar({ items, unread, selectedId, viewingId, onSelect, onCreate, onGlobalSettings, onBuddySettings, onDelete, onPin, onMarkRead, onMarkUnread, onReorder, phone = false, error, loading = false, onRetry, exit, toggle }: {
  exit?: React.ReactNode; toggle?: React.ReactNode; items: BuddySummary[]; unread?: Set<string>; selectedId: string;
  /** The conversation on screen; it is always read, so it can't be marked unread. */
  viewingId: string;
  onSelect: (id: string) => void; onCreate: () => void;
  onGlobalSettings: () => void; onBuddySettings: (id: string) => void; onDelete: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void; onMarkRead: (id: string) => void; onMarkUnread: (id: string) => void;
  onReorder: (ids: string[]) => void; phone?: boolean; error?: string | null; loading?: boolean; onRetry?: () => void;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [swipeOpen, setSwipeOpen] = useState<string | null>(null);
  const reduceMotion = useReducedMotion();
  const byId = new Map(items.map((item) => [item.id, item]));
  const pinnedIds = items.filter((item) => item.pinned).map((item) => item.id);
  const listIds = items.filter((item) => !item.pinned).map((item) => item.id);
  const openMenu = (id: string, at: { x: number; y: number }) => { setSwipeOpen(null); setMenu({ id, ...at }); };
  // Pins and the list each keep their own order; the saved order is pins first.
  const pins = useSortable({ ids: pinnedIds, onReorder: (ids) => onReorder([...ids, ...listIds]), onLongPress: openMenu });
  const list = useSortable({ ids: listIds, onReorder: (ids) => onReorder([...pinnedIds, ...ids]), onLongPress: openMenu });
  const searching = query.trim().length > 0;
  const matches = items.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase()));
  const isUnread = (id: string) => !!unread?.has(id);
  const toggleRead = (id: string) => (isUnread(id) ? onMarkRead(id) : onMarkUnread(id));
  const layout = reduceMotion ? undefined : { duration: 0.18, ease: [0.2, 0.7, 0.3, 1] as const };

  const menuItems = (id: string): ContextMenuItem[] => {
    const buddy = byId.get(id);
    if (!buddy) return [];
    const items: ContextMenuItem[] = [
      { id: "pin", label: buddy.pinned ? "Unpin" : "Pin to top", icon: buddy.pinned ? PinOff : Pin, onClick: () => onPin(id, !buddy.pinned) },
    ];
    if (isUnread(id)) items.push({ id: "read", label: "Mark as read", icon: MailOpen, onClick: () => onMarkRead(id) });
    else if (id !== viewingId) items.push({ id: "unread", label: "Mark as unread", icon: Mail, onClick: () => onMarkUnread(id) });
    items.push(
      { id: "settings", label: "Buddy settings", icon: SlidersHorizontal, onClick: () => onBuddySettings(id) },
      { id: "separator", label: "", divider: true, onClick: () => {} },
      { id: "delete", label: "Delete…", icon: Trash2, variant: "danger", onClick: () => onDelete(id) },
    );
    return items;
  };

  const row = (buddy: BuddySummary, sortable?: ReturnType<typeof list.itemProps>) => {
    const item = <BuddyListItem buddy={buddy} selected={buddy.id === selectedId} unread={isUnread(buddy.id)} avatarSize={phone ? 44 : 36}
      onSelect={() => onSelect(buddy.id)} onMenu={(at) => openMenu(buddy.id, at)} sortable={sortable} />;
    if (!phone) return item;
    return <BuddySwipeRow unread={isUnread(buddy.id)} pinned={buddy.pinned} open={swipeOpen === buddy.id}
      onOpen={(open) => setSwipeOpen(open ? buddy.id : (current) => current === buddy.id ? null : current)}
      onToggleRead={() => toggleRead(buddy.id)} onTogglePin={() => onPin(buddy.id, !buddy.pinned)} onDelete={() => onDelete(buddy.id)}
      blocked={list.isDragging}>{item}</BuddySwipeRow>;
  };

  return <aside className="buddy-sidebar" aria-label="Buddies">
    <div className="buddy-sidebar-top" data-tauri-drag-region="deep" data-window-drag-strip>{exit}{toggle}</div>
    <div className="buddy-sidebar-heading"><h1>Buddies</h1>{items.length > 8 && <button type="button" className="orbit-icon-button" aria-label="Search Buddies" aria-expanded={searchOpen} onClick={() => { setSearchOpen(!searchOpen); setQuery(""); }}><Search size={16} /></button>}<button type="button" className="buddy-icon-button" aria-label="Create Buddy" onClick={onCreate}><Plus /></button></div>
    {searchOpen && <label className="buddy-search"><Search size={15} /><input aria-label="Search Buddies" placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} /></label>}
    {error && <p role="alert">{error}<button type="button" className="buddy-button" onClick={onRetry}>Retry</button></p>}
    <div className="buddy-list">
      {searching ? matches.map((buddy) => <div key={buddy.id}>{row(buddy)}</div>) : <>
        {pinnedIds.length > 0 && <div className="buddy-pins" role="group" aria-label="Pinned Buddies">
          {pins.order.map((id) => {
            const buddy = byId.get(id)!, dragging = pins.draggingId === id;
            return <motion.div key={id} layout={dragging ? false : "position"} transition={layout} className={`buddy-pin-slot${dragging ? " is-dragging" : ""}`}
              style={dragging ? { x: pins.offset.x, y: pins.offset.y } : { x: 0, y: 0 }}>
              <BuddyPinTile buddy={buddy} selected={id === selectedId} unread={isUnread(id)} size={phone ? 56 : 44}
                onSelect={() => onSelect(id)} onMenu={(at) => openMenu(id, at)} sortable={pins.itemProps(id)} />
            </motion.div>;
          })}
        </div>}
        {list.order.map((id) => {
          const buddy = byId.get(id)!, dragging = list.draggingId === id;
          return <motion.div key={id} layout={dragging ? false : "position"} transition={layout} className={`buddy-list-slot${dragging ? " is-dragging" : ""}`}
            style={dragging ? { y: list.offset.y } : { y: 0 }}>
            {row(buddy, list.itemProps(id))}
          </motion.div>;
        })}
      </>}
      {!(searching ? matches.length : items.length) && <p className="buddy-muted">{loading ? "Loading Buddies…" : searching ? "No matching Buddies" : "Create your first Buddy"}</p>}
    </div>
    <footer className="orbit-footer"><button className="orbit-row orbit-nav-row" type="button" onClick={onGlobalSettings}><Settings size={18} />Settings</button></footer>
    <ContextMenu items={menu ? menuItems(menu.id) : []} position={menu ? { x: menu.x, y: menu.y } : null} onClose={() => setMenu(null)} />
  </aside>;
}
