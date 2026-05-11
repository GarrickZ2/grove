import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, Plus, Settings2, GitBranch, Folder, RefreshCw } from "lucide-react";
import type { BoardCardModel, BoardDetail } from "./types";
import { SYNC_META, MODE_BADGE } from "./utils";
import { Avatar } from "./Avatar";
import { BoardColumnView } from "./BoardColumn";
import { CardDetailDrawer } from "./CardDetailDrawer";
import { BoardSettingsDrawer } from "./BoardSettingsDrawer";

interface BoardViewProps {
  board: BoardDetail;
  cards: BoardCardModel[];
  onBack: () => void;
  onCardsChange: (cards: BoardCardModel[]) => void;
  onBoardUpdate: (board: BoardDetail) => void;
}

export function BoardView({ board, cards, onBack, onCardsChange, onBoardUpdate }: BoardViewProps) {
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null);
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const cardsByColumn = useMemo(() => {
    const map = new Map<string, BoardCardModel[]>();
    for (const col of board.columns) map.set(col.id, []);
    for (const card of cards) {
      const arr = map.get(card.columnId);
      if (arr) arr.push(card);
    }
    return map;
  }, [board.columns, cards]);

  function moveCard(cardId: string, columnId: string) {
    const card = cards.find((c) => c.id === cardId);
    if (!card || card.columnId === columnId) return;

    // State machine gate. Only the owner can move a card. Unowned cards stay
    // pinned to Backlog and must be claimed via the drawer first.
    if (card.ownerEmail !== board.currentUserEmail) return;

    const target = board.columns.find((c) => c.id === columnId);
    const updated: BoardCardModel = {
      ...card,
      columnId,
      updatedAt: new Date().toISOString(),
    };
    // Moving back to Backlog auto-releases ownership.
    if (target?.anchor === "backlog") {
      updated.ownerEmail = null;
    }
    onCardsChange(cards.map((c) => (c.id === cardId ? updated : c)));
  }

  function addCard() {
    const backlog = board.columns.find((c) => c.anchor === "backlog");
    if (!backlog) return;
    const now = new Date().toISOString();
    const card: BoardCardModel = {
      id: `card-new-${cards.length + 1}`,
      boardId: board.id,
      columnId: backlog.id,
      title: "Untitled card",
      ownerEmail: null,
      sessions: [],
      createdAt: now,
      updatedAt: now,
    };
    onCardsChange([...cards, card]);
    setOpenCardId(card.id);
  }

  function updateCard(updated: BoardCardModel) {
    onCardsChange(cards.map((c) => (c.id === updated.id ? updated : c)));
  }

  const openCard = openCardId ? cards.find((c) => c.id === openCardId) ?? null : null;
  const syncMeta = SYNC_META[board.sync];
  const primaryProject = board.projects.find((p) => p.primary);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={onBack}
            className="p-1.5 rounded-lg hover:bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            title="Back to boards"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold text-[var(--color-text)] truncate">{board.name}</h1>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded-md font-semibold uppercase tracking-wider ${MODE_BADGE[board.mode].cls}`}
              >
                {MODE_BADGE[board.mode].label}
              </span>
            </div>
            <div className="flex items-center gap-3 mt-0.5 text-[11.5px] text-[var(--color-text-muted)]">
              <span className="flex items-center gap-1">
                <Folder className="w-3 h-3" />
                {primaryProject?.name ?? "—"}
              </span>
              {board.mode === "online" && board.branch && (
                <span className="flex items-center gap-1">
                  <GitBranch className="w-3 h-3" />
                  <span className="font-mono">{board.branch}</span>
                </span>
              )}
              {board.mode === "online" && (
                <span className={`flex items-center gap-1 ${syncMeta.text}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${syncMeta.dot}`} />
                  {syncMeta.label}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex -space-x-1.5">
            {board.members.slice(0, 4).map((m) => (
              <Avatar
                key={m.email}
                member={m}
                size={26}
                ringClass="ring-2 ring-[var(--color-bg)]"
              />
            ))}
            {board.members.length > 4 && (
              <div
                className="flex items-center justify-center rounded-full bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] text-[10px] font-medium ring-2 ring-[var(--color-bg)]"
                style={{ width: 26, height: 26 }}
              >
                +{board.members.length - 4}
              </div>
            )}
          </div>
          <button
            className="p-2 rounded-lg hover:bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            className="p-2 rounded-lg hover:bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            title="Board settings"
          >
            <Settings2 className="w-3.5 h-3.5" />
          </button>
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={addCard}
            title="New card (goes to Backlog)"
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-[var(--color-highlight)] text-white hover:opacity-90"
          >
            <Plus className="w-3.5 h-3.5" />
            New card
          </motion.button>
        </div>
      </div>

      {/* Columns */}
      <div className="flex-1 min-h-0 mt-3 overflow-x-auto overflow-y-hidden">
        <div className="flex gap-3 h-full pb-1">
          {board.columns.map((col) => (
            <BoardColumnView
              key={col.id}
              column={col}
              cards={cardsByColumn.get(col.id) ?? []}
              members={board.members}
              draggingCardId={draggingCardId}
              currentUserEmail={board.currentUserEmail}
              onCardClick={setOpenCardId}
              onCardDragStart={setDraggingCardId}
              onCardDragEnd={() => setDraggingCardId(null)}
              onCardDrop={moveCard}
            />
          ))}
        </div>
      </div>

      {openCard && (
        <CardDetailDrawer
          card={openCard}
          board={board}
          onClose={() => setOpenCardId(null)}
          onUpdate={updateCard}
        />
      )}

      <BoardSettingsDrawer
        board={board}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onUpdate={onBoardUpdate}
      />
    </div>
  );
}
