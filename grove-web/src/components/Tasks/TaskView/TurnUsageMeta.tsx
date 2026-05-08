interface TurnUsageMetaProps {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens?: number;
  /** Wall-clock seconds when the turn started (send_request) and ended. */
  startTs?: number;
  endTs?: number;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  return s > 0 ? `${m}m${s}s` : `${m}m`;
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
      {duration != null && <span>· {formatDuration(duration)}</span>}
    </div>
  );
}
