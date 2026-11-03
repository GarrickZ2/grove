import type { HTMLAttributes, Ref } from "react";
import type { BuddySummary } from "../../api/buddies";
import { BuddyAvatar } from "./BuddyAvatar";
import { resolveBuddyAvatar } from "./buddyAvatarConfig";

/**
 * A pinned Buddy at the top of the list, like a pinned conversation in
 * Messages: a large round portrait (the avatar on a disc of its own color)
 * with the name below and an unread dot.
 */
export function BuddyPinTile({ buddy, selected, unread, size, onSelect, onMenu, sortable }: {
  buddy: BuddySummary; selected: boolean; unread: boolean; size: number; onSelect: () => void;
  onMenu: (at: { x: number; y: number }) => void;
  sortable: HTMLAttributes<HTMLElement> & { ref: Ref<HTMLElement> };
}) {
  const { color } = resolveBuddyAvatar(buddy.id, buddy.avatar);
  const { ref, ...handlers } = sortable;
  return <button type="button" ref={ref as Ref<HTMLButtonElement>} {...handlers}
    className={`buddy-pin${selected ? " is-selected" : ""}${unread ? " is-unread" : ""} is-${buddy.status}`}
    aria-pressed={selected} aria-label={`${buddy.name}${unread ? ", unread" : ""}${buddy.status !== "idle" ? `, ${buddy.status}` : ""}`}
    onClick={onSelect}
    onContextMenu={(event) => { event.preventDefault(); onMenu({ x: event.clientX, y: event.clientY }); }}
    onKeyDown={(event) => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); onMenu({ x: rect.left + rect.width / 2, y: rect.bottom }); } }}>
    <span className="buddy-pin-disc" style={{ width: size, height: size, ["--pin-color" as string]: color }}>
      <BuddyAvatar id={buddy.id} avatar={buddy.avatar} size={size} state={buddy.status} />
      {buddy.status !== "idle" && <span className={`buddy-status-dot is-${buddy.status}`} aria-hidden="true" />}
    </span>
    <span className="buddy-pin-name">{unread && <span className="buddy-unread-dot" aria-hidden="true" />}<span>{buddy.name}</span></span>
  </button>;
}
