import type { CSSProperties } from "react";
import type { Buddy } from "../../../api/buddies";
import { BuddyAvatar } from "../BuddyAvatar";
import { BUDDY_AVATAR_COLORS, resolveBuddyAvatar } from "../buddyAvatarConfig";

const SPARKS = [0, 45, 90, 135, 180, 225, 270, 315];

/** The glow, rings and sparks of an arrival. */
export function HelloBurst({ color }: { color: string }) {
  return <>
    <span className="buddy-hello-glow" />
    <span className="buddy-hello-ring" /><span className="buddy-hello-ring is-late" />
    {SPARKS.map((angle, index) => <span key={angle} className="buddy-hello-spark" style={{ "--angle": `${angle}deg`, "--spark": index % 2 ? color : BUDDY_AVATAR_COLORS[(index * 3) % BUDDY_AVATAR_COLORS.length], "--reach": `${index % 2 ? 58 : 72}px` } as CSSProperties} />)}
  </>;
}

/** Empty conversation. A freshly created Buddy plays a one-time arrival: drop in, wake up, burst. */
export function BuddyHello({ buddy, arriving = false, loading = false }: { buddy: Buddy; arriving?: boolean; loading?: boolean }) {
  const { color } = resolveBuddyAvatar(buddy.id, buddy.avatar);
  return <div className={`buddy-hello${arriving ? " is-arriving" : ""}`} style={{ "--buddy-color": color } as CSSProperties}>
    <div className="buddy-hello-stage" aria-hidden="true">
      {arriving && <HelloBurst color={color} />}
      <span className="buddy-hello-avatar"><BuddyAvatar id={buddy.id} avatar={buddy.avatar} size={72} /></span>
    </div>
    <h2>{loading ? "Loading conversation…" : arriving ? `Hi, I'm ${buddy.name}` : `Say hi to ${buddy.name}`}</h2>
    {!loading && buddy.role && <p>{buddy.role}</p>}
    {!loading && arriving && <small>Send a first message to get started.</small>}
  </div>;
}
