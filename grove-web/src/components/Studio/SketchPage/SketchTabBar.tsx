import { useState } from "react";
import { Plus, X, Download, Pencil } from "lucide-react";
import type { SketchMeta } from "../../../api";
import { SketchContextMenu } from "./SketchContextMenu";
import { ConfirmDialog } from "../../Dialogs/ConfirmDialog";

interface Props {
  sketches: SketchMeta[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onExportPng: () => void;
}

export function SketchTabBar({
  sketches,
  activeId,
  onSelect,
  onCreate,
  onDelete,
  onRename,
  onExportPng,
}: Props) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [menu, setMenu] = useState<{ sketchId: string; x: number; y: number } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const beginRename = (s: SketchMeta) => {
    setRenamingId(s.id);
    setDraftName(s.name);
  };

  const confirmTarget = confirmDeleteId
    ? sketches.find((s) => s.id === confirmDeleteId) ?? null
    : null;

  return (
    <div
      className="flex items-center gap-1 px-2 py-1.5 border-b"
      style={{
        borderColor: "var(--color-border)",
        background: "var(--color-bg-secondary)",
      }}
    >
      {sketches.map((s) => {
        const isActive = s.id === activeId;
        const isRenaming = renamingId === s.id;
        return (
          <div
            key={s.id}
            onClick={() => !isRenaming && onSelect(s.id)}
            onContextMenu={(e) => {
              if (isRenaming) return;
              e.preventDefault();
              e.stopPropagation();
              setMenu({ sketchId: s.id, x: e.clientX, y: e.clientY });
            }}
            className="group flex items-center gap-1 rounded-md px-2 py-1 text-xs cursor-pointer transition-colors"
            style={{
              background: isActive
                ? "color-mix(in srgb, var(--color-highlight) 12%, transparent)"
                : "transparent",
              color: isActive ? "var(--color-text)" : "var(--color-text-muted)",
            }}
            onMouseEnter={(e) => {
              if (!isActive) {
                e.currentTarget.style.background = "var(--color-bg-tertiary)";
              }
            }}
            onMouseLeave={(e) => {
              if (!isActive) {
                e.currentTarget.style.background = "transparent";
              }
            }}
          >
            {isRenaming ? (
              <input
                autoFocus
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={() => {
                  const name = draftName.trim();
                  if (name && name !== s.name) onRename(s.id, name);
                  setRenamingId(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    (e.currentTarget as HTMLInputElement).blur();
                  } else if (e.key === "Escape") {
                    setRenamingId(null);
                  }
                }}
                className="bg-transparent outline-none border rounded px-1 text-xs"
                style={{
                  borderColor: "var(--color-border)",
                  color: "var(--color-text)",
                }}
              />
            ) : (
              <>
                <span
                  className="truncate max-w-[160px]"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    beginRename(s);
                  }}
                  title="Double-click to rename"
                >
                  {s.name}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    beginRename(s);
                  }}
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-black/10"
                  title="Rename"
                >
                  <Pencil className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDeleteId(s.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-black/10"
                  title="Delete"
                >
                  <X className="w-3 h-3" />
                </button>
              </>
            )}
          </div>
        );
      })}
      <button
        type="button"
        onClick={onCreate}
        title="New sketch"
        className="p-1 rounded-md transition-colors"
        style={{ color: "var(--color-text-muted)" }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--color-bg-tertiary)";
          e.currentTarget.style.color = "var(--color-text)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "var(--color-text-muted)";
        }}
      >
        <Plus className="w-3.5 h-3.5" />
      </button>
      <div className="flex-1" />
      <button
        type="button"
        onClick={onExportPng}
        title="Export PNG"
        className="p-1 rounded-md transition-colors"
        style={{ color: "var(--color-text-muted)" }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--color-bg-tertiary)";
          e.currentTarget.style.color = "var(--color-text)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "var(--color-text-muted)";
        }}
      >
        <Download className="w-3.5 h-3.5" />
      </button>

      <SketchContextMenu
        position={menu ? { x: menu.x, y: menu.y } : null}
        onClose={() => setMenu(null)}
        onRename={() => {
          if (!menu) return;
          const s = sketches.find((x) => x.id === menu.sketchId);
          if (s) beginRename(s);
          setMenu(null);
        }}
        onDelete={() => {
          if (!menu) return;
          setConfirmDeleteId(menu.sketchId);
          setMenu(null);
        }}
      />

      <ConfirmDialog
        isOpen={!!confirmTarget}
        title="Delete sketch"
        message={
          confirmTarget
            ? `Delete "${confirmTarget.name}"? This action cannot be undone.`
            : ""
        }
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => {
          if (confirmDeleteId) onDelete(confirmDeleteId);
          setConfirmDeleteId(null);
        }}
        onCancel={() => setConfirmDeleteId(null)}
      />
    </div>
  );
}
