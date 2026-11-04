import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { MessageCircle, MoreHorizontal, Plus, Search, UserMinus, X } from "lucide-react";
import type { BuddySummary } from "../../../api/buddies";
import { addBuddyGroupMember, removeBuddyGroupMember, renameBuddyGroup, type BuddyGroup, type BuddyGroupMember } from "../../../api/buddyGroups";
import { errorMessage } from "../../../utils/errorMessage";
import { ContextMenu } from "../../ui/ContextMenu";
import { BuddyAvatar } from "../BuddyAvatar";

const STATUS = { idle: "Idle", working: "Working", waiting: "Waiting" } as const;

/** Everything about a group on one page: its name, who's in it, and disbanding it. */
export function BuddyGroupPanel({ group, buddies, onChanged, onDisband, onOpenBuddy, onClose, closable = false }: { group: BuddyGroup; buddies: BuddySummary[]; onChanged: () => void; onDisband: () => void; onOpenBuddy: (id: string) => void; onClose: () => void; closable?: boolean }) {
  const reduceMotion = useReducedMotion();
  const [name, setName] = useState(group.name);
  const [edited, setEdited] = useState(group.id);
  if (edited !== group.id) { setEdited(group.id); setName(group.name); }
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ member: BuddyGroupMember; x: number; y: number } | null>(null);
  const [removing, setRemoving] = useState<BuddyGroupMember | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (action: Promise<unknown>) => { setError(null); void action.then(onChanged).catch((reason) => setError(errorMessage(reason))); };
  const save = () => { const next = name.trim(); if (next && next !== group.name) run(renameBuddyGroup(group.id, next)); else setName(group.name); };
  const remove = (member: BuddyGroupMember) => {
    // Removing someone mid-turn stops that turn, so it takes a second look.
    if (member.status !== "idle") { setRemoving(member); return; }
    run(removeBuddyGroupMember(group.id, member.buddy_id));
  };
  const outside = buddies.filter((buddy) => !group.members.some((member) => member.buddy_id === buddy.id) && buddy.name.toLowerCase().includes(query.trim().toLowerCase()));
  return <aside className="buddy-side-panel buddy-group-panel" style={{ width: closable ? undefined : 340 }} aria-label="Group panel">
    {closable && <button type="button" className="orbit-icon-button buddy-group-panel-close" aria-label="Close group panel" onClick={onClose}><X size={18} /></button>}
    <div className="buddy-panel-content">
      <div className="buddy-panel-section buddy-group-name buddy-form"><label>Group name<input value={name} onChange={(event) => setName(event.target.value)} onBlur={save} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label></div>
      <div className="buddy-panel-section">
        <div className="buddy-group-members-heading"><h3>Members <span className="buddy-muted">{group.members.length}</span></h3><button type="button" className="buddy-button" aria-expanded={adding} onClick={() => { setAdding(!adding); setQuery(""); }}><Plus size={14} />Add</button></div>
        {adding && <div className="buddy-group-add" role="dialog" aria-label="Add Buddies">
          <label className="buddy-search"><Search size={15} /><input aria-label="Search Buddies" placeholder="Search Buddies" value={query} autoFocus onChange={(event) => setQuery(event.target.value)} /></label>
          <ul>{outside.map((buddy) => <li key={buddy.id}><button type="button" onClick={() => { setAdding(false); run(addBuddyGroupMember(group.id, buddy.id)); }}><BuddyAvatar id={buddy.id} avatar={buddy.avatar} size={28} /><span className="buddy-group-row-copy"><strong>{buddy.name}</strong>{buddy.role && <small>{buddy.role}</small>}</span><Plus size={15} /></button></li>)}</ul>
          {!outside.length && <p className="buddy-muted">Everyone's already here</p>}
          <p className="buddy-muted">New members see the last 50 messages.</p>
        </div>}
        <ul className="buddy-group-members"><AnimatePresence initial={false}>{group.members.map((member) => <motion.li key={member.buddy_id} layout={!reduceMotion} initial={{ opacity: 0, y: -8, scale: 0.94 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, x: 24, height: 0, paddingTop: 0, paddingBottom: 0 }} transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 32 }}>
          <BuddyAvatar id={member.buddy_id} avatar={member.avatar} size={32} state={member.status} />
          <span className="buddy-group-row-copy"><strong>{member.name}</strong>{member.role && <small>{member.role}</small>}</span>
          <span className={`buddy-group-member-status is-${member.status}`}>{STATUS[member.status]}</span>
          <button type="button" className="orbit-icon-button buddy-icon-button" aria-label={`More for ${member.name}`} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ member, x: rect.right - 196, y: rect.bottom + 4 }); }}><MoreHorizontal /></button>
        </motion.li>)}</AnimatePresence></ul>
        {removing && <div className="buddy-group-confirm" role="alert"><p>{removing.name} is working. Removing them stops this turn.</p><div className="buddy-actions"><button type="button" className="buddy-button" onClick={() => setRemoving(null)}>Keep</button><button type="button" className="buddy-button is-danger" onClick={() => { const member = removing; setRemoving(null); run(removeBuddyGroupMember(group.id, member.buddy_id)); }}>Remove</button></div></div>}
        {error && <p role="alert">{error}</p>}
      </div>
    </div>
    <footer className="buddy-group-panel-footer"><button type="button" className="buddy-group-disband" onClick={onDisband}>Disband group…</button></footer>
    <ContextMenu position={menu ? { x: menu.x, y: menu.y } : null} onClose={() => setMenu(null)} items={menu ? [
      { id: "chat", label: `Open chat with ${menu.member.name}`, icon: MessageCircle, onClick: () => onOpenBuddy(menu.member.buddy_id) },
      { id: "separator", label: "", divider: true, onClick: () => {} },
      { id: "remove", label: "Remove from group", icon: UserMinus, variant: "danger", onClick: () => remove(menu.member) },
    ] : []} />
  </aside>;
}
