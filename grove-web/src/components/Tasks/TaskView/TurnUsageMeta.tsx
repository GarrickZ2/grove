import { formatTokens, formatDuration } from "../../Stats/formatters";

interface TurnUsageMetaProps {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens?: number;
  /** Wall-clock seconds when the turn started (send_request) and ended. */
  startTs?: number;
  endTs?: number;
}

/**
 * Subtle right-aligned metadata row beneath an assistant message — shows
 * per-turn token counts and duration. Hidden when no usage was reported.
 * Visual style mirrors the gray "11 sources / share / regenerate" rows of
 * other AI products: low contrast, small, ungrouped.
 */
export function TurnUsageMeta({
  inputTokens,
  outputTokens,
  cachedReadTokens,
  startTs,
  endTs,
}: TurnUsageMetaProps) {
  const duration =
    startTs != null && endTs != null && endTs >= startTs
      ? endTs - startTs
      : null;

  return (
    <div className="mt-1 flex items-center justify-start gap-3 text-[10px] text-[var(--color-text-muted)] tabular-nums select-none">
      <span title={`Input ${inputTokens.toLocaleString()} tokens`}>
        ↑ {formatTokens(inputTokens)}
      </span>
      <span title={`Output ${outputTokens.toLocaleString()} tokens`}>
        ↓ {formatTokens(outputTokens)}
      </span>
      {cachedReadTokens != null && cachedReadTokens > 0 && (
        <span title={`Cache read ${cachedReadTokens.toLocaleString()} tokens`}>
          cache {formatTokens(cachedReadTokens)}
        </span>
      )}
      {duration != null && <span>· {formatDuration(duration, true)}</span>}
    </div>
  );
}
