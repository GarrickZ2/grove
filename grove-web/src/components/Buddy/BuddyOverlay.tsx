import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CommandPaletteProvider, useCommandPalette } from "../../context/CommandPaletteContext";
import { useProject } from "../../context";
import { getProject } from "../../api/projects";
import { BUDDY_NAVIGATE_EVENT, BuddyNavigationContext, type BuddyNavigationTarget } from "./buddyNavigation";
import { useBuddies } from "../../hooks/useBuddies";
import { useRadioEvents } from "../../hooks/useRadioEvents";
import { buildCommands } from "../../hooks/useCommands";
import { useCommand } from "../../keyboard";
import { InteractionContext } from "../../keyboard/InteractionContext";
import { CommandPalette } from "../ui/CommandPalette";
import { DialogLayerContext } from "../ui/dialogLayerContext";
import { BuddyLaunchContext } from "./buddyLaunchContext";
import { BuddyApp } from "./BuddyApp";
import { writeBuddyPreference } from "./buddyStorage";
import { useOrbitInterface } from "../../orbit/ui/interfaceContext";
import "../../orbit/tokens.css";

function BuddyCommands({ onExit, open, items }: { onExit: () => void; open: (id?: string, create?: boolean) => void; items: ReturnType<typeof useBuddies>["items"] }) {
  const palette = useCommandPalette();
  useCommand("palette.legacy.command.open", palette.toggle);
  useCommand("palette.command.open", palette.toggle);
  useEffect(() => { palette.registerGlobalCommands(() => buildCommands({ buddies: { open, leave: onExit, items } })); }, [palette, open, onExit, items]);
  return <CommandPalette />;
}
export function BuddyOverlay({ open, onOpen, onExit, children }: { open: boolean; onOpen: () => void; onExit: () => void; children: ReactNode }) {
  const data = useBuddies();
  // Under Orbit the overlay carries .orbit-ui so Buddy reads the Orbit tokens (see the end of buddy.css).
  const orbit = useOrbitInterface();
  const overlay = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlay.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [open]);
  const { applySelectedProject } = useProject();
  const interfaceName = "Grove";
  const navigate = async (target: BuddyNavigationTarget) => {
    const project = await getProject(target.projectId);
    applySelectedProject(project);
    // The shell's project list has no Tasks loaded yet, so say here whether the
    // Task exists; otherwise Orbit treats it as unknown and lands on the New page.
    const taskKnown = target.taskId === "_local" || project.local_task?.id === target.taskId || project.tasks.some(task => task.id === target.taskId);
    window.dispatchEvent(new CustomEvent(BUDDY_NAVIGATE_EVENT, { detail: { page: "tasks", data: { ...target, taskKnown, viewMode: "terminal" } } }));
    onExit();
  };
  const [request, setRequest] = useState<{ id?: string; create?: boolean; revision: number }>({ revision: 0 });
  const launch = useCallback((id?: string, create?: boolean) => { if (id) writeBuddyPreference("selected", id); setRequest(previous => ({ id, create, revision: previous.revision + 1 })); onOpen(); }, [onOpen]);
  useRadioEvents({ onConnected: () => { void data.refresh(); }, onChatStatus: () => { void data.refresh(); }, onPromptSent: () => { void data.refresh(); } });
  return <BuddyLaunchContext.Provider value={{ items: data.items, open: launch }}>
    <InteractionContext.Provider value={!open}><div inert={open || undefined} aria-hidden={open || undefined} style={{ height: "100%" }}>{children}</div></InteractionContext.Provider>
    <AnimatePresence>{open && <motion.div ref={overlay} tabIndex={-1} role="dialog" aria-label="Buddies" aria-modal="true" className={orbit ? "buddy-overlay orbit-ui" : "buddy-overlay"} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
      <DialogLayerContext.Provider value={80}><BuddyNavigationContext.Provider value={{ interfaceName, navigate }}><CommandPaletteProvider><BuddyApp onExit={onExit} request={request} /><BuddyCommands onExit={onExit} open={launch} items={data.items} /></CommandPaletteProvider></BuddyNavigationContext.Provider></DialogLayerContext.Provider>
    </motion.div>}</AnimatePresence>
  </BuddyLaunchContext.Provider>;
}
