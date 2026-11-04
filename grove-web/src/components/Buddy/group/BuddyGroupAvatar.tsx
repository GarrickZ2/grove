import type { BuddyGroupMember } from "../../../api/buddyGroups";
import { BuddyAvatar } from "../BuddyAvatar";

/** A group's face: its first two members, overlapped. */
export function BuddyGroupAvatar({ members, size }: { members: Pick<BuddyGroupMember, "buddy_id" | "avatar" | "status">[]; size: number }) {
  const inner = Math.round(size * 0.66);
  return <span className="buddy-group-avatar" style={{ width: size, height: size }} aria-hidden="true">
    {members.slice(0, 2).map((member) => <span key={member.buddy_id}><BuddyAvatar id={member.buddy_id} avatar={member.avatar} size={inner} state={member.status} /></span>)}
  </span>;
}
