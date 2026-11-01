import type { CSSProperties } from "react";
import type { BuddyStatus } from "../../api/buddies";
import { buddyAvatarShapeStyle, resolveBuddyAvatar } from "./buddyAvatarConfig";
import "./buddy-avatar.css";

export function BuddyAvatar({ id, avatar, size = 30, state = "idle", label }: { id: string; avatar?: string | null; size?: number; state?: BuddyStatus; label?: string }) {
  const value = resolveBuddyAvatar(id, avatar);
  // Stable 0–1 phase from the id so Buddies on screen together don't move in unison.
  let hash = 0;
  for (let index = 0; index < id.length; index++) hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  return <span
    className={`buddy-av is-${state}`}
    role={label ? "img" : undefined}
    aria-label={label}
    aria-hidden={label ? undefined : true}
    data-shape={value.shape}
    data-color={value.color}
    style={{ width: size, height: size, fontSize: size, "--buddy-phase": (hash % 1000) / 1000, ...buddyAvatarShapeStyle(value.shape, value.color) } as CSSProperties}
  >
    <span className="buddy-av__eyes"><span className="buddy-av__eye" /><span className="buddy-av__eye" /></span>
  </span>;
}
