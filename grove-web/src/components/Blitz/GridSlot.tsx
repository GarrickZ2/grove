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
      <div className="flex flex-col h-full border border-[var(--color-border)] rounded-md overflow-hidden opacity-60">
        {titleBar}
        <div className="flex-1 flex items-center justify-center text-sm text-[var(--color-text-muted)] bg-[var(--color-bg)]">
          Chat unavailable
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full border border-[var(--color-border)] rounded-md overflow-hidden">
      {titleBar}
      <div className="flex-1 overflow-hidden">
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
            onDisconnected={() => setStale(true)}
            onConnected={() => setStale(false)}
          />
        )}
      </div>
    </div>
  );
}
