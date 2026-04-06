import type { GroupSnapshot } from "../../data/types";

interface GroupSelectorProps {
  groups: GroupSnapshot[];
  currentGroupId: string | null;
  onSwitch: (groupId: string) => void;
}

export default function GroupSelector({
  groups,
  currentGroupId,
  onSwitch,
}: GroupSelectorProps) {
  const currentIndex = groups.findIndex((g) => g.id === currentGroupId);

  const handlePrev = () => {
    if (groups.length === 0) return;
    const prevIndex =
      currentIndex <= 0 ? groups.length - 1 : currentIndex - 1;
    onSwitch(groups[prevIndex].id);
  };

  const handleNext = () => {
    if (groups.length === 0) return;
    const nextIndex =
      currentIndex >= groups.length - 1 ? 0 : currentIndex + 1;
    onSwitch(groups[nextIndex].id);
  };

  const currentGroup =
    currentIndex >= 0 ? groups[currentIndex] : null;

  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={handlePrev}
        disabled={groups.length <= 1}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border text-[10px] transition active:translate-y-[1px] disabled:opacity-30"
        style={{
          borderColor: "var(--color-border)",
          backgroundColor: "var(--color-bg-tertiary)",
          color: "var(--color-text)",
        }}
        aria-label="Previous bank"
      >
        ◀
      </button>

      <div
        className="flex flex-1 items-center justify-between rounded-lg border px-2.5 py-1.5"
        style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg)" }}
      >
        <span className="truncate text-[13px] font-semibold" style={{ color: "var(--color-text)" }}>
          {currentGroup ? currentGroup.name : "No Groups"}
        </span>
        <span className="ml-2 shrink-0 font-mono text-[10px]" style={{ color: "var(--color-text-muted)" }}>
          {groups.length > 0 ? `${currentIndex + 1}/${groups.length}` : "0/0"}
        </span>
      </div>

      <button
        onClick={handleNext}
        disabled={groups.length <= 1}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border text-[10px] transition active:translate-y-[1px] disabled:opacity-30"
        style={{
          borderColor: "var(--color-border)",
          backgroundColor: "var(--color-bg-tertiary)",
          color: "var(--color-text)",
        }}
        aria-label="Next bank"
      >
        ▶
      </button>
    </div>
  );
}
