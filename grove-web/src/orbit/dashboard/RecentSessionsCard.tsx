import { resolveAgentIcon } from "../../utils/agentIcon";
import { liveChatKey, type LiveChats } from "./liveChats";
import { Card, EmptyState, StatusDot, formatDateTime, shortAgo } from "../ui";
import { taskLabel } from "./dashboardModel";
import type { RecentSession } from "./useRecentSessions";

interface RecentSessionsCardProps {
  projectId: string;
  sessions: RecentSession[];
  loaded: boolean;
  chats: LiveChats;
  taskNames: Map<string, string>;
  now: number;
  onOpen: (taskId: string, chatId: string) => void;
}

/** The project's sessions, most recently active first, with a dot on the ones running now. */
export function RecentSessionsCard({ projectId, sessions, loaded, chats, taskNames, now, onOpen }: RecentSessionsCardProps) {
  return (
    <Card className="odb-recent" aria-label="Recent sessions" title="Recent sessions" hint={loaded ? sessions.length : null}>
      <div className="oui-card-list oui-scroll">
        {!loaded ? (
          <div className="odb-ctx-loading" aria-hidden="true"><span className="oui-skel" /><span className="oui-skel" /></div>
        ) : sessions.length === 0 ? (
          <EmptyState>No sessions yet. Start one from New.</EmptyState>
        ) : sessions.map(({ taskId, chat, activeAt }, index) => {
          const live = chats[liveChatKey(projectId, taskId, chat.id)];
          const state = !live ? null
            : live.status === "permission_required" || live.waitingForInput ? "waiting"
              : live.status === "busy" || live.status === "connecting" ? "live" : null;
          const agent = resolveAgentIcon(chat.agent);
          const AgentIcon = agent.Component;
          return (
            <button
              key={`${taskId}:${chat.id}`}
              type="button"
              className="odb-sess"
              style={{ animationDelay: `${260 + Math.min(index, 8) * 35}ms` }}
              onClick={() => onOpen(taskId, chat.id)}
            >
              <span className="odb-sess-ic" title={agent.label}><AgentIcon size={13} /></span>
              <span className="odb-sess-copy">
                <b title={chat.title}>{chat.title || "Untitled session"}</b>
                <span>{taskLabel(taskId, taskNames.get(taskId))}</span>
              </span>
              {state ? <StatusDot tone={state} ring pulse={state === "live"} label={state === "live" ? "Running" : "Waiting on you"} /> : null}
              <span className="odb-sess-ago" title={`${chat.updated_at ? "Last active" : "Started"} ${formatDateTime(activeAt)}`}>{activeAt ? shortAgo(activeAt, now) : ""}</span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}
