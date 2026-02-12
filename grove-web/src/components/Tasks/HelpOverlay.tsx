import { useEffect } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { KeyBadge } from "../ui";

interface HelpOverlayProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ShortcutEntry {
  keys: string[];
  description: string;
}

interface ShortcutGroup {
  title: string;
  entries: ShortcutEntry[];
}

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Navigation",
    entries: [
      { keys: ["j", "\u2193"], description: "Select next task" },
      { keys: ["k", "\u2191"], description: "Select previous task" },
      { keys: ["Enter"], description: "Enter terminal / expand info" },
      { keys: ["Esc"], description: "Go back" },
    ],
  },
  {
    title: "Info Panel Tabs",
    entries: [
      { keys: ["1"], description: "Stats tab" },
      { keys: ["2"], description: "Git tab" },
      { keys: ["3"], description: "Notes tab" },
      { keys: ["4"], description: "Comments tab" },
    ],
  },
  {
    title: "Actions",
    entries: [
      { keys: ["n"], description: "New task" },
      { keys: ["Space"], description: "Open context menu" },
      { keys: ["c"], description: "Commit" },
      { keys: ["s"], description: "Sync" },
      { keys: ["m"], description: "Merge" },
      { keys: ["b"], description: "Rebase (change branch)" },
      { keys: ["d"], description: "Open Review panel" },
      { keys: ["e"], description: "Open Editor panel" },
    ],
  },
  {
    title: "Search",
    entries: [
      { keys: ["/"], description: "Focus search" },
      { keys: ["Esc"], description: "Clear & unfocus search" },
    ],
  },
];

export function HelpOverlay({ isOpen, onClose }: HelpOverlayProps) {
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "?") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/50 z-[100]"
          />

          {/* Card */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.2 }}
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[100] w-full max-w-lg max-h-[80vh] overflow-y-auto"
          >
            <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl shadow-xl overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--color-border)] sticky top-0 bg-[var(--color-bg-secondary)] z-10">
                <h2 className="text-base font-semibold text-[var(--color-text)]">
                  Keyboard Shortcuts
                </h2>
                <button
                  onClick={onClose}
                  className="p-1.5 rounded-lg hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Content */}
              <div className="px-5 py-4 space-y-5">
                {SHORTCUT_GROUPS.map((group) => (
                  <div key={group.title}>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-2">
                      {group.title}
                    </h3>
                    <div className="space-y-1.5">
                      {group.entries.map((entry, i) => (
                        <div
                          key={i}
                          className="flex items-center justify-between py-1"
                        >
                          <span className="text-sm text-[var(--color-text)]">
                            {entry.description}
                          </span>
                          <div className="flex items-center gap-1">
                            {entry.keys.map((key, ki) => (
                              <span key={ki} className="flex items-center gap-0.5">
                                {ki > 0 && (
                                  <span className="text-[10px] text-[var(--color-text-muted)] mx-0.5">
                                    /
                                  </span>
                                )}
                                <KeyBadge>{key}</KeyBadge>
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {/* Footer hint */}
              <div className="px-5 py-3 border-t border-[var(--color-border)] bg-[var(--color-bg)]">
                <p className="text-xs text-[var(--color-text-muted)] text-center">
                  Press <KeyBadge>?</KeyBadge> or <KeyBadge>Esc</KeyBadge> to close
                </p>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body
  );
}
