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
import { Brain, Zap } from "lucide-react";

import { contextHealthColor } from "./quotaColors";
import { formatTokens } from "../../Stats/formatters";

export interface ContextUsageData {
  used: number;
  size: number;
  cost: { amount: number; currency: string } | null;
}

interface ContextUsagePillProps {
  usage: ContextUsageData;
  /** Element used to anchor the popover — same pattern as AgentQuotaPopover. */
  anchorRef: RefObject<HTMLElement | null>;
  /** Agent advertises a `compact` slash command. Required to show the button. */
  hasCompactCommand?: boolean;
  /** Click handler — triggers `/compact` on the active chat. */
  onCompact?: () => void;
}

/** Show the inline Compact button only once context pressure crosses this. */
const COMPACT_BUTTON_THRESHOLD = 60;

const POPOVER_GAP = 8;
const MIN_WIDTH = 240;
const MAX_WIDTH = 360;
const VIEWPORT_PADDING = 12;

interface Rect {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  placement: "top" | "bottom";
}

function formatCost(amount: number, currency: string): string {
  const sym = currency === "USD" ? "$" : "";
  const suf = currency === "USD" ? "" : ` ${currency}`;
  // 4 decimal places for tiny costs, otherwise 2 — agent reports raw fractional amounts.
  const digits = amount > 0 && amount < 0.01 ? 4 : amount < 1 ? 3 : 2;
  return `${sym}${amount.toFixed(digits)}${suf}`;
}

/**
 * Context window pill — shows percentage of the model's context budget used.
 * Hidden when no `usage_update` has been received for the chat. Hover/focus
 * opens a popover with absolute used/size token counts and (when reported)
 * cumulative session cost.
 */
export function ContextUsagePill({
  usage,
  anchorRef,
  hasCompactCommand = false,
  onCompact,
}: ContextUsagePillProps) {
  const percent =
    usage.size > 0
      ? Math.max(0, Math.min(100, Math.round((usage.used / usage.size) * 100)))
      : 0;
  const color = contextHealthColor(percent);

  // Hooks must run unconditionally — call them all before the size==0 early
  // return below.
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<Rect | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const triggerHoveredRef = useRef(false);
  const popoverHoveredRef = useRef(false);
  const focusedRef = useRef(false);
  const hideTimerRef = useRef<number | null>(null);
  const popoverId = useId();

  const recomputePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const anchor = anchorRef.current;
    if (!trigger) return;
    // Use the trigger pill for vertical placement so the popover hugs the
    // pill, but borrow the chatbox container width as a sizing hint when
    // available — keeps the card readable without stretching across the page.
    const r = trigger.getBoundingClientRect();
    const widthHint = anchor?.getBoundingClientRect().width ?? r.width;
    const viewportW = window.innerWidth;
    const available = Math.max(0, viewportW - VIEWPORT_PADDING * 2);
    const desiredWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, widthHint));
    const width = Math.min(desiredWidth, available);

    const viewportH = window.innerHeight;
    const measuredHeight = popoverRef.current?.offsetHeight ?? 0;
    const popoverHeight = measuredHeight > 0 ? measuredHeight : 200;
    const spaceAbove = Math.max(0, r.top - POPOVER_GAP - VIEWPORT_PADDING);
    const spaceBelow = Math.max(
      0,
      viewportH - r.bottom - POPOVER_GAP - VIEWPORT_PADDING,
    );
    const placement: "top" | "bottom" =
      spaceAbove >= popoverHeight || spaceAbove >= spaceBelow ? "top" : "bottom";
    const availableHeight = placement === "top" ? spaceAbove : spaceBelow;
    const maxHeight = Math.max(120, Math.min(popoverHeight, availableHeight));
    const rawTop =
      placement === "top"
        ? r.top - POPOVER_GAP - maxHeight
        : r.bottom + POPOVER_GAP;
    const maxTop = Math.max(
      VIEWPORT_PADDING,
      viewportH - maxHeight - VIEWPORT_PADDING,
    );
    const top = Math.max(VIEWPORT_PADDING, Math.min(rawTop, maxTop));

    const maxLeft = Math.max(
      VIEWPORT_PADDING,
      viewportW - width - VIEWPORT_PADDING,
    );
    const left = Math.max(VIEWPORT_PADDING, Math.min(r.left, maxLeft));
    setRect({ top, left, width, maxHeight, placement });
  }, [anchorRef]);

  const cancelHide = () => {
    if (hideTimerRef.current != null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  };

  const reconcileOpen = useCallback(() => {
    const shouldOpen =
      triggerHoveredRef.current ||
      popoverHoveredRef.current ||
      focusedRef.current;
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
    focusedRef.current =
      e.target instanceof HTMLElement && e.target.matches(":focus-visible");
    reconcileOpen();
  };
  const handleBlur = () => {
    focusedRef.current = false;
    reconcileOpen();
  };

  useEffect(() => {
    if (open) {
      const raf = requestAnimationFrame(() => recomputePosition());
      return () => cancelAnimationFrame(raf);
    }
    return undefined;
  }, [open, recomputePosition]);

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
      if (hideTimerRef.current != null)
        window.clearTimeout(hideTimerRef.current);
    };
  }, []);

  // No context size yet (no usage_update received) — render nothing rather
  // than a meaningless 0% pill.
  if (usage.size === 0) return null;

  return (
    <span
      className="inline-flex"
      onMouseEnter={handleTriggerEnter}
      onMouseLeave={handleTriggerLeave}
      onFocusCapture={handleFocus}
      onBlurCapture={handleBlur}
      aria-describedby={open ? popoverId : undefined}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Context window: ${percent}% used (${formatTokens(
          usage.used,
        )} / ${formatTokens(usage.size)} tokens)`}
        title={`Context ${percent}% used`}
        className="inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 text-[10px] font-semibold leading-[16px] transition-opacity hover:opacity-80"
        style={{
          color,
          backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
          borderColor: `color-mix(in srgb, ${color} 40%, transparent)`,
        }}
      >
        <Brain size={10} />
        {percent}%
      </button>
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
                  maxHeight: rect.maxHeight,
                  overflowY: "auto",
                  zIndex: 120,
                  borderRadius: 20,
                  boxShadow: "0 22px 60px rgba(0,0,0,0.18)",
                }}
                onMouseEnter={handlePopoverEnter}
                onMouseLeave={handlePopoverLeave}
              >
                <ContextUsageCard
                  usage={usage}
                  percent={percent}
                  color={color}
                  showCompact={
                    hasCompactCommand &&
                    !!onCompact &&
                    percent >= COMPACT_BUTTON_THRESHOLD
                  }
                  onCompact={onCompact}
                />
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </span>
  );
}

function ContextUsageCard({
  usage,
  percent,
  color,
  showCompact,
  onCompact,
}: {
  usage: ContextUsageData;
  percent: number;
  color: string;
  showCompact: boolean;
  onCompact?: () => void;
}) {
  return (
    <div
      className="rounded-[20px] border px-4 pt-3 pb-3 backdrop-blur-md"
      style={{
        backgroundColor:
          "color-mix(in srgb, var(--color-bg-secondary) 78%, transparent)",
        borderColor:
          "color-mix(in srgb, var(--color-border) 62%, transparent)",
      }}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
          Context Window
        </span>
        <span
          className="text-[12px] font-semibold tabular-nums"
          style={{ color }}
        >
          {percent}% used
        </span>
      </div>

      <div
        className="relative h-2 w-full"
        style={{
          backgroundColor:
            "color-mix(in srgb, var(--color-text-muted) 20%, transparent)",
          borderRadius: 4,
        }}
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Context window ${percent}% used`}
      >
        <div
          className="absolute left-0 top-0 h-full transition-[width] duration-300"
          style={{
            width: `${percent}%`,
            backgroundColor: color,
            borderRadius: 4,
          }}
        />
      </div>

      <div className="mt-2.5 space-y-1 text-[11px]">
        <div className="flex items-center justify-between">
          <span className="text-[var(--color-text-muted)]">Used</span>
          <span className="tabular-nums font-medium text-[var(--color-text)]">
            {usage.used.toLocaleString()} / {usage.size.toLocaleString()} tokens
          </span>
        </div>
        {usage.cost && (
          <div className="flex items-center justify-between">
            <span className="text-[var(--color-text-muted)]">Cost</span>
            <span className="tabular-nums font-medium text-[var(--color-text)]">
              {formatCost(usage.cost.amount, usage.cost.currency)}
            </span>
          </div>
        )}
      </div>

      {showCompact && onCompact && (
        <button
          type="button"
          onClick={onCompact}
          aria-label="Compact context window — sends /compact"
          title="Sends /compact to the agent"
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-full border px-2 py-1.5 text-[11px] font-semibold transition-opacity hover:opacity-80"
          style={{
            color,
            backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
            borderColor: `color-mix(in srgb, ${color} 40%, transparent)`,
          }}
        >
          <Zap size={12} />
          Compact context
        </button>
      )}
    </div>
  );
}
