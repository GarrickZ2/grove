import { useState } from "react";
import { X } from "lucide-react";
import type { BuddySummary } from "../../../api/buddies";
import { useEscapeScope } from "../../../keyboard/useEscapeScope";
import { errorMessage } from "../../../utils/errorMessage";
import { DialogShell } from "../../ui/DialogShell";
import { BuddyAvatar } from "../BuddyAvatar";

/** Pick who's in; the name is optional and defaults to their names. */
export function CreateBuddyGroupDialog({ buddies, onClose, onCreate }: { buddies: BuddySummary[]; onClose: () => void; onCreate: (input: { name?: string; buddy_ids: string[] }) => Promise<void> }) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEscapeScope(!saving, onClose);
  const toggle = (id: string) => setPicked((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const placeholder = buddies.filter((buddy) => picked.includes(buddy.id)).map((buddy) => buddy.name).join(", ") || "Group name";
  const submit = async () => {
    if (saving || picked.length < 2) return;
    setSaving(true); setError(null);
    try { await onCreate({ name: name.trim() || undefined, buddy_ids: picked }); onClose(); }
    catch (reason) { setError(errorMessage(reason)); setSaving(false); }
  };
  return <DialogShell isOpen onClose={() => { if (!saving) onClose(); }} maxWidth="max-w-[540px]">
    <form className="buddy-dialog buddy-form" aria-label="New Group" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div className="buddy-dialog-heading"><h2>New Group</h2><button type="button" className="orbit-icon-button" aria-label="Close new group" disabled={saving} onClick={onClose}><X size={18} /></button></div>
      <label>Name <span className="buddy-muted">(optional)</span><input value={name} placeholder={placeholder} onChange={(event) => setName(event.target.value)} /></label>
      <fieldset className="buddy-group-picker" disabled={saving}>
        <legend className="buddy-field-label">Members</legend>
        <ul>{buddies.map((buddy) => <li key={buddy.id}><label className={picked.includes(buddy.id) ? "is-picked" : undefined}>
          <input type="checkbox" checked={picked.includes(buddy.id)} onChange={() => toggle(buddy.id)} />
          <BuddyAvatar id={buddy.id} avatar={buddy.avatar} size={28} />
          <span className="buddy-group-picker-name">{buddy.name}</span>
          {buddy.role && <span className="buddy-group-picker-role">{buddy.role}</span>}
        </label></li>)}</ul>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <div className="buddy-actions"><button className="buddy-button" type="button" disabled={saving} onClick={onClose}>Cancel</button><button className="buddy-button is-primary" type="submit" disabled={saving || picked.length < 2}>{saving ? "Creating…" : "Create group"}</button></div>
    </form>
  </DialogShell>;
}
