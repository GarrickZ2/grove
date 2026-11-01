import type { ReactNode } from "react";
import type { NoticeTone } from "./promptEvents";

/**
 * A centered line for something that happened between messages: a subagent
 * reporting back, a Routine running or changing, and later other Buddies
 * messaging this one ("Message from <avatar> Name"). A muted lead says what
 * happened; the chip names who or what, and opens it when clickable.
 */
export function TimelineNotice({ lead, icon, name, tone = "neutral", onClick, label }: { lead: string; icon?: ReactNode; name?: string; tone?: NoticeTone; onClick?: () => void; label?: string }) {
  const chip = <>{icon}<span className="buddy-notice-name">{name}</span></>;
  return <div className={`buddy-notice is-${tone}`}>
    <span>{lead}</span>
    {name && (onClick
      ? <button type="button" className="buddy-notice-chip" onClick={onClick} aria-label={label}>{chip}</button>
      : <span className="buddy-notice-chip">{chip}</span>)}
  </div>;
}
