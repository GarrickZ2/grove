import { motion, AnimatePresence } from "framer-motion";
import { Zap, Leaf } from "lucide-react";
import type { TasksMode } from "../../App";

interface LogoBrandProps {
  mode: TasksMode;
  onToggle: () => void;
}

export function LogoBrand({ mode, onToggle }: LogoBrandProps) {
  const isBlitz = mode === "blitz";

  return (
    <button
      onClick={onToggle}
      className="flex items-center gap-3 group cursor-pointer"
      title={`Switch to ${isBlitz ? "Zen" : "Blitz"} mode`}
    >
      <div className="relative flex-shrink-0">
        <img src="/logo.png" alt="Grove" className="w-10 h-10 rounded-xl" />
        {/* Blitz mode: tiny lightning badge on logo corner */}
        <AnimatePresence>
          {isBlitz && (
            <motion.div
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              transition={{ type: "spring", stiffness: 500, damping: 25 }}
              className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-amber-500 flex items-center justify-center shadow-lg shadow-amber-500/30"
            >
              <Zap className="w-2.5 h-2.5 text-white fill-white" />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="flex flex-col items-start -space-y-0.5">
        {/* GROVE title — gradient shifts with mode */}
        <motion.span
          animate={{
            backgroundImage: isBlitz
              ? "linear-gradient(to right, var(--color-highlight), #f59e0b)"
              : "linear-gradient(to right, var(--color-highlight), var(--color-accent))",
          }}
          transition={{ duration: 0.6, ease: "easeInOut" }}
          className="text-lg font-bold leading-none bg-clip-text text-transparent"
          style={{
            backgroundImage: isBlitz
              ? "linear-gradient(to right, var(--color-highlight), #f59e0b)"
              : "linear-gradient(to right, var(--color-highlight), var(--color-accent))",
          }}
        >
          GROVE
        </motion.span>

        {/* Mode label — different personality & transition */}
        <AnimatePresence mode="wait">
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
        </AnimatePresence>
      </div>
    </button>
  );
}
