import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  X,
  Hand,
  CheckCircle2,
  Calendar,
  User2,
  Plus,
  Trash2,
} from "lucide-react";
import type { BoardCardModel, BoardDetail, SessionBinding } from "./types";
import { formatDate, memberByEmail } from "./utils";
import { Avatar } from "./Avatar";
import { BindSessionDialog } from "./BindSessionDialog";
import { SessionRow } from "./SessionRow";
import { RichPicker } from "./RichPicker";

interface CardDetailDrawerProps {
  card: BoardCardModel | null;
  board: BoardDetail;
  onClose: () => void;
  onUpdate: (card: BoardCardModel) => void;
}

export function CardDetailDrawer({ card, board, onClose, onUpdate }: CardDetailDrawerProps) {
  const [bindOpen, setBindOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState(card?.title ?? "");
  const [draftDescription, setDraftDescription] = useState(card?.description ?? "");
  const [syncedFrom, setSyncedFrom] = useState<{
    id: string;
    title: string;
    description: string | undefined;
  } | null>(card ? { id: card.id, title: card.title, description: card.description } : null);

  if (
    card &&
    (syncedFrom === null ||
      syncedFrom.id !== card.id ||
      syncedFrom.title !== card.title ||
      syncedFrom.description !== card.description)
  ) {
    setSyncedFrom({ id: card.id, title: card.title, description: card.description });
    setDraftTitle(card.title);
    setDraftDescription(card.description ?? "");
  }

  if (!card) return null;
  const c = card;

  const assignee = memberByEmail(board.members, c.assigneeEmail);
  const owner = memberByEmail(board.members, c.ownerEmail);
  const me = board.currentUserEmail;
  const isOwner = c.ownerEmail === me;
  const isUnowned = c.ownerEmail === null;
  const inDone = board.columns.find((col) => col.id === c.columnId)?.anchor === "done";

  function commitTitle() {
    if (draftTitle.trim() && draftTitle !== c.title) {
      onUpdate({ ...c, title: draftTitle.trim(), updatedAt: new Date().toISOString() });
    } else {
      setDraftTitle(c.title);
    }
  }
  function commitDescription() {
    if (draftDescription !== (c.description ?? "")) {
      onUpdate({
        ...c,
        description: draftDescription || undefined,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  function claim() {
    onUpdate({ ...c, ownerEmail: me, updatedAt: new Date().toISOString() });
  }
  function release() {
    const backlog = board.columns.find((col) => col.anchor === "backlog");
    onUpdate({
      ...c,
      ownerEmail: null,
      columnId: backlog?.id ?? c.columnId,
      updatedAt: new Date().toISOString(),
    });
  }
  function markDone() {
    const done = board.columns.find((col) => col.anchor === "done");
    if (!done) return;
    onUpdate({ ...c, columnId: done.id, updatedAt: new Date().toISOString() });
  }
  function setAssignee(email: string | undefined) {
    onUpdate({ ...c, assigneeEmail: email, updatedAt: new Date().toISOString() });
  }
  function setDates(startAt: string | undefined, dueAt: string | undefined) {
    onUpdate({ ...c, startAt, dueAt, updatedAt: new Date().toISOString() });
  }
  function bindSession(binding: SessionBinding) {
    onUpdate({
      ...c,
      sessions: [...c.sessions, binding],
      updatedAt: new Date().toISOString(),
    });
  }
  function unbindSession(id: string) {
    onUpdate({
      ...c,
      sessions: c.sessions.filter((s) => s.id !== id),
      updatedAt: new Date().toISOString(),
    });
  }

  return (
    <>
      <AnimatePresence>
        <motion.div
          key="backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 bg-black/30 z-40"
        />
        <motion.aside
          key="drawer"
          initial={{ x: "100%" }}
          animate={{ x: 0 }}
          exit={{ x: "100%" }}
          transition={{ type: "spring", stiffness: 300, damping: 32 }}
          className="fixed right-0 top-0 bottom-0 w-full sm:w-[480px] bg-[var(--color-bg)] border-l border-[var(--color-border)] shadow-2xl z-50 flex flex-col"
        >
          {/* Header */}
          <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center justify-between">
            <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)] uppercase tracking-wider font-semibold">
              <span>Card</span>
              <span>·</span>
              <span className="normal-case font-normal tracking-normal">
                {board.columns.find((c) => c.id === card.columnId)?.name ?? "Unknown"}
              </span>
            </div>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
            {/* Title */}
            <textarea
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onBlur={commitTitle}
              rows={1}
              className="w-full resize-none bg-transparent border-0 px-0 py-1 text-[18px] font-semibold text-[var(--color-text)] focus:outline-none focus:ring-0 leading-tight"
            />

            {/* Owner banner */}
            <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
              <div className="flex items-center gap-2.5 min-w-0">
                <Hand className="w-4 h-4 text-[var(--color-text-muted)] flex-shrink-0" />
                <div className="min-w-0">
                  <div className="text-[11px] text-[var(--color-text-muted)] uppercase tracking-wider font-semibold">
                    Owner
                  </div>
                  {isUnowned ? (
                    <div className="text-sm text-[var(--color-text-muted)]">Unclaimed</div>
                  ) : (
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <Avatar member={owner} size={18} />
                      <span className="text-sm text-[var(--color-text)]">{owner?.name ?? "Unknown"}</span>
                      {isOwner && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-highlight)]/15 text-[var(--color-highlight)] font-medium">
                          You
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex gap-1.5 flex-shrink-0">
                {isUnowned && (
                  <button
                    onClick={claim}
                    className="px-2.5 py-1.5 text-xs font-medium rounded-md bg-[var(--color-highlight)] text-white hover:opacity-90 transition-opacity"
                  >
                    Claim
                  </button>
                )}
                {isOwner && !inDone && (
                  <>
                    <button
                      onClick={release}
                      className="px-2.5 py-1.5 text-xs font-medium rounded-md border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
                    >
                      Release
                    </button>
                    <button
                      onClick={markDone}
                      className="px-2.5 py-1.5 text-xs font-medium rounded-md bg-emerald-500 text-white hover:opacity-90 flex items-center gap-1"
                    >
                      <CheckCircle2 className="w-3 h-3" />
                      Done
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Meta grid */}
            <div className="grid grid-cols-2 gap-3">
              <MetaField label="Assignee" icon={User2}>
                <RichPicker
                  items={board.members.map((m) => ({
                    id: m.email,
                    visual: <Avatar member={m} size={24} />,
                    label: m.name,
                    sublabel: m.email,
                    searchExtras: m.email,
                  }))}
                  selectedId={card.assigneeEmail ?? null}
                  onSelect={(id) => setAssignee(id ?? undefined)}
                  placeholder="Unassigned"
                  searchable
                  clearable
                  clearLabel="Unassigned"
                  clearVisual={<Avatar size={24} />}
                />
              </MetaField>

              <MetaField label="Dates" icon={Calendar}>
                <div className="flex items-center gap-1.5">
                  <input
                    type="date"
                    value={card.startAt ?? ""}
                    onChange={(e) => setDates(e.target.value || undefined, card.dueAt)}
                    className="flex-1 min-w-0 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-md px-1.5 py-1.5 text-[11px] text-[var(--color-text)] focus:outline-none focus:border-[var(--color-highlight)]"
                  />
                  <span className="text-[var(--color-text-muted)] text-[10px]">→</span>
                  <input
                    type="date"
                    value={card.dueAt ?? ""}
                    onChange={(e) => setDates(card.startAt, e.target.value || undefined)}
                    className="flex-1 min-w-0 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-md px-1.5 py-1.5 text-[11px] text-[var(--color-text)] focus:outline-none focus:border-[var(--color-highlight)]"
                  />
                </div>
              </MetaField>
            </div>

            {/* Description */}
            <div>
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1.5">
                Description
              </div>
              <textarea
                value={draftDescription}
                onChange={(e) => setDraftDescription(e.target.value)}
                onBlur={commitDescription}
                rows={4}
                placeholder="Add a description..."
                className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-sm text-[var(--color-text)] placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-highlight)] resize-y"
              />
            </div>

            {/* Sessions */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  Sessions
                  <span className="ml-1.5 text-[var(--color-text-muted)]/70 normal-case font-normal">
                    ({card.sessions.length})
                  </span>
                </div>
                <button
                  onClick={() => setBindOpen(true)}
                  className="flex items-center gap-1 text-[11px] font-medium text-[var(--color-highlight)] hover:underline"
                >
                  <Plus className="w-3 h-3" />
                  Bind session
                </button>
              </div>

              {card.sessions.length === 0 ? (
                <div className="text-[12px] text-[var(--color-text-muted)] py-3 px-3 rounded-lg border border-dashed border-[var(--color-border)] text-center">
                  No sessions bound. Start one to track agent execution.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {card.sessions.map((s) => (
                    <div key={s.id} className="group relative">
                      <SessionRow session={s} />
                      <button
                        onClick={() => unbindSession(s.id)}
                        className="absolute right-1.5 top-1.5 p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-red-500"
                        title="Unbind"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Assignee preview */}
            {assignee && (
              <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
                <span>Assigned to</span>
                <Avatar member={assignee} size={18} />
                <span className="text-[var(--color-text)] font-medium">{assignee.name}</span>
                {card.startAt && (
                  <>
                    <span>·</span>
                    <span>
                      {formatDate(card.startAt)}
                      {card.dueAt && ` → ${formatDate(card.dueAt)}`}
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
        </motion.aside>
      </AnimatePresence>

      <BindSessionDialog isOpen={bindOpen} onClose={() => setBindOpen(false)} onBind={bindSession} />
    </>
  );
}

interface MetaFieldProps {
  label: string;
  icon: React.ElementType;
  children: React.ReactNode;
}

function MetaField({ label, icon: Icon, children }: MetaFieldProps) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1.5">
        <Icon className="w-3 h-3" />
        {label}
      </div>
      {children}
    </div>
  );
}
