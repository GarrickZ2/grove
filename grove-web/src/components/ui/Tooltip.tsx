import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useIsMobile } from "../../hooks";

interface TooltipProps {
  content: string;
  children: React.ReactNode;
  position?: "top" | "bottom" | "left" | "right";
  delay?: number;
  className?: string;
}

export function Tooltip({ content, children, position = "top", delay = 200, className = "" }: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const { isTouchDevice } = useIsMobile();

  const updatePosition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const gap = 10;
    const viewportPadding = 12;
    const estimatedWidth = Math.min(576, window.innerWidth - viewportPadding * 2);
    const estimatedHeight = 120;
    let top = position === "bottom" ? rect.bottom + gap : rect.top - gap;
    let left = position === "left" ? rect.left - gap : position === "right" ? rect.right + gap : rect.left + rect.width / 2;

    if (position === "top" || position === "bottom") {
      left = Math.max(viewportPadding + estimatedWidth / 2, Math.min(left, window.innerWidth - viewportPadding - estimatedWidth / 2));
      if (position === "top" && top - estimatedHeight < viewportPadding) {
        top = rect.bottom + gap;
      } else if (position === "bottom" && top + estimatedHeight > window.innerHeight - viewportPadding) {
        top = rect.top - gap;
      }
    } else {
      top = Math.max(viewportPadding + estimatedHeight / 2, Math.min(top, window.innerHeight - viewportPadding - estimatedHeight / 2));
      if (position === "left" && left - estimatedWidth < viewportPadding) {
        left = rect.right + gap;
      } else if (position === "right" && left + estimatedWidth > window.innerWidth - viewportPadding) {
        left = rect.left - gap;
      }
    }

    const next = {
      top,
      left,
    };
    setCoords(next);
  }, [position]);

  const showTooltip = () => {
    timeoutRef.current = window.setTimeout(() => {
      updatePosition();
      setIsVisible(true);
    }, delay);
  };

  const hideTooltip = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setIsVisible(false);
  };

  // Touch: tap to toggle
  const handleTouchToggle = () => {
    setIsVisible((v) => !v);
  };

  // Touch: dismiss on outside tap
  useEffect(() => {
    if (!isTouchDevice || !isVisible) return;
    const handler = () => setIsVisible(false);
    // Delay to avoid immediate dismissal from the same tap
    const id = window.setTimeout(() => {
      document.addEventListener("touchstart", handler, { once: true });
    }, 100);
    return () => {
      clearTimeout(id);
      document.removeEventListener("touchstart", handler);
    };
  }, [isTouchDevice, isVisible]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);
  useEffect(() => {
    if (!isVisible) return;
    const handle = () => updatePosition();
    window.addEventListener("scroll", handle, true);
    window.addEventListener("resize", handle);
    return () => {
      window.removeEventListener("scroll", handle, true);
      window.removeEventListener("resize", handle);
    };
  }, [isVisible, updatePosition]);

  const arrowClasses = {
    top: "top-full left-1/2 -translate-x-1/2 border-t-[var(--color-bg-tertiary)] border-x-transparent border-b-transparent",
    bottom: "bottom-full left-1/2 -translate-x-1/2 border-b-[var(--color-bg-tertiary)] border-x-transparent border-t-transparent",
    left: "left-full top-1/2 -translate-y-1/2 border-l-[var(--color-bg-tertiary)] border-y-transparent border-r-transparent",
    right: "right-full top-1/2 -translate-y-1/2 border-r-[var(--color-bg-tertiary)] border-y-transparent border-l-transparent",
  };

  return (
    <div
      ref={triggerRef}
      className={`relative inline-flex ${className}`.trim()}
      onMouseEnter={isTouchDevice ? undefined : showTooltip}
      onMouseLeave={isTouchDevice ? undefined : hideTooltip}
      onClick={isTouchDevice ? handleTouchToggle : undefined}
    >
      {children}
      {typeof document !== "undefined" && createPortal(
        <AnimatePresence>
          {isVisible && coords && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.1 }}
              className="fixed z-[120] pointer-events-none"
              style={{
                top: coords.top,
                left: coords.left,
                transform:
                  position === "top" ? "translate(-50%, -100%)" :
                  position === "bottom" ? "translate(-50%, 0)" :
                  position === "left" ? "translate(-100%, -50%)" :
                  "translate(0, -50%)",
              }}
            >
              <div className="relative">
                <div className="max-w-[min(36rem,calc(100vw-2rem))] whitespace-pre-wrap break-words rounded border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-text)] shadow-lg">
                  {content}
                </div>
                <div
                  className={`absolute w-0 h-0 border-4 ${arrowClasses[position]}`}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}
