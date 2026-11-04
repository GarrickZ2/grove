import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import { ArrowLeft, File, PanelRight, PictureInPicture2 } from "lucide-react";
import type { ReactNode } from "react";
import type { BuddySummary } from "../../../api/buddies";
import { askBuddyGroupMember, GROUP_REF_PREFIX, type BuddyGroup, type BuddyGroupMember, type BuddyGroupMessage } from "../../../api/buddyGroups";
import { useBuddyGroupConversation } from "../../../hooks/useBuddyGroupConversation";
import { useDelegationRequests } from "../../../hooks/useBuddyDelegations";
import type { BuddyDelegation } from "../../../api/buddies";
import { invokeQuiet, isTauriShell } from "../../../utils/tauriShell";
import { MarkdownRenderer } from "../../ui/MarkdownRenderer";
import { BuddyAvatar } from "../BuddyAvatar";
import { BuddyComposer } from "../BuddyComposer";
import { resolveBuddyAvatar } from "../buddyAvatarConfig";
import { EVERYONE_ID, mentionRuns, type MentionedBuddy } from "../buddyMentions";
import { BuddyDelegationsContext, useBuddyDelegationsContext } from "../delegations/buddyDelegationsContext";
import { DelegationRequestCards } from "../delegations/DelegationRequestCards";
import { HelloBurst } from "../timeline/BuddyHello";
import { BuddyGroupAvatar } from "./BuddyGroupAvatar";
import { groupRows, quietText } from "./groupTimeline";
import "./buddy-group.css";

export function BuddyGroupHeader({ group, panelOpen, onPanel, onBack, phone = false, leading }: { group: BuddyGroup; panelOpen: boolean; onPanel: () => void; onBack?: () => void; phone?: boolean; leading?: ReactNode }) {
  const working = group.members.filter((member) => member.status === "working").map((member) => member.name);
  const waiting = group.members.filter((member) => member.status === "waiting").map((member) => member.name);
  const count = `${group.members.length} ${group.members.length === 1 ? "Buddy" : "Buddies"}`;
  const state = waiting.length ? `${waiting.join(", ")} waiting for you` : working.length ? `${working.join(", ")} working` : "";
  return <header className="buddy-conversation-header" data-tauri-drag-region="deep" data-window-drag-strip>
    {leading}
    {phone && <button type="button" className="orbit-icon-button buddy-icon-button" aria-label="Back to Buddies" onClick={onBack}><ArrowLeft /></button>}
    <BuddyGroupAvatar members={group.members} size={phone ? 30 : 28} />
    <div className="buddy-header-copy"><h2>{group.name}</h2><p className={`buddy-header-status${waiting.length ? " is-waiting" : working.length ? " is-working" : ""}`}>{count}{state && ` · ${state}`}</p></div>
    {isTauriShell && !phone && <button type="button" className="orbit-icon-button buddy-icon-button" aria-label="Open in mini window" title="Open in mini window" onClick={() => { void invokeQuiet("buddy_mini_open", { buddyId: `${GROUP_REF_PREFIX}${group.id}` }); }}><PictureInPicture2 /></button>}
    <button type="button" className="orbit-icon-button buddy-icon-button" aria-label={panelOpen ? "Close group panel" : "Open group panel"} aria-expanded={panelOpen} onClick={onPanel}><PanelRight /></button>
  </header>;
}

function Spoken({ message, known }: { message: BuddyGroupMessage; known: MentionedBuddy[] }) {
  const files = message.attachments.map((file) => <span className="buddy-file" key={file.path}><File size={14} />{file.name}</span>);
  if (message.sender_kind === "buddy") return <div className="buddy-assistant-message"><MarkdownRenderer content={message.text} />{files}</div>;
  return <div className="buddy-user-turn"><div className="buddy-user-message">
    {mentionRuns(message.text, known).map((run, index) => "buddy" in run ? <span key={index} className="buddy-group-mention">@{run.buddy.name}</span> : <span key={index}>{run.text}</span>)}
    {files}
  </div></div>;
}

/** A new group's arrival: its members drop in one after another, then the burst. */
function GroupHello({ group }: { group: BuddyGroup }) {
  const shown = group.members.slice(0, 5);
  const first = shown[0];
  const { color } = resolveBuddyAvatar(first?.buddy_id ?? group.id, first?.avatar ?? null);
  return <div className="buddy-hello is-arriving buddy-group-hello" style={{ "--buddy-color": color, "--landed": `${Math.max(shown.length - 1, 0) * 0.14}s` } as CSSProperties}>
    <div className="buddy-hello-stage" aria-hidden="true">
      <HelloBurst color={color} />
      <span className="buddy-group-hello-row">{shown.map((member, index) => <span key={member.buddy_id} className="buddy-hello-avatar" style={{ "--i": index } as CSSProperties}><BuddyAvatar id={member.buddy_id} avatar={member.avatar} size={52} /></span>)}</span>
    </div>
    <h2>{group.name}</h2>
    <p>{group.members.map((member) => member.name).join(", ")}</p>
    <small>Say something, or @ someone to start.</small>
  </div>;
}

/** Someone coming or going, with a little movement when it happens while you watch. */
function MemberEvent({ text, buddyId, avatar, joined, fresh }: { text: string; buddyId: string; avatar: string | null; joined: boolean; fresh: boolean }) {
  return <p className={`buddy-event buddy-group-arrival ${joined ? "is-join" : "is-leave"}${fresh ? " is-fresh" : ""}`}><span className="buddy-group-arrival-avatar"><BuddyAvatar id={buddyId} avatar={avatar} size={18} /></span>{text}</p>;
}

export function BuddyGroupConversation({ group, buddies, onChanged, arriving = false, compact = false }: { group: BuddyGroup; buddies: BuddySummary[]; onChanged: () => void; arriving?: boolean; compact?: boolean }) {
  const { messages, openedAt, hasEarlier, loadingEarlier, loadEarlier, error, activity, transport } = useBuddyGroupConversation(group, onChanged);
  const nameOf = (id: string) => group.members.find((member) => member.buddy_id === id)?.name ?? buddies.find((buddy) => buddy.id === id)?.name ?? "A Buddy";
  const known: MentionedBuddy[] = [...group.members.map((member) => ({ id: member.buddy_id, name: member.name, avatar: member.avatar, role: member.role ?? "" })), { id: EVERYONE_ID, name: "everyone", avatar: null, role: "" }];
  const working = group.members.filter((member) => member.status === "working");
  const rows = groupRows(messages, nameOf, working.length > 0);
  const mentionable: BuddySummary[] = useMemo(() => [
    { id: EVERYONE_ID, name: "everyone", role: `${group.members.length} Buddies`, avatar: null, status: "idle" } as BuddySummary,
    ...group.members.map((member) => ({ id: member.buddy_id, name: member.name, role: member.status === "working" ? "Working" : member.role ?? "", avatar: member.avatar, status: member.status }) as BuddySummary),
  ], [group.members]);
  const waiting = group.members.filter((member) => member.status === "waiting");
  // A member waiting on the user looks just like a waiting subagent: same replay, same cards.
  const pending = waiting.map((member) => ({ id: member.buddy_id, title: member.name, status: "waiting", target_project: member.project_hash, target_task: member.task_id, target_session: member.session_id }) as BuddyDelegation);
  const requests = useDelegationRequests(pending);
  const delegations = useBuddyDelegationsContext();
  const scroll = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const tail = `${messages.at(-1)?.seq ?? 0}|${working.length}|${waiting.length}`;
  useEffect(() => { const node = scroll.current; if (node && following.current) node.scrollTop = node.scrollHeight; }, [tail]);
  const target = { id: group.id, name: group.name, status: group.status, project_hash: "", local_task_id: "", active_session_id: "group" };
  const member = (id: string): BuddyGroupMember | undefined => group.members.find((item) => item.buddy_id === id);
  return <BuddyDelegationsContext.Provider value={{ ...delegations, requests }}><div className="buddy-conversation">
    {error && <p role="alert">{error}</p>}
    <div className="buddy-timeline" aria-label="Group conversation" ref={scroll} onScroll={(event) => { const node = event.currentTarget; following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; }}>
      <div className="buddy-timeline-content">
        {hasEarlier && <p className="buddy-earlier" role="status">{loadingEarlier ? "Loading earlier messages…" : <button type="button" onClick={() => void loadEarlier()}>Load earlier messages</button>}</p>}
        {!rows.length && (arriving ? <GroupHello group={group} /> : <p className="buddy-event">Say something, or @ someone to start.</p>)}
        {rows.map((row) => {
          if (row.kind === "system") return row.buddyId
            ? <MemberEvent key={row.id} text={row.text} buddyId={row.buddyId} avatar={member(row.buddyId)?.avatar ?? buddies.find((buddy) => buddy.id === row.buddyId)?.avatar ?? null} joined={row.joined} fresh={openedAt !== null && row.seq > openedAt} />
            : <p key={row.id} className="buddy-event">{row.text}</p>;
          if (row.kind === "quiet") return <p key={row.id} className="buddy-group-quiet">{quietText(row)}</p>;
          if (row.kind === "failed") return <div key={row.id} className="buddy-group-failed" role="status"><span>{row.name} couldn't finish this turn</span>{member(row.buddyId) && <button type="button" className="buddy-button" onClick={() => void askBuddyGroupMember(group.id, row.buddyId)}>Ask again</button>}</div>;
          if (row.kind === "user") return <Spoken key={row.id} message={row.message} known={known} />;
          const speaker = member(row.message.sender_id ?? "");
          return <div key={row.id} className="buddy-group-message">
            <BuddyAvatar id={row.message.sender_id ?? ""} avatar={speaker?.avatar} size={compact ? 22 : 26} />
            <div className="buddy-group-message-body"><p className="buddy-group-speaker">{nameOf(row.message.sender_id ?? "")}</p><Spoken message={row.message} known={known} /></div>
          </div>;
        })}
        {pending.map((item) => <DelegationRequestCards key={item.id} delegation={item} from={item.title} />)}
        {working.map((item) => <div key={item.buddy_id} className="buddy-group-working" role="status"><BuddyAvatar id={item.buddy_id} avatar={item.avatar} size={18} state="working" /><span>{item.name}: {activity[item.buddy_id] ?? "Thinking…"}</span></div>)}
      </div>
    </div>
    <BuddyComposer buddy={target} onSent={onChanged} mentionable={mentionable} transport={transport} />
  </div></BuddyDelegationsContext.Provider>;
}
