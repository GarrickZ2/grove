import { Frame, Shapes } from "lucide-react";
import { requestOpenDesign } from "../Studio/DesignPage/designModel";

interface Props {
  projectId: string;
  taskId: string;
  design: string;
  page?: string;
}

/** A `design://` reference in chat: opens the Design panel on that design or page. */
export function DesignChip({ projectId, taskId, design, page }: Props) {
  const system = design === "system";
  const label = page ? `${system ? "Design system" : design} · ${page.replace(/\.html$/i, "")}` : system ? "Design system" : design;
  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        requestOpenDesign({ projectId, taskId, design, page });
      }}
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium cursor-pointer
        bg-[color-mix(in_srgb,var(--color-bg-secondary)_80%,var(--color-bg))]
        text-[var(--color-highlight)]
        border border-[color-mix(in_srgb,var(--color-border)_65%,transparent)]
        hover:bg-[color-mix(in_srgb,var(--color-highlight)_12%,var(--color-bg-secondary))]
        hover:border-[color-mix(in_srgb,var(--color-highlight)_30%,var(--color-border))]
        transition-colors align-middle"
      title={`Open ${label} in the Design panel`}
    >
      {system ? <Shapes size={13} /> : <Frame size={13} />}
      <span>{label}</span>
    </button>
  );
}
