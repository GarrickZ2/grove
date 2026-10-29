import { motion, AnimatePresence } from "framer-motion";
import { Zap, Leaf } from "lucide-react";
import type { TasksMode } from "../../App";
import { GroveIcon } from "./GroveIcon";
import { GroveWordmark } from "./GroveWordmark";

interface LogoBrandProps {
  mode: TasksMode;
  onToggle?: () => void;
  subtitle?: string;
  icon?: React.ReactNode;
}

export function LogoBrand({ mode, onToggle, subtitle, icon }: LogoBrandProps) {
  const Root = onToggle ? "button" : "div";
  const isBlitz = mode === "blitz";

  const isRemote = typeof window !== "undefined" && !!(window as unknown as Record<string, unknown>).__GROVE_REMOTE__;

  return (
    <Root
      onClick={onToggle}
      className={`flex min-w-0 items-center gap-1 group ${onToggle ? "cursor-pointer" : ""}`}
      title={onToggle ? `Switch to ${isBlitz ? "Zen" : "Blitz"} mode` : undefined}
    >
      <div className="relative flex-shrink-0">
        {icon ?? <GroveIcon size={35} shimmer background className="rounded-xl" />}
      </div>

      <div className="flex min-w-0 flex-col items-start -space-y-0.5">
        {/* GROVE title — vectorized wordmark */}
        <div className="flex items-center gap-1.5">
          <GroveWordmark height={16} />
          {isRemote && (
            <span className="px-1 py-0.25 text-[7px] font-black uppercase tracking-widest rounded bg-[var(--color-highlight)]/10 text-[var(--color-highlight)] border border-[var(--color-highlight)]/20 shadow-sm shadow-[var(--color-highlight)]/5 select-none">
              Remote
            </span>
          )}
        </div>

        {/* Mode label — different personality & transition */}
        {subtitle && <span className="block max-w-full truncate text-[10px] leading-4 text-[var(--color-text-muted)]">{subtitle}</span>}
        {onToggle && <AnimatePresence mode="wait">
          {isBlitz ? (
            <motion.div
              key="blitz"
              initial={{ opacity: 0, x: 16, filter: "blur(6px)" }}
              animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, x: -16, filter: "blur(6px)" }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="flex items-center gap-1 pt-0.5"
            >
              <Zap className="w-2.5 h-2.5 text-amber-400 fill-amber-400" />
              <span className="text-[10px] font-bold tracking-[0.15em] text-amber-400 uppercase">
                Blitz
              </span>
            </motion.div>
          ) : (
            <motion.div
              key="zen"
              initial={{ opacity: 0, y: -6, filter: "blur(6px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: 6, filter: "blur(6px)" }}
              transition={{ duration: 0.4, ease: "easeOut" }}
              className="flex items-center gap-1 pt-0.5"
            >
              <Leaf className="w-2.5 h-2.5 text-emerald-400" />
              <span
                className="text-[10px] font-bold tracking-[0.15em] uppercase bg-clip-text text-transparent"
                style={{ backgroundImage: "linear-gradient(to right, #34d399, #a78bfa)" }}
              >
                Zen
              </span>
            </motion.div>
          )}
        </AnimatePresence>}
      </div>
    </Root>
  );
}
