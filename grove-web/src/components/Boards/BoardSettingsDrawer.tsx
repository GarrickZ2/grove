import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  X,
  Settings2,
  Columns3,
  Users,
  Folder,
  ArrowUp,
  ArrowDown,
  Trash2,
  Lock,
  Plus,
  AlertTriangle,
  Crown,
} from "lucide-react";
import type {
  BoardDetail,
  BoardColumn,
  BoardMember,
  MemberRole,
  ProjectRef,
} from "./types";
import { Avatar } from "./Avatar";
import { useProject, useTheme } from "../../context";
import { getProjectStyle } from "../../utils/projectStyle";
import { RichPicker, ProjectIconSquare } from "./RichPicker";

type SettingsTab = "general" | "columns" | "members" | "projects";

const TABS: { id: SettingsTab; label: string; icon: React.ElementType }[] = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "columns", label: "Columns", icon: Columns3 },
  { id: "members", label: "Members", icon: Users },
  { id: "projects", label: "Projects", icon: Folder },
];

interface BoardSettingsDrawerProps {
  board: BoardDetail;
  open: boolean;
  onClose: () => void;
  onUpdate: (board: BoardDetail) => void;
}

export function BoardSettingsDrawer({
  board,
  open,
  onClose,
  onUpdate,
}: BoardSettingsDrawerProps) {
  const [tab, setTab] = useState<SettingsTab>("general");

  const me = board.members.find((m) => m.email === board.currentUserEmail);
  const isManager = me?.role === "manager";

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="settings-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/30 z-40"
          />
          <motion.aside
            key="settings-drawer"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 300, damping: 32 }}
            className="fixed right-0 top-0 bottom-0 w-full sm:w-[520px] bg-[var(--color-bg)] border-l border-[var(--color-border)] shadow-2xl z-50 flex flex-col"
          >
            <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Settings2 className="w-4 h-4 text-[var(--color-text-muted)]" />
                <div>
                  <div className="text-[15px] font-semibold text-[var(--color-text)]">
                    Board settings
                  </div>
                  <div className="text-[11.5px] text-[var(--color-text-muted)]">
                    {board.name}
                  </div>
                </div>
              </div>
              <button
                onClick={onClose}
                className="p-1 rounded hover:bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex items-center gap-1 px-3 pt-3 border-b border-[var(--color-border)]">
              {TABS.map((t) => {
                const Icon = t.icon;
                const active = tab === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    className={`relative flex items-center gap-1.5 px-3 py-2 text-[12.5px] font-medium rounded-t-md transition-colors
                      ${active
                        ? "text-[var(--color-highlight)] bg-[var(--color-highlight)]/10"
                        : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)]"
                      }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {t.label}
                    {active && (
                      <motion.div
                        layoutId="settingsTabIndicator"
                        className="absolute bottom-0 left-2 right-2 h-0.5 bg-[var(--color-highlight)] rounded-full"
                        transition={{ type: "spring", stiffness: 400, damping: 30 }}
                      />
                    )}
                  </button>
                );
              })}
            </div>

            {!isManager && (
              <div className="mx-5 mt-4 flex items-center gap-2 px-3 py-2 rounded-md border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 text-[11.5px] text-[var(--color-warning)]">
                <Lock className="w-3.5 h-3.5 flex-shrink-0" />
                <span>Only the board Manager can change these settings.</span>
              </div>
            )}

            <div className="flex-1 overflow-y-auto px-5 py-5">
              {tab === "general" && (
                <GeneralTab board={board} onUpdate={onUpdate} canEdit={isManager} />
              )}
              {tab === "columns" && (
                <ColumnsTab board={board} onUpdate={onUpdate} canEdit={isManager} />
              )}
              {tab === "members" && (
                <MembersTab board={board} onUpdate={onUpdate} canEdit={isManager} />
              )}
              {tab === "projects" && (
                <ProjectsTab board={board} onUpdate={onUpdate} canEdit={isManager} />
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

// ─── General tab ───────────────────────────────────────────────────────────

function GeneralTab({
  board,
  onUpdate,
  canEdit,
}: {
  board: BoardDetail;
  onUpdate: (b: BoardDetail) => void;
  canEdit: boolean;
}) {
  const [name, setName] = useState(board.name);
  const [branch, setBranch] = useState(board.branch ?? "");

  function commitName() {
    if (!canEdit) return;
    const next = name.trim();
    if (next && next !== board.name) {
      onUpdate({ ...board, name: next });
    } else {
      setName(board.name);
    }
  }
  function commitBranch() {
    if (!canEdit || board.mode !== "online") return;
    const next = branch.trim();
    if (next && next !== board.branch) {
      onUpdate({ ...board, branch: next });
    } else {
      setBranch(board.branch ?? "");
    }
  }

  return (
    <div className="space-y-5">
      <Field label="Name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          disabled={!canEdit}
          className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-md px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none focus:border-[var(--color-highlight)] disabled:opacity-60"
        />
      </Field>

      <Field label="Mode" hint="Cannot be changed after creation.">
        <span
          className={`inline-flex items-center px-2 py-1 rounded-md text-[11px] font-semibold uppercase tracking-wider ${
            board.mode === "online"
              ? "bg-[var(--color-highlight)]/15 text-[var(--color-highlight)]"
              : "bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]"
          }`}
        >
          {board.mode}
        </span>
      </Field>

      {board.mode === "online" && (
        <Field label="Sync branch">
          <input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            onBlur={commitBranch}
            disabled={!canEdit}
            className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-md px-3 py-2 text-sm font-mono text-[var(--color-text)] focus:outline-none focus:border-[var(--color-highlight)] disabled:opacity-60"
          />
        </Field>
      )}

      <div className="pt-3 mt-2 border-t border-[var(--color-border)]">
        <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--color-error)] mb-2 flex items-center gap-1.5">
          <AlertTriangle className="w-3 h-3" />
          Danger zone
        </div>
        <button
          disabled={!canEdit}
          className="px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--color-error)]/40 text-[var(--color-error)] hover:bg-[var(--color-error)]/10 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Delete board…
        </button>
        <p className="text-[11px] text-[var(--color-text-muted)] mt-1.5">
          Removes the board and its data. Linked projects are not affected.
        </p>
      </div>
    </div>
  );
}

// ─── Columns tab ───────────────────────────────────────────────────────────

function ColumnsTab({
  board,
  onUpdate,
  canEdit,
}: {
  board: BoardDetail;
  onUpdate: (b: BoardDetail) => void;
  canEdit: boolean;
}) {
  const [draftName, setDraftName] = useState<{ id: string; name: string } | null>(null);
  const [newColName, setNewColName] = useState("");

  function rename(id: string, name: string) {
    if (!canEdit) return;
    onUpdate({
      ...board,
      columns: board.columns.map((c) => (c.id === id ? { ...c, name } : c)),
    });
  }
  function move(id: string, direction: -1 | 1) {
    if (!canEdit) return;
    const idx = board.columns.findIndex((c) => c.id === id);
    if (idx < 0) return;
    const target = idx + direction;
    const a = board.columns[idx];
    const b = board.columns[target];
    if (!b || a.anchor || b.anchor) return;
    const next = [...board.columns];
    next[idx] = b;
    next[target] = a;
    onUpdate({ ...board, columns: next });
  }
  function remove(id: string) {
    if (!canEdit) return;
    const col = board.columns.find((c) => c.id === id);
    if (!col || col.anchor) return;
    onUpdate({ ...board, columns: board.columns.filter((c) => c.id !== id) });
  }
  function add() {
    if (!canEdit || !newColName.trim()) return;
    const newId = `col-${newColName.toLowerCase().replace(/\s+/g, "-")}-${board.columns.length}`;
    const doneIdx = board.columns.findIndex((c) => c.anchor === "done");
    const insertAt = doneIdx === -1 ? board.columns.length : doneIdx;
    const next = [...board.columns];
    next.splice(insertAt, 0, { id: newId, name: newColName.trim() });
    onUpdate({ ...board, columns: next });
    setNewColName("");
  }

  return (
    <div className="space-y-3">
      <div className="text-[11.5px] text-[var(--color-text-muted)]">
        Backlog and Done are fixed anchors. Add and reorder columns between them.
      </div>
      <div className="space-y-1.5">
        {board.columns.map((col, idx) => (
          <ColumnRow
            key={col.id}
            col={col}
            draft={draftName?.id === col.id ? draftName.name : col.name}
            onDraftChange={(v) => setDraftName({ id: col.id, name: v })}
            onCommit={() => {
              if (draftName?.id === col.id && draftName.name.trim() && draftName.name !== col.name) {
                rename(col.id, draftName.name.trim());
              }
              setDraftName(null);
            }}
            canMoveUp={canEdit && idx > 0 && !col.anchor && !board.columns[idx - 1]?.anchor}
            canMoveDown={canEdit && idx < board.columns.length - 1 && !col.anchor && !board.columns[idx + 1]?.anchor}
            onMoveUp={() => move(col.id, -1)}
            onMoveDown={() => move(col.id, 1)}
            onRemove={() => remove(col.id)}
            canEdit={canEdit}
          />
        ))}
      </div>

      <div className="flex gap-2 pt-2 border-t border-[var(--color-border)]">
        <input
          value={newColName}
          onChange={(e) => setNewColName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          disabled={!canEdit}
          placeholder="New column name (e.g. Review)"
          className="flex-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-md px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none focus:border-[var(--color-highlight)] disabled:opacity-60"
        />
        <button
          onClick={add}
          disabled={!canEdit || !newColName.trim()}
          className="px-3 py-2 text-sm font-medium rounded-md bg-[var(--color-highlight)] text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
        >
          <Plus className="w-3.5 h-3.5" />
          Add
        </button>
      </div>
    </div>
  );
}

function ColumnRow({
  col,
  draft,
  onDraftChange,
  onCommit,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onRemove,
  canEdit,
}: {
  col: BoardColumn;
  draft: string;
  onDraftChange: (v: string) => void;
  onCommit: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  canEdit: boolean;
}) {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
      {col.anchor ? (
        <Lock className="w-3 h-3 text-[var(--color-text-muted)] flex-shrink-0" />
      ) : (
        <span className="w-3 h-3 flex-shrink-0" />
      )}
      <input
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        disabled={!canEdit || !!col.anchor}
        className="flex-1 min-w-0 bg-transparent text-sm text-[var(--color-text)] focus:outline-none disabled:text-[var(--color-text-muted)]"
      />
      {col.anchor && (
        <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] font-semibold">
          {col.anchor}
        </span>
      )}
      <div className="flex items-center gap-0.5 flex-shrink-0">
        <button
          onClick={onMoveUp}
          disabled={!canMoveUp}
          className="p-1 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ArrowUp className="w-3 h-3" />
        </button>
        <button
          onClick={onMoveDown}
          disabled={!canMoveDown}
          className="p-1 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ArrowDown className="w-3 h-3" />
        </button>
        <button
          onClick={onRemove}
          disabled={!canEdit || !!col.anchor}
          className="p-1 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-error)] disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

// ─── Members tab ───────────────────────────────────────────────────────────

function MembersTab({
  board,
  onUpdate,
  canEdit,
}: {
  board: BoardDetail;
  onUpdate: (b: BoardDetail) => void;
  canEdit: boolean;
}) {
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<MemberRole>("operator");

  function updateRole(email: string, role: MemberRole) {
    if (!canEdit) return;
    // Manager role can only be held by one — block role changes that would create two Managers.
    if (role === "manager") return;
    onUpdate({
      ...board,
      members: board.members.map((m) => (m.email === email ? { ...m, role } : m)),
    });
  }
  function remove(email: string) {
    if (!canEdit) return;
    if (email === board.currentUserEmail) return;
    onUpdate({ ...board, members: board.members.filter((m) => m.email !== email) });
  }
  function invite() {
    if (!canEdit || !inviteEmail.trim()) return;
    const email = inviteEmail.trim();
    if (board.members.find((m) => m.email === email)) return;
    const member: BoardMember = {
      email,
      name: email.split("@")[0],
      avatarColor: "#94a3b8",
      role: inviteRole,
    };
    onUpdate({ ...board, members: [...board.members, member], memberCount: board.memberCount + 1 });
    setInviteEmail("");
    setInviteRole("operator");
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        {board.members.map((m) => {
          const isMe = m.email === board.currentUserEmail;
          const isManager = m.role === "manager";
          return (
            <div
              key={m.email}
              className="flex items-center gap-3 px-3 py-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)]"
            >
              <Avatar member={m} size={28} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-[var(--color-text)] truncate">
                    {m.name}
                  </span>
                  {isMe && (
                    <span className="text-[9px] px-1 py-0.5 rounded bg-[var(--color-highlight)]/15 text-[var(--color-highlight)] font-semibold uppercase">
                      You
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-[var(--color-text-muted)] truncate font-mono">
                  {m.email}
                </div>
              </div>
              {isManager ? (
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold uppercase tracking-wider bg-[var(--color-warning)]/15 text-[var(--color-warning)]">
                  <Crown className="w-3 h-3" />
                  Manager
                </span>
              ) : (
                <select
                  value={m.role}
                  onChange={(e) => updateRole(m.email, e.target.value as MemberRole)}
                  disabled={!canEdit}
                  className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-1.5 py-1 text-[11px] text-[var(--color-text)] focus:outline-none focus:border-[var(--color-highlight)] disabled:opacity-60"
                >
                  <option value="operator">Operator</option>
                  <option value="viewer">Viewer</option>
                </select>
              )}
              <button
                onClick={() => remove(m.email)}
                disabled={!canEdit || isMe || isManager}
                className="p-1 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-error)] disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>

      <div className="pt-3 border-t border-[var(--color-border)] space-y-2">
        <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
          Invite member
        </div>
        <div className="flex gap-2">
          <input
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            disabled={!canEdit}
            placeholder="name@example.com"
            className="flex-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-md px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none focus:border-[var(--color-highlight)] disabled:opacity-60"
          />
          <select
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as MemberRole)}
            disabled={!canEdit}
            className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-md px-2 py-2 text-sm text-[var(--color-text)] focus:outline-none focus:border-[var(--color-highlight)] disabled:opacity-60"
          >
            <option value="operator">Operator</option>
            <option value="viewer">Viewer</option>
          </select>
          <button
            onClick={invite}
            disabled={!canEdit || !inviteEmail.trim()}
            className="px-3 py-2 text-sm font-medium rounded-md bg-[var(--color-highlight)] text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" />
            Invite
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Projects tab ──────────────────────────────────────────────────────────

function ProjectsTab({
  board,
  onUpdate,
  canEdit,
}: {
  board: BoardDetail;
  onUpdate: (b: BoardDetail) => void;
  canEdit: boolean;
}) {
  const { projects: registeredProjects } = useProject();
  const { theme } = useTheme();
  const [pickProjectId, setPickProjectId] = useState<string | null>(null);

  const linkedNames = new Set(board.projects.map((p) => p.name));
  const candidates = registeredProjects.filter((p) => !linkedNames.has(p.name));
  const candidateItems = candidates.map((p) => {
    const { color, Icon } = getProjectStyle(p.id, theme.accentPalette);
    return {
      id: p.id,
      visual: <ProjectIconSquare color={color} Icon={Icon} size={26} />,
      label: p.name,
    };
  });

  function remove(id: string) {
    if (!canEdit) return;
    const target = board.projects.find((p) => p.id === id);
    if (!target || target.primary) return;
    onUpdate({
      ...board,
      projects: board.projects.filter((p) => p.id !== id),
      linkedProjectCount: Math.max(1, board.linkedProjectCount - 1),
    });
  }
  function add() {
    if (!canEdit || !pickProjectId) return;
    const target = registeredProjects.find((p) => p.id === pickProjectId);
    if (!target) return;
    const ref: ProjectRef = { id: target.id, name: target.name, primary: false };
    onUpdate({
      ...board,
      projects: [...board.projects, ref],
      linkedProjectCount: board.linkedProjectCount + 1,
    });
    setPickProjectId(null);
  }

  return (
    <div className="space-y-3">
      <div className="text-[11.5px] text-[var(--color-text-muted)]">
        Primary project hosts the board data. Linked projects are referenced for session aggregation.
      </div>
      <div className="space-y-1.5">
        {board.projects.map((p) => {
          const { color, Icon } = getProjectStyle(p.id, theme.accentPalette);
          return (
          <div
            key={p.id}
            className="flex items-center gap-3 px-3 py-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)]"
          >
            <ProjectIconSquare color={color} Icon={Icon} size={28} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-[var(--color-text)] truncate">
                {p.name}
              </div>
            </div>
            {p.primary ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wider bg-[var(--color-highlight)]/15 text-[var(--color-highlight)]">
                Primary
              </span>
            ) : (
              <span className="text-[10px] text-[var(--color-text-muted)] uppercase tracking-wider">
                Linked
              </span>
            )}
            <button
              onClick={() => remove(p.id)}
              disabled={!canEdit || p.primary}
              className="p-1 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-error)] disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
          );
        })}
      </div>

      <div className="pt-3 border-t border-[var(--color-border)] space-y-2">
        <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
          Link a project
        </div>
        <div className="flex gap-2">
          <div className="flex-1 min-w-0">
            <RichPicker
              items={candidateItems}
              selectedId={pickProjectId}
              onSelect={(id) => setPickProjectId(id)}
              placeholder={
                candidates.length === 0
                  ? "No more registered projects available"
                  : "Pick a project to link"
              }
              searchable
              disabled={!canEdit || candidates.length === 0}
            />
          </div>
          <button
            onClick={add}
            disabled={!canEdit || !pickProjectId}
            className="px-3 py-2 text-sm font-medium rounded-md bg-[var(--color-highlight)] text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1 flex-shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            Link
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Shared field wrapper ─────────────────────────────────────────────────

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-[10.5px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1.5">
        {label}
      </label>
      {children}
      {hint && (
        <p className="text-[11px] text-[var(--color-text-muted)] mt-1.5">{hint}</p>
      )}
    </div>
  );
}
