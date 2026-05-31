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
  // Which chat (if any) currently shows the "connection lost" overlay, keyed by
  // chatId. Deriving `isStale` from this (below) means a reassignment to a
  // different chat clears the overlay automatically — no render-time setState or
  // identity-reset dance needed.
  const [staleChatId, setStaleChatId] = useState<string | null>(null);

  // Chats we've successfully connected at least once. onDisconnected fires
  // during the initial WS setup (before onConnected), so we only flag a chat
  // stale after it has actually connected — avoids a "Connection lost" flash on
  // a fresh slot mount.
  const connectedChatIdsRef = useRef<Set<string>>(new Set());

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

  const isStale = staleChatId === assignment.chatId;

  return (
    <div className="flex flex-col h-full min-h-0 min-w-0 border border-[var(--color-border)] rounded-md overflow-hidden">
      {titleBar}
      {/* `relative` so the reconnect overlay can layer on top; `flex` (not just
          block) so TaskChat's own `flex-1` resolves to a real height. TaskChat
          stays MOUNTED even when stale — its WS reconnect machinery (backoff
          ladder + wake/liveness poll) lives inside it and must keep running to
          recover. Unmounting it on disconnect (the old `stale ? msg : TaskChat`
          ternary) tore that machinery down and was exactly why grid quadrants
          stayed stuck on "Connection lost" until a manual refresh. */}
      <div className="relative flex-1 flex min-h-0 min-w-0 overflow-hidden">
        <TaskChat
          projectId={liveTask.projectId}
          task={liveTask.task}
          pinnedChatId={assignment.chatId}
          hideHeader={true}
          onConnected={() => {
            connectedChatIdsRef.current.add(assignment.chatId);
            setStaleChatId(null);
          }}
          onDisconnected={() => {
            // Only flag stale once we've actually connected for THIS chat — the
            // initial WS setup fires onDisconnected before onConnected.
            if (connectedChatIdsRef.current.has(assignment.chatId)) {
              setStaleChatId(assignment.chatId);
            }
          }}
        />
        {isStale && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--color-bg)]/80 text-sm text-[var(--color-text-muted)] pointer-events-none">
            Connection lost — reconnecting automatically…
          </div>
        )}
      </div>
    </div>
  );
}
