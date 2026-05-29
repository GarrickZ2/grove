import { useMemo, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { KeyBadge } from "../ui";
import { useIsMobile } from "../../hooks";
import {
  useCommand,
  useKeyboardScope,
  formatKeyDisplay,
  effectiveBindings,
  userKeymapStore,
} from "../../keyboard";
import { COMMAND_CATALOG } from "../../keyboard/catalog";
import type { CommandDef } from "../../keyboard";

interface HelpOverlayProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ShortcutGroup {
  title: string;
  entries: { cmd: CommandDef; keys: string[] }[];
}

export function HelpOverlay({ isOpen, onClose }: HelpOverlayProps) {
  const { isMobile } = useIsMobile();

  useKeyboardScope("helpOverlay", isOpen);
  useCommand("help.close", onClose, [onClose]);

  // Subscribe to user keymap so displayed bindings update live as the
  // user edits Settings.
  const keymapToken = useSyncExternalStore(
    (cb) => userKeymapStore.subscribe(cb),
    () => userKeymapStore.getVersion(),
  );
  void keymapToken;

  const groups = useMemo<ShortcutGroup[]>(() => {
    if (!isOpen) return [];
    const overrides = userKeymapStore.getAllOverrides();
    const disabled = userKeymapStore.getDisabled();
    const byCategory = new Map<string, ShortcutGroup>();

    for (const cmd of COMMAND_CATALOG) {
      if (cmd.hidden) continue;
      if (disabled.has(cmd.id)) continue;
      const bindings = effectiveBindings(cmd, overrides.get(cmd.id));
      if (bindings.length === 0) continue;
      const keys = bindings.map((b) => formatKeyDisplay(b.key));
      let group = byCategory.get(cmd.category);
      if (!group) {
        group = { title: cmd.category, entries: [] };
        byCategory.set(cmd.category, group);
      }
      group.entries.push({ cmd, keys });
    }

    return Array.from(byCategory.values());
  }, [isOpen]);

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/50 z-[100]"
          />

          <motion.div
            initial={isMobile ? { y: "100%" } : { opacity: 0, scale: 0.95, y: 20 }}
            animate={isMobile ? { y: 0 } : { opacity: 1, scale: 1, y: 0 }}
            exit={isMobile ? { y: "100%" } : { opacity: 0, scale: 0.95, y: 20 }}
            transition={
              isMobile
                ? { type: "spring", damping: 30, stiffness: 300 }
                : { duration: 0.2 }
            }
            className={
              isMobile
                ? "fixed inset-x-0 bottom-0 z-[100] max-h-[85vh] overflow-y-auto"
                : "fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[100] w-full max-w-2xl max-h-[80vh] overflow-y-auto"
            }
          >
            <div
              className={`bg-[var(--color-bg-secondary)] border border-[var(--color-border)] ${
                isMobile ? "rounded-t-2xl" : "rounded-xl"
              } shadow-xl overflow-hidden`}
            >
              {isMobile && (
                <div className="flex justify-center pt-3 pb-1">
                  <div className="w-10 h-1 rounded-full bg-[var(--color-border)]" />
                </div>
              )}
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

              <div className="px-5 py-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5">
                {groups.map((group) => (
                  <div key={group.title}>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-2">
                      {group.title}
                    </h3>
                    <div className="space-y-1">
                      {group.entries.map(({ cmd, keys }) => (
                        <div
                          key={cmd.id}
                          className="flex items-center justify-between py-1 gap-2"
                        >
                          <span
                            className="text-xs text-[var(--color-text)] truncate"
                            title={cmd.description ?? cmd.id}
                          >
                            {cmd.name}
                          </span>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {keys.map((key, ki) => (
                              <span
                                key={ki}
                                className="flex items-center gap-0.5"
                              >
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

              <div className="px-5 py-3 border-t border-[var(--color-border)] bg-[var(--color-bg)] flex items-center justify-between">
                <p className="text-xs text-[var(--color-text-muted)]">
                  Configure shortcuts in <span className="text-[var(--color-text)]">Settings → Keyboard Shortcuts</span>
                </p>
                <p className="text-xs text-[var(--color-text-muted)]">
                  Press <KeyBadge>?</KeyBadge> or <KeyBadge>Esc</KeyBadge> to close
                </p>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}
