import type { BuddyStatus } from "../../api/buddies";
import { BUDDY_AVATAR_RADIUS, resolveBuddyAvatar } from "./buddyAvatarConfig";
import "./buddy-avatar.css";

export function BuddyAvatar({ id, avatar, size = 30, state = "idle", label }: { id: string; avatar?: string | null; size?: number; state?: BuddyStatus; label?: string }) {
  const value = resolveBuddyAvatar(id, avatar);
  return <span
    className={`buddy-av is-${state}`}
    role={label ? "img" : undefined}
    aria-label={label}
    aria-hidden={label ? undefined : true}
    data-shape={value.shape}
    data-color={value.color}
    style={{ width: size, height: size, fontSize: size, borderRadius: BUDDY_AVATAR_RADIUS[value.shape], background: value.color }}
  >
    <span className="buddy-av__eyes"><span className="buddy-av__eye" /><span className="buddy-av__eye" /></span>
  </span>;
}
