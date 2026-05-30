import { useEffect, useState } from "react";
import type { BlitzTask } from "../../data/types";
import { GridLayoutToolbar } from "./GridLayoutToolbar";
import { GridSlot } from "./GridSlot";
import { slotCountFor, useBlitzGrid } from "./useBlitzGrid";
import type { GridLayout } from "./useBlitzGrid";

interface BlitzGridWorkspaceProps {
  blitzTasks: BlitzTask[];
}

function gridTemplate(layout: GridLayout): { columns: string; rows: string } {
  switch (layout) {
    case "1":   return { columns: "1fr",        rows: "1fr" };
    case "2":   return { columns: "1fr 1fr",    rows: "1fr" };
    case "2x2": return { columns: "1fr 1fr",    rows: "1fr 1fr" };
    case "3x2": return { columns: "1fr 1fr 1fr", rows: "1fr 1fr" };
  }
}

export function BlitzGridWorkspace({ blitzTasks }: BlitzGridWorkspaceProps) {
  const { layout, assignments, setLayout, assign, clearSlot } = useBlitzGrid();
  const [pendingLayout, setPendingLayout] = useState<GridLayout | null>(null);

  useEffect(() => {
    if (!pendingLayout) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPendingLayout(null);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pendingLayout]);

  function requestLayoutChange(next: GridLayout) {
    if (next === layout) return;
    const nextCount = slotCountFor(next);
    const wouldDrop = assignments.slice(nextCount).some((a) => a !== null);
    if (wouldDrop) {
      setPendingLayout(next);
    } else {
      setLayout(next);
    }
  }

  function confirmShrink() {
    if (pendingLayout) setLayout(pendingLayout);
    setPendingLayout(null);
  }

  const tpl = gridTemplate(layout);

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)]">
      <GridLayoutToolbar current={layout} onChange={requestLayoutChange} />
      <div
        className="flex-1 grid gap-2 p-2 min-h-0"
        style={{ gridTemplateColumns: tpl.columns, gridTemplateRows: tpl.rows }}
      >
        {assignments.map((assignment, i) => (
          <GridSlot
            key={i}
            slotIdx={i}
            assignment={assignment}
            blitzTasks={blitzTasks}
            onAssign={assign}
            onClear={clearSlot}
          />
        ))}
      </div>
      {pendingLayout && (() => {
        const droppedCount = assignments
          .slice(slotCountFor(pendingLayout))
          .filter((a) => a !== null).length;
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
            onClick={() => setPendingLayout(null)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-describedby="shrink-modal-desc"
              onClick={(e) => e.stopPropagation()}
              className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-md p-4 max-w-sm"
            >
              <p id="shrink-modal-desc" className="text-sm text-[var(--color-text)] mb-4">
                Shrinking the grid will clear {droppedCount} assigned slot{droppedCount === 1 ? "" : "s"}. Continue?
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setPendingLayout(null)}
                  className="px-3 py-1 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={confirmShrink}
                  className="px-3 py-1 text-sm bg-[var(--color-accent)] text-[var(--color-bg)] rounded font-semibold"
                >
                  Continue
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
