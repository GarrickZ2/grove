import { useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { TaskChat } from "../Tasks/TaskView/TaskChat";
import type { BlitzTask } from "../../data/types";
import { EmptyGridSlot } from "./EmptyGridSlot";
import type { SlotAssignment } from "./useBlitzGrid";

interface GridSlotProps {
  slotIdx: number;
  assignment: SlotAssignment | null;
  blitzTasks: BlitzTask[];
  onAssign: (slotIdx: number, assignment: SlotAssignment) => void;
  onClear: (slotIdx: number) => void;
}

export function GridSlot({ slotIdx, assignment, blitzTasks, onAssign, onClear }: GridSlotProps) {
  const [stale, setStale] = useState(false);

  // Reset stale when the slot's chat identity changes (clear → reassign).
  // Without this, the prior chat's disconnect would leak into the new one's
  // first render frame, briefly flashing "Connection lost" before
  // onConnected fires for the new TaskChat. Uses React's
  // adjust-state-during-render pattern (per react.dev/reference/react/useState
  // "Storing information from previous renders") so eslint's
  // react-hooks/set-state-in-effect doesn't fire.
  const prevChatIdRef = useRef<string | undefined>(assignment?.chatId);
  if (prevChatIdRef.current !== assignment?.chatId) {
    prevChatIdRef.current = assignment?.chatId;
    setStale(false);
  }

  // Track whether onConnected has ever fired for the current assignment.
  // onDisconnected fires during initial WebSocket setup (before onConnected),
  // so without this guard every fresh slot mount would flash "Connection lost".
  // This ref is reset inside onConnected/onDisconnected by comparing against
  // the stable assignment?.chatId captured at render time — no render-time
  // ref writes needed, keeping the react-hooks/refs lint rule happy.
  const wasConnectedRef = useRef<{ chatId: string | undefined; value: boolean }>({
    chatId: assignment?.chatId,
    value: false,
  });

  const liveTask = useMemo(() => {
    if (!assignment) return null;
    return blitzTasks.find(
      (bt) => bt.projectId === assignment.projectId && bt.task.id === assignment.taskId,
    );
  }, [assignment, blitzTasks]);

  if (!assignment) {
    return (
      <EmptyGridSlot blitzTasks={blitzTasks} onSelect={(a) => onAssign(slotIdx, a)} />
    );
  }

  const titleBar = (
    <div className="flex items-center justify-between px-3 py-1.5 text-xs border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
      <span className="truncate text-[var(--color-text)]">
        <span className="text-[var(--color-text-muted)]">{assignment.projectName}</span>
        <span className="mx-1 text-[var(--color-text-muted)]">·</span>
        <span>{assignment.taskName}</span>
        <span className="mx-1 text-[var(--color-text-muted)]">·</span>
        <span className="text-[var(--color-accent)]">{assignment.chatName}</span>
      </span>
      <button
        type="button"
        aria-label={`Clear slot ${slotIdx + 1}`}
        onClick={() => onClear(slotIdx)}
        className="p-1 rounded hover:brightness-125 text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-all"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );

  if (!liveTask) {
    return (
      <div className="flex flex-col h-full min-h-0 min-w-0 border border-[var(--color-border)] rounded-md overflow-hidden opacity-60">
        {titleBar}
        <div className="flex-1 flex items-center justify-center text-sm text-[var(--color-text-muted)] bg-[var(--color-bg)]">
          Chat unavailable
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0 min-w-0 border border-[var(--color-border)] rounded-md overflow-hidden">
      {titleBar}
      {/* `flex` (not just block) so TaskChat's own `flex-1` resolves to a
          real height. Without this the chat body collapses to zero and
          only the title bar + composer are visible. */}
      <div className="flex-1 flex min-h-0 min-w-0 overflow-hidden">
        {stale ? (
          <div className="h-full flex items-center justify-center text-sm text-[var(--color-text-muted)]">
            Connection lost — click the slot's clear button and reassign to retry.
          </div>
        ) : (
          <TaskChat
            projectId={liveTask.projectId}
            task={liveTask.task}
            pinnedChatId={assignment.chatId}
            hideHeader={true}
            onConnected={() => {
              wasConnectedRef.current = { chatId: assignment.chatId, value: true };
              setStale(false);
            }}
            onDisconnected={() => {
              // Only show stale if we've previously connected for *this* chat.
              // If the chatId has changed since wasConnectedRef was last set,
              // this is a stale closure and we ignore it.
              if (
                wasConnectedRef.current.chatId === assignment.chatId &&
                wasConnectedRef.current.value
              ) {
                setStale(true);
              }
            }}
          />
        )}
      </div>
    </div>
  );
}
