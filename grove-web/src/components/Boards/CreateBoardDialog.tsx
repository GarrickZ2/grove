import { useMemo, useRef, useState } from "react";
import { Globe, HardDrive, X } from "lucide-react";
import { Button, Input } from "../ui";
import { DialogShell } from "../ui/DialogShell";
import { useProject, useTheme } from "../../context";
import { getProjectStyle } from "../../utils/projectStyle";
import { RichPicker, ProjectIconSquare } from "./RichPicker";
import type { BoardMode, BoardSummary } from "./types";

const BRANCH_PREFIX = "grove/board/";

interface CreateBoardDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (board: BoardSummary) => void;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function CreateBoardDialog({ isOpen, onClose, onCreate }: CreateBoardDialogProps) {
  const { projects, selectedProject } = useProject();
  const { theme } = useTheme();
  const [name, setName] = useState("");
  const [mode, setMode] = useState<BoardMode>("offline");
  const [primaryProjectId, setPrimaryProjectId] = useState<string | null>(selectedProject?.id ?? null);
  const [branchSuffix, setBranchSuffix] = useState("");
  const [branchTouched, setBranchTouched] = useState(false);
  const idCounterRef = useRef(0);
  const [openedAt, setOpenedAt] = useState(isOpen);

  if (isOpen !== openedAt) {
    setOpenedAt(isOpen);
    if (isOpen) {
      setName("");
      setMode("offline");
      setPrimaryProjectId(selectedProject?.id ?? null);
      setBranchSuffix("");
      setBranchTouched(false);
    }
  }

  const derivedSuffix = useMemo(() => slugify(name) || "untitled", [name]);
  const suffix = branchTouched ? branchSuffix : derivedSuffix;
  const fullBranch = `${BRANCH_PREFIX}${suffix}`;

  const primaryProject = projects.find((p) => p.id === primaryProjectId);
  const canCreate =
    name.trim().length > 0 && (mode === "offline" || (primaryProject && suffix.trim().length > 0));

  const projectItems = projects.map((p) => {
    const { color, Icon } = getProjectStyle(p.id, theme.accentPalette);
    return {
      id: p.id,
      visual: <ProjectIconSquare color={color} Icon={Icon} size={26} />,
      label: p.name,
    };
  });

  function submit() {
    if (!canCreate) return;
    idCounterRef.current += 1;
    onCreate({
      id: `board-${idCounterRef.current}-${name.length}`,
      name: name.trim(),
      mode,
      branch: mode === "online" ? fullBranch : undefined,
      primaryProjectName: primaryProject?.name ?? selectedProject?.name ?? "untitled",
      linkedProjectCount: 1,
      memberCount: 1,
      cardCount: 0,
      sessionCount: 0,
      sync: mode === "online" ? "synced" : "offline",
      lastActiveAt: new Date().toISOString(),
    });
  }

  return (
    <DialogShell isOpen={isOpen} onClose={onClose} maxWidth="max-w-lg">
      <div className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-2xl shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center justify-between">
          <div>
            <h2 className="text-[15px] font-semibold text-[var(--color-text)]">Create Board</h2>
            <p className="text-[11.5px] text-[var(--color-text-muted)] mt-0.5">
              Choose how this board syncs. You can't switch modes later.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <Input
            label="Name"
            placeholder="Q2 Platform Roadmap"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />

          <div>
            <label className="block text-sm font-medium text-[var(--color-text-muted)] mb-2">Mode</label>
            <div className="grid grid-cols-2 gap-2">
              <ModeCard
                active={mode === "offline"}
                onClick={() => setMode("offline")}
                icon={HardDrive}
                title="Local"
                desc="Stored locally. No sync, just for you."
              />
              <ModeCard
                active={mode === "online"}
                onClick={() => setMode("online")}
                icon={Globe}
                title="Online"
                desc="Synced via a dedicated git branch. Invite collaborators."
              />
            </div>
          </div>

          {mode === "online" && (
            <>
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-muted)] mb-2">
                  Primary project
                </label>
                <RichPicker
                  items={projectItems}
                  selectedId={primaryProjectId}
                  onSelect={(id) => setPrimaryProjectId(id)}
                  placeholder="Pick a project to host the board branch"
                  searchable
                />
                <p className="text-[11px] text-[var(--color-text-muted)] mt-1.5">
                  Board data lives in this project's git branch. Other projects can be linked later.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--color-text-muted)] mb-2">
                  Sync branch
                </label>
                <div className="flex items-stretch bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg overflow-hidden focus-within:border-[var(--color-highlight)]">
                  <span className="px-3 py-2 text-sm font-mono text-[var(--color-text-muted)] bg-[var(--color-bg-tertiary)] border-r border-[var(--color-border)] select-none">
                    {BRANCH_PREFIX}
                  </span>
                  <input
                    value={suffix}
                    onChange={(e) => {
                      setBranchSuffix(slugify(e.target.value));
                      setBranchTouched(true);
                    }}
                    placeholder={derivedSuffix}
                    className="flex-1 min-w-0 px-3 py-2 bg-transparent text-[var(--color-text)] font-mono text-sm focus:outline-none"
                  />
                </div>
                <p className="text-[11px] text-[var(--color-text-muted)] mt-1.5">
                  The <code className="font-mono">grove/board/</code> prefix is fixed so the branch can be auto-discovered.
                </p>
              </div>
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[var(--color-border)] flex justify-end gap-2 bg-[var(--color-bg-secondary)]/40">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canCreate}>
            Create board
          </Button>
        </div>
      </div>
    </DialogShell>
  );
}

interface ModeCardProps {
  active: boolean;
  onClick: () => void;
  icon: React.ElementType;
  title: string;
  desc: string;
}

function ModeCard({ active, onClick, icon: Icon, title, desc }: ModeCardProps) {
  return (
    <button
      onClick={onClick}
      className={`text-left p-3 rounded-lg border transition-all ${
        active
          ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/5"
          : "border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:border-[var(--color-text-muted)]/30"
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        <Icon
          className={`w-4 h-4 ${active ? "text-[var(--color-highlight)]" : "text-[var(--color-text-muted)]"}`}
        />
        <span className="text-sm font-semibold text-[var(--color-text)]">{title}</span>
      </div>
      <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">{desc}</p>
    </button>
  );
}
