import { motion, AnimatePresence } from "framer-motion";
import { Zap, Leaf } from "lucide-react";
import type { TasksMode } from "../../App";
import { GroveIcon } from "./GroveIcon";
import { GroveWordmark } from "./GroveWordmark";

interface LogoBrandProps {
  mode: TasksMode;
  onToggle: () => void;
}

export function LogoBrand({ mode, onToggle }: LogoBrandProps) {
  const isBlitz = mode === "blitz";

  return (
    <button
      onClick={onToggle}
      className="flex items-center gap-1 group cursor-pointer"
      title={`Switch to ${isBlitz ? "Zen" : "Blitz"} mode`}
    >
      <div className="relative flex-shrink-0">
        <GroveIcon size={35} shimmer background className="rounded-xl" />
      </div>

      <div className="flex flex-col items-start -space-y-0.5">
        {/* GROVE title — vectorized wordmark */}
        <GroveWordmark height={16} />

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
