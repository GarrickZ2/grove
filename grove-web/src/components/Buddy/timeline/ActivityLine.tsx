import type { Buddy } from "../../../api/buddies";
import type { Activity } from "./buddyTimelineState";
import { BuddyAvatar } from "../BuddyAvatar";
import { friendlyStep } from "./activityLabels";

export function ActivityLine({ activity, buddy }: { activity: Activity; buddy: Buddy }) {
  if (activity.ended) {
    const seconds = Math.max(0, Math.round((activity.ended - activity.started) / 1000));
    return <p className="buddy-activity buddy-activity-done">Worked for {seconds >= 60 ? `${Math.floor(seconds / 60)}m ` : ""}{seconds % 60}s</p>;
  }
  return <div className="buddy-activity" role="status"><div className="buddy-activity-line"><BuddyAvatar id={buddy.id} avatar={buddy.avatar} size={22} state="working" /><span className="buddy-activity-summary buddy-working">{friendlyStep(activity.steps.at(-1)?.title ?? "")}</span></div></div>;
}
