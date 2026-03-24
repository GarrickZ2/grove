import { createContext, useContext, useState, useCallback, useRef } from "react";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export interface Command {
  id: string;
  name: string;
  category: string;
  icon?: LucideIcon;
  shortcut?: string;
  handler: () => void;
  keywords?: string[];
}

export type CommandBuilder = () => Command[];

interface CommandPaletteContextType {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  /** Get all commands (built lazily when palette opens) */
  getCommands: () => Command[];
  /** Register a command builder (global or page-level) */
  registerGlobalCommands: (builder: CommandBuilder) => void;
  registerPageCommands: (builder: CommandBuilder) => void;
  unregisterPageCommands: () => void;
  /** Task palette (Cmd+O) */
  taskPaletteOpen: boolean;
  openTaskPalette: () => void;
  closeTaskPalette: () => void;
  /** Project palette (Cmd+P) */
  projectPaletteOpen: boolean;
  openProjectPalette: () => void;
  closeProjectPalette: () => void;
  /** Whether a workspace is currently active (for Cmd+1-9 priority) */
  inWorkspace: boolean;
  setInWorkspace: (value: boolean) => void;
}

const CommandPaletteContext = createContext<CommandPaletteContextType | undefined>(undefined);

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [taskPaletteOpen, setTaskPaletteOpen] = useState(false);
  const [projectPaletteOpen, setProjectPaletteOpen] = useState(false);
  const [inWorkspace, setInWorkspaceState] = useState(false);

  // Store builders as refs — no re-renders when they change
  const globalBuilderRef = useRef<CommandBuilder>(() => []);
  const pageBuilderRef = useRef<CommandBuilder>(() => []);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const openTaskPalette = useCallback(() => setTaskPaletteOpen(true), []);
  const closeTaskPalette = useCallback(() => setTaskPaletteOpen(false), []);
  const openProjectPalette = useCallback(() => setProjectPaletteOpen(true), []);
  const closeProjectPalette = useCallback(() => setProjectPaletteOpen(false), []);
  const setInWorkspace = useCallback((value: boolean) => setInWorkspaceState(value), []);

  const registerGlobalCommands = useCallback((builder: CommandBuilder) => {
    globalBuilderRef.current = builder;
  }, []);

  const registerPageCommands = useCallback((builder: CommandBuilder) => {
    pageBuilderRef.current = builder;
  }, []);

  const unregisterPageCommands = useCallback(() => {
    pageBuilderRef.current = () => [];
  }, []);

  // Build commands lazily — only called when palette is open and rendering
  const getCommands = useCallback(() => {
    return [...globalBuilderRef.current(), ...pageBuilderRef.current()];
  }, []);

  return (
    <CommandPaletteContext.Provider
      value={{
        isOpen,
        open,
        close,
        getCommands,
        registerGlobalCommands,
        registerPageCommands,
        unregisterPageCommands,
        taskPaletteOpen,
        openTaskPalette,
        closeTaskPalette,
        projectPaletteOpen,
        openProjectPalette,
        closeProjectPalette,
        inWorkspace,
        setInWorkspace,
      }}
    >
      {children}
    </CommandPaletteContext.Provider>
  );
}

export function useCommandPalette() {
  const context = useContext(CommandPaletteContext);
  if (!context) {
    throw new Error("useCommandPalette must be used within CommandPaletteProvider");
  }
  return context;
}
