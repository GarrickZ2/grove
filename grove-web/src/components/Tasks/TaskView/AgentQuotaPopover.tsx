import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { RefreshCw } from "lucide-react";

import type { AgentUsage, UsageWindow } from "../../../api";
import { quotaHealthColor } from "./quotaColors";

interface AgentQuotaPopoverProps {
  usage: AgentUsage;
  refreshing: boolean;
  onRefresh: () => void;
  /**
   * Element the popover should anchor against. The popover is positioned
   * flush with this element's left edge and sits directly above its top
   * edge — making it feel attached to the chatbox rather than floating from
   * the trigger button.
   */
  anchorRef: RefObject<HTMLElement | null>;
  children: React.ReactNode;
}

const POPOVER_GAP = 8;
const MIN_WIDTH = 300;
const MAX_WIDTH = 420;
const VIEWPORT_PADDING = 12;

function formatDurationShort(seconds: number | null): string {
  if (seconds == null) return "unknown";
  if (seconds <= 0) return "now";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

function resolveResetsIn(w: UsageWindow): string {
  if (w.resets_in_seconds != null) return formatDurationShort(w.resets_in_seconds);
  if (w.resets_at) {
    const delta = Math.floor((new Date(w.resets_at).getTime() - Date.now()) / 1000);
    return formatDurationShort(delta);
  }
  return "—";
}

interface Rect {
  top: number;
  left: number;
  width: number;
  placement: "top" | "bottom";
}

/**
 * A hover- and focus-triggered popover that shows detailed agent quota
 * information with a progress bar per window. Anchored to the chatbox
 * container so it feels attached to the input area, not like a floating
 * tooltip.
 *
 * Open/close is driven by a unified "hovered trigger OR popover" state,
 * debounced so the pointer can cross the gap between trigger and portaled
 * popover without closing. Also opens on keyboard focus and closes on
 * Escape, with ARIA attributes wired so screen readers can discover it.
 */
export function AgentQuotaPopover({
  usage,
  refreshing,
  onRefresh,
  anchorRef,
  children,
}: AgentQuotaPopoverProps) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<Rect | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerHoveredRef = useRef(false);
  const popoverHoveredRef = useRef(false);
  const focusedRef = useRef(false);
  const hideTimerRef = useRef<number | null>(null);
  const popoverId = useId();

  const recomputePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    // Clamp width to the viewport first so narrow split-panes / mobile
    // can't produce a negative `maxLeft` that pushes the popover off-screen.
    const viewportW = window.innerWidth;
    const available = Math.max(0, viewportW - VIEWPORT_PADDING * 2);
    const desiredWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, r.width));
    const width = Math.min(desiredWidth, available);

    // Measured height of the popover if rendered, otherwise an estimate.
    const popoverHeight = popoverRef.current?.offsetHeight ?? 260;
    const spaceAbove = r.top - POPOVER_GAP;
    const placement: "top" | "bottom" =
      spaceAbove >= popoverHeight + VIEWPORT_PADDING ? "top" : "bottom";
    const rawTop =
      placement === "top"
        ? r.top - POPOVER_GAP - popoverHeight
        : r.bottom + POPOVER_GAP;
    const top = Math.max(VIEWPORT_PADDING, rawTop);

    const maxLeft = Math.max(VIEWPORT_PADDING, viewportW - width - VIEWPORT_PADDING);
    const left = Math.max(VIEWPORT_PADDING, Math.min(r.left, maxLeft));
    setRect({ top, left, width, placement });
  }, [anchorRef]);

  const cancelHide = () => {
    if (hideTimerRef.current != null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  };

  // Evaluate the "should be open" state based on unified inputs (trigger
  // hover, popover hover, keyboard focus). Debounced close lets the pointer
  // cross the small gap between trigger and portaled popover without the
  // popover flickering shut.
  const reconcileOpen = useCallback(() => {
    const shouldOpen =
      triggerHoveredRef.current || popoverHoveredRef.current || focusedRef.current;
    if (shouldOpen) {
      cancelHide();
      recomputePosition();
      setOpen(true);
    } else {
      cancelHide();
      hideTimerRef.current = window.setTimeout(() => {
        setOpen(false);
        hideTimerRef.current = null;
      }, 160);
    }
  }, [recomputePosition]);

  const handleTriggerEnter = () => {
    triggerHoveredRef.current = true;
    reconcileOpen();
  };
  const handleTriggerLeave = () => {
    triggerHoveredRef.current = false;
    reconcileOpen();
  };
  const handlePopoverEnter = () => {
    popoverHoveredRef.current = true;
    reconcileOpen();
  };
  const handlePopoverLeave = () => {
    popoverHoveredRef.current = false;
    reconcileOpen();
  };
  const handleFocus = (e: FocusEvent<HTMLSpanElement>) => {
    // Only keep the popover open for keyboard-style focus. Mouse clicks on
    // the badge focus the button too, but that should not pin the popover
    // open after hover ends.
    focusedRef.current =
      e.target instanceof HTMLElement && e.target.matches(":focus-visible");
    reconcileOpen();
  };
  const handleBlur = () => {
    focusedRef.current = false;
    reconcileOpen();
  };

  // Re-measure after the popover has rendered so we use its real height
  // and can switch from estimate → measured placement without flicker.
  useEffect(() => {
    if (open) {
      const raf = requestAnimationFrame(() => recomputePosition());
      return () => cancelAnimationFrame(raf);
    }
    return undefined;
  }, [open, recomputePosition]);

  // Keep the popover aligned during scroll / resize.
  useEffect(() => {
    if (!open) return;
    const handle = () => recomputePosition();
    window.addEventListener("scroll", handle, true);
    window.addEventListener("resize", handle);
    return () => {
      window.removeEventListener("scroll", handle, true);
      window.removeEventListener("resize", handle);
    };
  }, [open, recomputePosition]);

  // Escape-to-close for keyboard users.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        triggerHoveredRef.current = false;
        popoverHoveredRef.current = false;
        focusedRef.current = false;
        cancelHide();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current != null) window.clearTimeout(hideTimerRef.current);
    };
  }, []);

  return (
    <span
      className="inline-flex"
      onMouseEnter={handleTriggerEnter}
      onMouseLeave={handleTriggerLeave}
      onFocusCapture={handleFocus}
      onBlurCapture={handleBlur}
      aria-describedby={open ? popoverId : undefined}
    >
      {children}
      {typeof document !== "undefined" &&
        createPortal(
          <AnimatePresence>
            {open && rect && (
              <motion.div
                ref={popoverRef}
                id={popoverId}
                role="tooltip"
                initial={{
                  opacity: 0,
                  y: rect.placement === "top" ? 6 : -6,
                }}
                animate={{ opacity: 1, y: 0 }}
                exit={{
                  opacity: 0,
                  y: rect.placement === "top" ? 6 : -6,
                }}
                transition={{ duration: 0.14, ease: [0.2, 0.8, 0.2, 1] }}
                style={{
                  position: "fixed",
                  top: rect.top,
                  left: rect.left,
                  width: rect.width,
                  zIndex: 120,
                }}
                onMouseEnter={handlePopoverEnter}
                onMouseLeave={handlePopoverLeave}
              >
                <PopoverCard
                  usage={usage}
                  refreshing={refreshing}
                  onRefresh={onRefresh}
                />
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </span>
  );
}

function PopoverCard({
  usage,
  refreshing,
  onRefresh,
}: {
  usage: AgentUsage;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <div
      className="rounded-[20px] border px-4 pt-3 pb-2.5 backdrop-blur-md"
      style={{
        // Exact same surface treatment as the chatbox container so the
        // popover reads as an extension of it.
        backgroundColor:
          "color-mix(in srgb, var(--color-bg-secondary) 78%, transparent)",
        borderColor:
          "color-mix(in srgb, var(--color-border) 62%, transparent)",
        boxShadow: "0 22px 60px rgba(0,0,0,0.18)",
      }}
    >
      {/* Header: Plan */}
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
          Plan
        </span>
        <span className="text-[12px] font-semibold text-[var(--color-text)]">
          {usage.plan ?? "—"}
        </span>
      </div>

      <div
        className="h-px"
        style={{
          backgroundColor:
            "color-mix(in srgb, var(--color-border) 50%, transparent)",
        }}
      />

      {/* Windows */}
      <div className="mt-2.5 space-y-2.5">
        {usage.windows.map((w, idx) => {
          // Backend already rounds and clamps; belt-and-suspenders.
          const pct = Math.max(0, Math.min(100, Math.round(w.percentage_remaining)));
          const color = quotaHealthColor(pct);
          return (
            <div key={`${w.label}-${idx}`} className="space-y-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] font-medium text-[var(--color-text)]">
                  {w.label}
                </span>
                <span
                  className="text-[11px] font-semibold tabular-nums"
                  style={{ color }}
                >
                  {pct}% remaining
                </span>
              </div>
              {/* Progress bar — thin, rounded, theme-tinted track */}
              <div
                className="h-1 w-full overflow-hidden rounded-full"
                style={{
                  backgroundColor:
                    "color-mix(in srgb, var(--color-text-muted) 20%, transparent)",
                }}
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${w.label}: ${pct}% remaining`}
              >
                <div
                  className="h-full rounded-full transition-[width] duration-300"
                  style={{
                    width: `${pct}%`,
                    backgroundColor: color,
                  }}
                />
              </div>
              <div className="flex items-center justify-between text-[10px] text-[var(--color-text-muted)]">
                <span>Resets in</span>
                <span className="tabular-nums">{resolveResetsIn(w)}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Extras */}
      {usage.extras && usage.extras.length > 0 && (
        <>
          <div
            className="my-2 h-px"
            style={{
              backgroundColor:
                "color-mix(in srgb, var(--color-border) 50%, transparent)",
            }}
          />
          <div className="space-y-1">
            {usage.extras.map((e, idx) => (
              <div
                key={`${e.label}-${idx}`}
                className="flex items-center justify-between gap-2 text-[10px]"
              >
                <span className="text-[var(--color-text-muted)]">{e.label}</span>
                <span
                  className="truncate font-medium text-[var(--color-text)]"
                  title={e.value}
                >
                  {e.value}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Footer */}
      <div
        className="mt-2.5 flex items-center justify-between border-t pt-2"
        style={{
          borderColor:
            "color-mix(in srgb, var(--color-border) 50%, transparent)",
        }}
      >
        <span className="text-[10px] text-[var(--color-text-muted)]">
          Auto-refreshes every minute
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRefresh();
          }}
          disabled={refreshing}
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-highlight)] disabled:opacity-50"
          aria-label="Refresh agent quota"
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor =
              "color-mix(in srgb, var(--color-highlight) 14%, transparent)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "transparent";
          }}
        >
          <RefreshCw
            className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`}
          />
          Refresh
        </button>
      </div>
    </div>
  );
}
