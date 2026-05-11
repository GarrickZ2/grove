import { motion } from "framer-motion";
import { CalendarDays } from "lucide-react";
import type { BoardCardModel, BoardMember, SessionStatus } from "./types";
import { formatDate, memberByEmail } from "./utils";
import { Avatar } from "./Avatar";
import { SessionRow } from "./SessionRow";

interface BoardCardProps {
  card: BoardCardModel;
  members: BoardMember[];
  isDragging?: boolean;
  currentUserEmail: string;
  onClick: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

const STATUS_ORDER: Record<SessionStatus, number> = {
  working: 0,
  idle: 1,
  failed: 2,
  done: 3,
};

const VISIBLE_SESSIONS = 3;

export function BoardCard({
  card,
  members,
  isDragging,
  currentUserEmail,
  onClick,
  onDragStart,
  onDragEnd,
}: BoardCardProps) {
  const assignee = memberByEmail(members, card.assigneeEmail);
  const hasDates = card.startAt || card.dueAt;
  const isOwner = card.ownerEmail === currentUserEmail;
  const canDrag = isOwner;

  const orderedSessions = [...card.sessions].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
  );
  const visible = orderedSessions.slice(0, VISIBLE_SESSIONS);
  const hiddenCount = orderedSessions.length - visible.length;
  const allCompact = orderedSessions.every((s) => s.status === "done" || s.status === "idle");

  return (
    <motion.button
      layout
      draggable={canDrag}
      onDragStart={(e) => {
        if (!canDrag) {
          e.preventDefault();
          return;
        }
        const dt = (e as unknown as DragEvent).dataTransfer;
        if (dt) {
          dt.effectAllowed = "move";
          dt.setData("text/plain", card.id);
        }
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={onClick}
      whileHover={{ y: -1 }}
      whileTap={{ scale: 0.99 }}
      title={canDrag ? undefined : card.ownerEmail === null ? "Claim this card to move it" : "Only the owner can move this card"}
      className={`w-full text-left rounded-lg border bg-[var(--color-bg)] border-[var(--color-border)]
        hover:border-[var(--color-text-muted)]/30 hover:shadow-sm transition-all duration-150
        ${isDragging ? "opacity-40" : "opacity-100"}
        ${canDrag ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"}`}
      style={{ padding: "10px 10px 8px" }}
    >
      <div className="flex items-start justify-between gap-2 mb-1.5 px-0.5">
        <h4 className="text-[13px] font-medium text-[var(--color-text)] leading-snug line-clamp-2 flex-1">
          {card.title}
        </h4>
        <Avatar member={assignee} size={20} />
      </div>

      {card.description && (
        <p className="text-[11.5px] text-[var(--color-text-muted)] line-clamp-2 leading-relaxed mb-1.5 px-0.5">
          {card.description}
        </p>
      )}

      {visible.length > 0 && (
        <div className="space-y-1 mb-1.5">
          {visible.map((s) => (
            <SessionRow key={s.id} session={s} compact={allCompact} />
          ))}
          {hiddenCount > 0 && (
            <div className="text-[10px] text-[var(--color-text-muted)] text-center py-0.5">
              +{hiddenCount} more session{hiddenCount > 1 ? "s" : ""}
            </div>
          )}
        </div>
      )}

      {hasDates && (
        <div className="flex items-center gap-1 text-[10.5px] text-[var(--color-text-muted)] px-0.5">
          <CalendarDays className="w-3 h-3" />
          <span>
            {formatDate(card.startAt)}
            {card.dueAt && ` → ${formatDate(card.dueAt)}`}
          </span>
        </div>
      )}
    </motion.button>
  );
}
