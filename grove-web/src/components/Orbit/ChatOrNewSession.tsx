import { useEffect, useState, type ReactNode } from "react";
import { BUDDY_NAVIGATE_EVENT } from "../Buddy/buddyNavigation";
import { OrbitNewChat } from "./OrbitNewChat";
import { endNewSession, showNewSession, useNewSession } from "./newSessionDrafts";

const navigate = (page: string, data?: Record<string, unknown>) => {
  window.dispatchEvent(new CustomEvent(BUDDY_NAVIGATE_EVENT, { detail: { page, data } }));
};

/**
 * The Agent's place in a workspace: its chat, or the New composer while a new
 * Session is being written. A chat already shown stays mounted behind it, so
 * its Sessions keep their connections; one not shown yet waits until it is.
 */
export function ChatOrNewSession({ projectId, taskId, taskName, isActive, children }: {
  projectId: string;
  taskId: string;
  taskName: string;
  isActive: boolean;
  children: (chatActive: boolean) => ReactNode;
}) {
  const writing = useNewSession(projectId, taskId);
  const shown = writing && isActive;
  const [chatShown, setChatShown] = useState(!writing);
  if (!writing && !chatShown) setChatShown(true);

  useEffect(() => (shown ? showNewSession(projectId, taskId) : undefined), [shown, projectId, taskId]);

  // Opening one of the Task's Sessions, from anywhere, puts the composer away.
  useEffect(() => {
    if (!writing) return;
    const onSwitch = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string; taskId?: string }>).detail;
      if (detail?.projectId === projectId && detail.taskId === taskId) endNewSession(projectId, taskId, "left");
    };
    // Sent only to the workspace on screen.
    const onSelect = () => { if (isActive) endNewSession(projectId, taskId, "left"); };
    window.addEventListener("grove:switch-chat", onSwitch);
    window.addEventListener("grove:select-chat", onSelect);
    return () => {
      window.removeEventListener("grove:switch-chat", onSwitch);
      window.removeEventListener("grove:select-chat", onSelect);
    };
  }, [writing, isActive, projectId, taskId]);

  return (
    <>
      {chatShown && children(isActive && !writing)}
      {/* Right after the chat, which the layouts size as their own child: hides it (orbit-new-chat.css). */}
      {writing && (
        <div className="orbit-new-slot">
          {shown && <OrbitNewChat key={`${projectId}:${taskId}`} initialTaskId={taskId} workspaceTask={taskName} onNavigate={navigate} />}
        </div>
      )}
    </>
  );
}
