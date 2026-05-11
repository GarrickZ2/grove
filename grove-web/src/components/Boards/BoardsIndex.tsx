import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Plus, Folder, GitBranch, Users, Layers, Sparkles, Search, HardDrive, Globe } from "lucide-react";
import { useTheme } from "../../context";
import { getProjectStyle } from "../../utils/projectStyle";
import type { BoardSummary } from "./types";
import { SYNC_META, MODE_BADGE, formatRelative } from "./utils";
import { ProjectIconSquare } from "./RichPicker";

interface BoardsIndexProps {
  boards: BoardSummary[];
  onOpenBoard: (id: string) => void;
  onCreate: () => void;
}

type ModeFilter = "all" | "online" | "offline";

export function BoardsIndex({ boards, onOpenBoard, onCreate }: BoardsIndexProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ModeFilter>("all");

  const filtered = useMemo(() => {
    let list = boards;
    if (filter !== "all") list = list.filter((b) => b.mode === filter);
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(
        (b) =>
          b.name.toLowerCase().includes(q) ||
          b.primaryProjectName.toLowerCase().includes(q) ||
          (b.branch?.toLowerCase().includes(q) ?? false)
      );
    }
    return list;
  }, [boards, filter, query]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-end justify-between pb-4 border-b border-[var(--color-border)]">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-text)]">Boards</h1>
          <p className="text-[12.5px] text-[var(--color-text-muted)] mt-1 max-w-xl">
            Plan with cards, execute with Tasks. Boards aggregate sessions across projects so
            humans and agents share one management view.
          </p>
        </div>
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={onCreate}
          className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-lg bg-[var(--color-highlight)] text-white hover:opacity-90"
        >
          <Plus className="w-3.5 h-3.5" />
          Create board
        </motion.button>
      </div>

      <div className="flex items-center gap-3 mt-4 mb-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter boards..."
            className="w-full pl-8 pr-3 py-1.5 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-md text-sm text-[var(--color-text)] placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-highlight)]"
          />
        </div>
        <FilterTabs active={filter} onChange={setFilter} />
      </div>

      {filtered.length === 0 ? (
        boards.length === 0 ? (
          <EmptyState onCreate={onCreate} />
        ) : (
          <div className="flex-1 flex items-center justify-center text-[12.5px] text-[var(--color-text-muted)]">
            No boards match your filter.
          </div>
        )
      ) : (
        <div className="flex-1 overflow-y-auto -mx-2 px-2 pb-4">
          <div className="border border-[var(--color-border)] rounded-xl overflow-hidden divide-y divide-[var(--color-border)] bg-[var(--color-bg)]">
            {filtered.map((b) => (
              <BoardListRow key={b.id} board={b} onOpen={() => onOpenBoard(b.id)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FilterTabs({
  active,
  onChange,
}: {
  active: ModeFilter;
  onChange: (m: ModeFilter) => void;
}) {
  const options: { value: ModeFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "online", label: "Online" },
    { value: "offline", label: "Local" },
  ];
  return (
    <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`px-2.5 py-1 text-[11.5px] font-medium rounded transition-colors ${
            active === o.value
              ? "bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm"
              : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

interface BoardListRowProps {
  board: BoardSummary;
  onOpen: () => void;
}

function BoardListRow({ board, onOpen }: BoardListRowProps) {
  const { theme } = useTheme();
  const { color, Icon } = getProjectStyle(board.id, theme.accentPalette);
  const sync = SYNC_META[board.sync];
  const modeMeta = MODE_BADGE[board.mode];
  const ModeIcon = board.mode === "online" ? Globe : HardDrive;

  return (
    <motion.button
      whileHover={{ backgroundColor: "var(--color-bg-secondary)" }}
      onClick={onOpen}
      className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors"
    >
      <ProjectIconSquare color={color} Icon={Icon} size={36} />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-[14px] font-semibold text-[var(--color-text)] truncate">
            {board.name}
          </span>
          <span className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md font-semibold uppercase tracking-wider ${modeMeta.cls}`}>
            <ModeIcon className="w-2.5 h-2.5" />
            {modeMeta.label}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[11.5px] text-[var(--color-text-muted)] flex-wrap">
          <span className="flex items-center gap-1">
            <Folder className="w-3 h-3" />
            {board.primaryProjectName}
          </span>
          {board.linkedProjectCount > 1 && (
            <span className="text-[var(--color-text-muted)]/70">
              +{board.linkedProjectCount - 1} linked
            </span>
          )}
          {board.mode === "online" && board.branch && (
            <>
              <Dot />
              <span className="flex items-center gap-1">
                <GitBranch className="w-3 h-3" />
                <span className="font-mono">{board.branch}</span>
              </span>
            </>
          )}
        </div>
      </div>

      <div className="hidden sm:flex flex-col items-end gap-1 flex-shrink-0 text-[11px] text-[var(--color-text-muted)]">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <Layers className="w-3 h-3" />
            {board.cardCount}
          </span>
          <span className="flex items-center gap-1">
            <Sparkles className="w-3 h-3" />
            {board.sessionCount}
          </span>
          <span className="flex items-center gap-1">
            <Users className="w-3 h-3" />
            {board.memberCount}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {board.mode === "online" ? (
            <span className={`flex items-center gap-1 ${sync.text}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${sync.dot}`} />
              {sync.label}
            </span>
          ) : null}
          <span className="text-[var(--color-text-muted)]">{formatRelative(board.lastActiveAt)}</span>
        </div>
      </div>
    </motion.button>
  );
}

function Dot() {
  return <span className="text-[var(--color-text-muted)]/40">·</span>;
}

interface EmptyStateProps {
  onCreate: () => void;
}

function EmptyState({ onCreate }: EmptyStateProps) {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center max-w-sm">
        <div className="w-12 h-12 mx-auto mb-4 rounded-2xl bg-[var(--color-highlight)]/10 flex items-center justify-center">
          <Layers className="w-6 h-6 text-[var(--color-highlight)]" />
        </div>
        <h2 className="text-base font-semibold text-[var(--color-text)] mb-1.5">No boards yet</h2>
        <p className="text-[13px] text-[var(--color-text-muted)] mb-4 leading-relaxed">
          A board is a kanban of planning cards. Each card can bind to multiple sessions across your
          projects, giving you one place to see what's in flight.
        </p>
        <button
          onClick={onCreate}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-lg bg-[var(--color-highlight)] text-white hover:opacity-90"
        >
          <Plus className="w-3.5 h-3.5" />
          Create your first board
        </button>
      </div>
    </div>
  );
}
