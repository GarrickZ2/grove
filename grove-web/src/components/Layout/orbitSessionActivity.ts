import type { NodeStatus } from "../../api/walkieTalkie";

export interface SessionActivity {
  projectId: string;
  chatId: string;
  status?: NodeStatus;
  waitingForInput: boolean;
  unreadCompletion: boolean;
}

export type SessionActivityState = Record<string, SessionActivity>;
export type ViewedSession = { projectId: string; chatId: string } | null;
export type SessionActivityAction =
  | { type: "status"; key: string; projectId: string; chatId: string; status: NodeStatus; viewed: ViewedSession }
  | { type: "input"; key: string; projectId: string; chatId: string; waiting: boolean }
  | { type: "snapshot"; chats: SessionActivityState; viewed: ViewedSession }
  | { type: "viewed"; viewed: ViewedSession };

function isViewed(session: SessionActivity, viewed: ViewedSession) {
  return viewed?.projectId === session.projectId && viewed.chatId === session.chatId;
}

function transition(previous: SessionActivity | undefined, next: SessionActivity, viewed: ViewedSession): SessionActivity {
  const clearsCompletion = next.waitingForInput || next.status === "permission_required" || next.status === "busy" || next.status === "connecting" || isViewed(next, viewed);
  return {
    ...next,
    unreadCompletion: !clearsCompletion && (!!previous?.unreadCompletion || (previous?.status === "busy" && next.status === "idle")),
  };
}

export function sessionActivityReducer(state: SessionActivityState, action: SessionActivityAction): SessionActivityState {
  switch (action.type) {
    case "status": {
      const previous = state[action.key];
      return { ...state, [action.key]: transition(previous, {
        projectId: action.projectId, chatId: action.chatId, status: action.status,
        waitingForInput: action.status !== "disconnected" && !!previous?.waitingForInput,
        unreadCompletion: false,
      }, action.viewed) };
    }
    case "input": {
      const previous = state[action.key];
      return { ...state, [action.key]: {
        ...previous, projectId: action.projectId, chatId: action.chatId,
        waitingForInput: action.waiting,
        unreadCompletion: action.waiting ? false : !!previous?.unreadCompletion,
      } };
    }
    case "snapshot": {
      // A missing handle is disconnected, never evidence of completion.
      const next: SessionActivityState = Object.fromEntries(Object.entries(state).map(([key, value]) => [key, {
        ...value, status: undefined, waitingForInput: false,
      }]));
      for (const [key, value] of Object.entries(action.chats)) {
        next[key] = transition(state[key], value, action.viewed);
      }
      return next;
    }
    case "viewed":
      return Object.fromEntries(Object.entries(state).map(([key, value]) => [key,
        isViewed(value, action.viewed) && value.unreadCompletion ? { ...value, unreadCompletion: false } : value,
      ]));
  }
}
