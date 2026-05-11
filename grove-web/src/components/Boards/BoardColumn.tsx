import { useState } from "react";
import { motion } from "framer-motion";
import type { BoardCardModel, BoardColumn as BoardColumnT, BoardMember } from "./types";
import { BoardCard } from "./BoardCard";

interface BoardColumnProps {
  column: BoardColumnT;
  cards: BoardCardModel[];
  members: BoardMember[];
  draggingCardId: string | null;
  currentUserEmail: string;
  onCardClick: (id: string) => void;
  onCardDragStart: (id: string) => void;
  onCardDragEnd: () => void;
  onCardDrop: (cardId: string, columnId: string) => void;
}

export function BoardColumnView({
  column,
  cards,
  members,
  draggingCardId,
  currentUserEmail,
  onCardClick,
  onCardDragStart,
  onCardDragEnd,
  onCardDrop,
}: BoardColumnProps) {
  const [isOver, setIsOver] = useState(false);

  return (
    <div className="flex flex-col w-[280px] flex-shrink-0 h-full">
      <div className="flex items-center justify-between px-2 pb-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            {column.name}
          </span>
          <span className="text-[10px] font-medium text-[var(--color-text-muted)] bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 rounded-full leading-none">
            {cards.length}
          </span>
        </div>
      </div>

      <motion.div
        layout
        onDragOver={(e) => {
          e.preventDefault();
          if (!isOver) setIsOver(true);
        }}
        onDragLeave={() => setIsOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          const cardId = e.dataTransfer.getData("text/plain");
          setIsOver(false);
          if (cardId) onCardDrop(cardId, column.id);
        }}
        className={`flex-1 min-h-[120px] rounded-xl px-2 pt-1.5 pb-2 space-y-2 overflow-y-auto transition-colors
          ${isOver
            ? "bg-[var(--color-highlight)]/8 ring-1 ring-[var(--color-highlight)]/30"
            : "bg-[var(--color-bg-secondary)]/50"
          }`}
      >
        {cards.length === 0 && !isOver && (
          <div className="text-[11px] text-[var(--color-text-muted)] py-6 text-center">No cards</div>
        )}
        {cards.map((card) => (
          <BoardCard
            key={card.id}
            card={card}
            members={members}
            isDragging={draggingCardId === card.id}
            currentUserEmail={currentUserEmail}
            onClick={() => onCardClick(card.id)}
            onDragStart={() => onCardDragStart(card.id)}
            onDragEnd={onCardDragEnd}
          />
        ))}
      </motion.div>
    </div>
  );
}
