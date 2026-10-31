import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Buddy } from "../../../api/buddies";
import type { Activity } from "./buddyTimelineState";
import { BuddyAvatar } from "../BuddyAvatar";

function ActivityStep({ step, index }: { step: Activity["steps"][number]; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  return <div className="buddy-activity-step">
    <button type="button" className="buddy-activity-step-toggle" aria-label={`${expanded ? "Hide" : "Show"} details for step ${index + 1}`} aria-describedby={`${id}-title`} aria-expanded={expanded} aria-controls={expanded ? `${id}-details` : undefined} onClick={() => setExpanded(!expanded)}>
      <ChevronDown size={12} aria-hidden="true" />
      <span id={`${id}-title`} className="buddy-activity-step-title">{step.title}</span>
    </button>
    {expanded && <pre id={`${id}-details`} className="buddy-activity-step-content" tabIndex={0} aria-label={`Step ${index + 1} details`}>{step.title}</pre>}
  </div>;
}

export function ActivityLine({ activity, buddy }: { activity: Activity; buddy: Buddy }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const seconds = Math.max(0, Math.round(((activity.ended ?? activity.started) - activity.started) / 1000));
  return <div className="buddy-activity"><div className="buddy-activity-line">{!activity.ended && <BuddyAvatar id={buddy.id} avatar={buddy.avatar} size={22} state="working" />}<button type="button" className={!activity.ended ? "buddy-working" : ""} aria-expanded={expanded} aria-controls={expanded ? detailsId : undefined} onClick={() => setExpanded(!expanded)}><span className="buddy-activity-summary">{activity.ended ? `Worked for ${seconds >= 60 ? `${Math.floor(seconds / 60)}m ` : ""}${seconds % 60}s · ${activity.steps.length} steps` : activity.steps.at(-1)?.title || "Working…"}</span><ChevronDown size={13} aria-hidden="true" /></button></div>
    {expanded && <div id={detailsId} className="buddy-activity-details" role="region" aria-label="Activity steps" tabIndex={0}>{activity.steps.map((step, index) => <ActivityStep key={step.id} step={step} index={index} />)}</div>}
  </div>;
}
