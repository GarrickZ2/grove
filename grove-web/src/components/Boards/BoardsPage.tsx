import { useMemo, useState } from "react";
import { BoardsIndex } from "./BoardsIndex";
import { BoardView } from "./BoardView";
import { CreateBoardDialog } from "./CreateBoardDialog";
import {
  MOCK_BOARDS,
  MOCK_BOARD_DETAILS,
  MOCK_CARDS,
  CURRENT_USER_EMAIL,
} from "./mockData";
import type { BoardCardModel, BoardDetail, BoardSummary } from "./types";

export function BoardsPage() {
  const [boards, setBoards] = useState<BoardSummary[]>(MOCK_BOARDS);
  const [boardDetails, setBoardDetails] = useState<Record<string, BoardDetail>>(MOCK_BOARD_DETAILS);
  const [cardsByBoard, setCardsByBoard] = useState<Record<string, BoardCardModel[]>>(MOCK_CARDS);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const activeBoard = useMemo<BoardDetail | null>(() => {
    if (!activeBoardId) return null;
    return boardDetails[activeBoardId] ?? null;
  }, [activeBoardId, boardDetails]);

  const activeCards = useMemo<BoardCardModel[]>(() => {
    if (!activeBoardId) return [];
    return cardsByBoard[activeBoardId] ?? [];
  }, [activeBoardId, cardsByBoard]);

  function openBoard(id: string) {
    setActiveBoardId(id);
  }

  function closeBoard() {
    setActiveBoardId(null);
  }

  function createBoard(b: BoardSummary) {
    setBoards([b, ...boards]);
    const defaultColumns = [
      { id: "col-backlog", name: "Backlog", anchor: "backlog" as const },
      { id: "col-progress", name: "In Progress" },
      { id: "col-done", name: "Done", anchor: "done" as const },
    ];
    setBoardDetails({
      ...boardDetails,
      [b.id]: {
        ...b,
        columns: defaultColumns,
        members: [
          {
            email: CURRENT_USER_EMAIL,
            name: "You",
            avatarColor: "#f59e0b",
            role: "manager",
          },
        ],
        projects: [
          { id: "proj-host", name: b.primaryProjectName, primary: true },
        ],
        currentUserEmail: CURRENT_USER_EMAIL,
      },
    });
    setCardsByBoard({ ...cardsByBoard, [b.id]: [] });
    setCreateOpen(false);
    setActiveBoardId(b.id);
  }

  function updateCards(boardId: string, cards: BoardCardModel[]) {
    setCardsByBoard({ ...cardsByBoard, [boardId]: cards });
    const count = cards.length;
    const sessionCount = cards.reduce((acc, c) => acc + c.sessions.length, 0);
    setBoards((prev) =>
      prev.map((b) => (b.id === boardId ? { ...b, cardCount: count, sessionCount } : b))
    );
  }

  function updateBoardDetail(detail: BoardDetail) {
    setBoardDetails({ ...boardDetails, [detail.id]: detail });
    setBoards((prev) =>
      prev.map((b) =>
        b.id === detail.id
          ? {
              ...b,
              name: detail.name,
              branch: detail.branch,
              memberCount: detail.members.length,
              linkedProjectCount: detail.projects.length,
              primaryProjectName:
                detail.projects.find((p) => p.primary)?.name ?? b.primaryProjectName,
            }
          : b
      )
    );
  }

  if (activeBoard) {
    return (
      <BoardView
        board={activeBoard}
        cards={activeCards}
        onBack={closeBoard}
        onCardsChange={(cards) => updateCards(activeBoard.id, cards)}
        onBoardUpdate={updateBoardDetail}
      />
    );
  }

  return (
    <>
      <BoardsIndex boards={boards} onOpenBoard={openBoard} onCreate={() => setCreateOpen(true)} />
      <CreateBoardDialog
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={createBoard}
      />
    </>
  );
}
