import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useIsMobile } from "../../hooks";

interface TooltipProps {
  content: string;
  children: React.ReactNode;
  position?: "top" | "bottom" | "left" | "right";
  delay?: number;
}

export function Tooltip({ content, children, position = "top", delay = 200 }: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const timeoutRef = useRef<number | null>(null);
  const { isTouchDevice } = useIsMobile();

  const showTooltip = () => {
    timeoutRef.current = window.setTimeout(() => {
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

  const positionClasses = {
    top: "bottom-full left-1/2 -translate-x-1/2 mb-2",
    bottom: "top-full left-1/2 -translate-x-1/2 mt-2",
    left: "right-full top-1/2 -translate-y-1/2 mr-2",
    right: "left-full top-1/2 -translate-y-1/2 ml-2",
  };

  const arrowClasses = {
    top: "top-full left-1/2 -translate-x-1/2 border-t-[var(--color-bg-tertiary)] border-x-transparent border-b-transparent",
    bottom: "bottom-full left-1/2 -translate-x-1/2 border-b-[var(--color-bg-tertiary)] border-x-transparent border-t-transparent",
    left: "left-full top-1/2 -translate-y-1/2 border-l-[var(--color-bg-tertiary)] border-y-transparent border-r-transparent",
    right: "right-full top-1/2 -translate-y-1/2 border-r-[var(--color-bg-tertiary)] border-y-transparent border-l-transparent",
  };

  return (
    <div
      className="relative inline-flex"
      onMouseEnter={isTouchDevice ? undefined : showTooltip}
      onMouseLeave={isTouchDevice ? undefined : hideTooltip}
      onClick={isTouchDevice ? handleTouchToggle : undefined}
    >
      {children}
      <AnimatePresence>
        {isVisible && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.1 }}
            className={`absolute z-50 ${positionClasses[position]} pointer-events-none`}
          >
            <div className="px-2 py-1 text-xs font-medium text-[var(--color-text)] bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded shadow-lg whitespace-nowrap">
              {content}
            </div>
            <div
              className={`absolute w-0 h-0 border-4 ${arrowClasses[position]}`}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
