import { useState } from "react";
import type { BlitzTask } from "../../data/types";
import { ChatPickerDropdown } from "./ChatPickerDropdown";
import type { SlotAssignment } from "./useBlitzGrid";

interface EmptyGridSlotProps {
  blitzTasks: BlitzTask[];
  onSelect: (assignment: SlotAssignment) => void;
}

export function EmptyGridSlot({ blitzTasks, onSelect }: EmptyGridSlotProps) {
  const [pickerOpen, setPickerOpen] = useState(false);

  function handleSelect(assignment: SlotAssignment) {
    setPickerOpen(false);
    onSelect(assignment);
  }

  return (
    <div className="relative w-full h-full flex items-center justify-center border-2 border-dashed border-[var(--color-border)] rounded-md bg-[var(--color-bg)]">
      <button
        type="button"
        onClick={() => setPickerOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={pickerOpen}
        className="px-3 py-1.5 text-sm text-[var(--color-text-muted)] hover:brightness-125 hover:text-[var(--color-text)] rounded-md transition-all"
      >
        + pick a chat
      </button>
      {pickerOpen && (
        <ChatPickerDropdown
          blitzTasks={blitzTasks}
          onSelect={handleSelect}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
