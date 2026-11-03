import { memo, useEffect, useId, useRef, useState } from "react";
import type { AgentUsage } from "../../../../api/agentUsage";
import { useEscapeScope } from "../../../../keyboard/useEscapeScope";
import { AgentQuotaCard } from "../AgentQuotaPopover";
import { ContextUsageDetails } from "../ContextUsagePill";
import { contextUsagePercent, type ContextUsageData } from "../contextUsage";
import { quotaBadgePercent } from "../quotaColors";
import { usageRingModel } from "./composerStatus";
import { usePopPlacement } from "./usePopPlacement";
import { OrbitComposerSheet } from "./OrbitSheet";

const RADIUS = 7.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const HIDE_DELAY_MS = 160;

interface OrbitUsageRingProps {
  contextUsage: ContextUsageData | null;
  quota: AgentUsage | null;
  quotaRefreshing: boolean;
  onRefreshQuota: () => void;
  hasCompactCommand: boolean;
  onCompact: () => void;
  /** Phone: no hover; a tap opens the details as a bottom sheet. */
  sheet?: boolean;
}

/**
 * One ring for "how much room is left": context fill (quota used when the
 * Agent reports no context). Hover or click opens the context and quota
 * details the two percentage pills used to show.
 */
export const OrbitUsageRing = memo(function OrbitUsageRing({ contextUsage, quota, quotaRefreshing, onRefreshQuota, hasCompactCommand, onCompact, sheet = false }: OrbitUsageRingProps) {
  const hasContext = !!contextUsage && contextUsage.size > 0;
  const contextPercent = hasContext ? contextUsagePercent(contextUsage) : null;
  const quotaRemaining = quota ? Math.round(quotaBadgePercent(quota)) : null;
  const model = usageRingModel(contextPercent, quotaRemaining);
  const gradientId = `oc-ring-${useId().replace(/:/g, "")}`;
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const hideTimer = useRef<number | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const open = sheet ? pinned : hovered || pinned;
  const popStyle = usePopPlacement(rootRef, open && !sheet);
  useEscapeScope(open && !sheet, () => { setPinned(false); setHovered(false); });
  useEffect(() => {
    if (!pinned || sheet) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) { setPinned(false); setHovered(false); }
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [pinned, sheet]);
  useEffect(() => () => { if (hideTimer.current) window.clearTimeout(hideTimer.current); }, []);
  if (!model) return null;

  const enter = () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = null;
    setHovered(true);
  };
  const leave = () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setHovered(false), HIDE_DELAY_MS);
  };
  const parts = [
    contextPercent !== null ? `Context ${contextPercent}% used` : null,
    quotaRemaining !== null ? `Quota ${quotaRemaining}% left${quota?.outdated ? " (outdated)" : ""}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <span ref={rootRef} className="oc-ring-root" onMouseEnter={sheet ? undefined : enter} onMouseLeave={sheet ? undefined : leave}>
      <button
        type="button"
        className={`oc-ring${model.tone === "ok" ? "" : ` is-${model.tone}`}${open ? " is-open" : ""}`}
        aria-label={`Usage: ${parts}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setPinned((value) => !value)}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" className="oc-ring-stop-a" />
              <stop offset="1" className="oc-ring-stop-b" />
            </linearGradient>
          </defs>
          <circle className="oc-ring-track" cx="10" cy="10" r={RADIUS} />
          <circle
            className="oc-ring-fill"
            cx="10" cy="10" r={RADIUS}
            stroke={model.tone === "ok" ? `url(#${gradientId})` : undefined}
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - model.percent / 100)}
          />
        </svg>
      </button>
      {sheet && (
        <OrbitComposerSheet open={open} onClose={() => setPinned(false)} label="Usage details" className="oc-ring-pop is-sheet">
          <div className="oc-sheet-head"><b>Usage</b><span>{parts}</span></div>
          {hasContext && <ContextUsageDetails usage={contextUsage} hasCompactCommand={hasCompactCommand} onCompact={() => { setPinned(false); onCompact(); }} />}
          {quota && <AgentQuotaCard usage={quota} refreshing={quotaRefreshing} onRefresh={onRefreshQuota} />}
        </OrbitComposerSheet>
      )}
      {open && !sheet && (
        <div className="oc-pop oc-ring-pop" role="dialog" aria-label="Usage details" style={popStyle}>
          {hasContext && <ContextUsageDetails usage={contextUsage} hasCompactCommand={hasCompactCommand} onCompact={onCompact} />}
          {quota && <AgentQuotaCard usage={quota} refreshing={quotaRefreshing} onRefresh={onRefreshQuota} maxBodyHeight={320} />}
        </div>
      )}
    </span>
  );
});
