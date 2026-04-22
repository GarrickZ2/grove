import { useEffect, useState } from "react";
import { Palette } from "lucide-react";
import {
  OPEN_SKETCH_EVENT,
  type OpenSketchDetail,
  getCachedNames,
  isInflight,
  loadSketchList,
  refetchIfStale,
  subscribe,
  taskKey,
} from "./sketchChipCache";

interface Props {
  projectId: string;
  taskId: string;
  sketchId: string;
}

export function SketchChip({ projectId, taskId, sketchId }: Props) {
  const key = taskKey(projectId, taskId);
  const [, setTick] = useState(0);

  useEffect(() => {
    const force = () => setTick((n) => n + 1);
    const unsub = subscribe(key, force);
    if (!getCachedNames(key) && !isInflight(key)) {
      void loadSketchList(projectId, taskId);
    }
    return unsub;
  }, [projectId, taskId, key]);

  const cached = getCachedNames(key);
  const loading = !cached && isInflight(key);
  const name = cached?.get(sketchId);

  // Cache may have been populated BEFORE the referenced sketch existed
  // (agent drew it mid-conversation). If the chip's uuid isn't in the
  // loaded cache, ask for a stale-gated refetch — `refetchIfStale` no-ops
  // during inflight requests and within its cooldown window, so rendering
  // many missing chips at once doesn't storm the endpoint.
  useEffect(() => {
    if (cached && !name && !isInflight(key)) {
      refetchIfStale(projectId, taskId);
    }
  }, [cached, name, key, projectId, taskId]);

  const refetching = !name && isInflight(key);
  const missing = !loading && !refetching && !name;

  const label = loading || refetching ? "…" : (name ?? "Unknown sketch");

  const onClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // `disabled` on the <button> already suppresses clicks in all three
    // loading/missing/refetching states — no extra runtime guard needed.
    window.dispatchEvent(
      new CustomEvent<OpenSketchDetail>(OPEN_SKETCH_EVENT, {
        detail: { projectId, taskId, sketchId },
      }),
    );
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={missing || loading || refetching}
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium cursor-pointer
        bg-[color-mix(in_srgb,var(--color-bg-secondary)_80%,var(--color-bg))]
        text-[var(--color-highlight)]
        border border-[color-mix(in_srgb,var(--color-border)_65%,transparent)]
        hover:bg-[color-mix(in_srgb,var(--color-highlight)_12%,var(--color-bg-secondary))]
        hover:border-[color-mix(in_srgb,var(--color-highlight)_30%,var(--color-border))]
        disabled:opacity-60 disabled:cursor-not-allowed
        transition-colors align-middle"
      title={
        missing
          ? `Unknown sketch ${sketchId}`
          : loading || refetching
            ? "Loading sketch…"
            : `Open sketch ${label}`
      }
    >
      <Palette size={13} />
      <span>{label}</span>
    </button>
  );
}
