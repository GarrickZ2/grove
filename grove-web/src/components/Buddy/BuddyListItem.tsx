import type { HTMLAttributes, Ref } from "react";
import type { BuddyListEntry } from "../../api/buddyGroups";
import { BuddyAvatar } from "./BuddyAvatar";
import { BuddyGroupAvatar } from "./group/BuddyGroupAvatar";

function activityLabel(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  today.setDate(today.getDate() - 1);
  return date.toDateString() === today.toDateString() ? "Yesterday" : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function BuddyListItem({ buddy, selected, unread = false, onSelect, onMenu, sortable, avatarSize = 30 }: {
  buddy: BuddyListEntry; selected: boolean; unread?: boolean; onSelect: () => void; onMenu: (at: { x: number; y: number }) => void;
  sortable?: HTMLAttributes<HTMLElement> & { ref: Ref<HTMLElement> }; avatarSize?: number;
}) {
  const { ref, ...handlers } = sortable ?? { ref: undefined };
  return <button type="button" ref={ref as Ref<HTMLButtonElement> | undefined} {...handlers} className={`orbit-row buddy-list-item is-${buddy.status}${buddy.waiting_delegations > 0 ? " has-waiting" : ""}${selected ? " is-selected" : ""}${unread ? " is-unread" : ""}`} aria-pressed={selected} onClick={onSelect}
    onContextMenu={(event) => { event.preventDefault(); onMenu({ x: event.clientX, y: event.clientY }); }}
    onKeyDown={(event) => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); onMenu({ x: rect.left + 24, y: rect.bottom }); } }}>
    <span className="buddy-list-avatar">{buddy.group ? <BuddyGroupAvatar members={buddy.group.members} size={avatarSize} /> : <BuddyAvatar id={buddy.id} avatar={buddy.avatar} size={avatarSize} state={buddy.status} />}{buddy.status !== "idle" && <span className={`buddy-status-dot is-${buddy.status}`} aria-label={buddy.status} />}</span>
    <span className="buddy-list-copy"><span className="buddy-list-title"><span>{buddy.name}</span><time dateTime={buddy.last_activity_at ?? undefined}>{activityLabel(buddy.last_activity_at)}</time>{unread && <span className="buddy-unread-dot" aria-label="Unread" />}</span>
      <span className="buddy-list-preview">{buddy.status === "waiting" ? "Needs your approval" : buddy.waiting_delegations > 0 ? "A subagent needs you" : buddy.last_message_preview || buddy.description}</span>
    </span>
  </button>;
}
