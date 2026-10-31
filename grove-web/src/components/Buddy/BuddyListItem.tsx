import type { BuddySummary } from "../../api/buddies";
import { BuddyAvatar } from "./BuddyAvatar";

function activityLabel(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  today.setDate(today.getDate() - 1);
  return date.toDateString() === today.toDateString() ? "Yesterday" : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function BuddyListItem({ buddy, selected, onSelect, onMenu, onDrag, onDrop, avatarSize = 30 }: {
  buddy: BuddySummary; selected: boolean; onSelect: () => void; onMenu: () => void;
  onDrag: () => void; onDrop: () => void; avatarSize?: number;
}) {
  return <button type="button" className={`orbit-row buddy-list-item is-${buddy.status}${selected ? " is-selected" : ""}`} aria-pressed={selected} onClick={onSelect}
    onContextMenu={(event) => { event.preventDefault(); onMenu(); }}
    onKeyDown={(event) => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); onMenu(); } }}
    draggable onDragStart={(event) => { event.dataTransfer.setData("text/plain", buddy.id); onDrag(); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); onDrop(); }}>
    <span className="buddy-list-avatar"><BuddyAvatar id={buddy.id} avatar={buddy.avatar} size={avatarSize} state={buddy.status} />{buddy.status !== "idle" && <span className={`buddy-status-dot is-${buddy.status}`} aria-label={buddy.status} />}</span>
    <span className="buddy-list-copy"><span className="buddy-list-title"><span>{buddy.name}</span><time dateTime={buddy.last_activity_at ?? undefined}>{activityLabel(buddy.last_activity_at)}</time></span>
      <span className="buddy-list-preview">{buddy.status === "waiting" ? "Needs your approval" : buddy.last_message_preview || buddy.description}</span>
    </span>
  </button>;
}
