/** Shared ACP version selector for marketplace and custom Agents. */
export function ProtocolVersionSelect({
  value,
  onChange,
  size = "default",
}: {
  value: 1 | 2;
  onChange: (value: 1 | 2) => void;
  size?: "small" | "default";
}) {
  return (
    <div role="group" aria-label="ACP protocol" className="inline-flex rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-0.5">
      {([1, 2] as const).map((version) => (
        <button
          key={version}
          type="button"
          aria-pressed={value === version}
          onClick={() => onChange(version)}
          className={`min-w-16 rounded px-4 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-highlight)]/50 ${size === "small" ? "py-1 text-xs" : "py-1.5 text-sm"} ${value === version ? "bg-[var(--color-highlight)] text-white shadow-sm" : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]"}`}
        >
          v{version}
        </button>
      ))}
    </div>
  );
}
