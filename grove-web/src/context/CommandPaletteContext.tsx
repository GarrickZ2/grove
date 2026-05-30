import { createContext, useContext, useState, useCallback, useRef } from "react";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export type CommandPalettePageContext = "default" | "tasks" | "workspace";

export interface CommandRanking {
  base?: number;
  contexts?: Partial<Record<CommandPalettePageContext, number>>;
}

export interface Command {
  id: string;
  name: string;
  category: string;
  icon?: LucideIcon;
  shortcut?: string;
  handler: () => void;
  keywords?: string[];
  ranking?: CommandRanking;
}

type CommandBuilder = () => Command[];

interface CommandPaletteContextType {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
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
  toggleTaskPalette: () => void;
  /** Project palette (Cmd+P) */
  projectPaletteOpen: boolean;
  openProjectPalette: () => void;
  closeProjectPalette: () => void;
  toggleProjectPalette: () => void;
  pageContext: CommandPalettePageContext;
  setPageContext: (value: CommandPalettePageContext) => void;
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
  const [pageContext, setPageContextState] = useState<CommandPalettePageContext>("default");

  // Store builders as refs — no re-renders when they change
  const globalBuilderRef = useRef<CommandBuilder>(() => []);
  const pageBuilderRef = useRef<CommandBuilder>(() => []);

  // The three palettes are mutually exclusive — opening one closes the
  // other two so they never stack (e.g. Cmd+K then Cmd+P swaps search for
  // the project switcher instead of overlaying it).
  const open = useCallback(() => {
    setIsOpen(true);
    setTaskPaletteOpen(false);
    setProjectPaletteOpen(false);
  }, []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => {
    setIsOpen((v) => {
      if (!v) {
        setTaskPaletteOpen(false);
        setProjectPaletteOpen(false);
      }
      return !v;
    });
  }, []);
  const openTaskPalette = useCallback(() => {
    setTaskPaletteOpen(true);
    setIsOpen(false);
    setProjectPaletteOpen(false);
  }, []);
  const closeTaskPalette = useCallback(() => setTaskPaletteOpen(false), []);
  const toggleTaskPalette = useCallback(() => {
    setTaskPaletteOpen((v) => {
      if (!v) {
        setIsOpen(false);
        setProjectPaletteOpen(false);
      }
      return !v;
    });
  }, []);
  const openProjectPalette = useCallback(() => {
    setProjectPaletteOpen(true);
    setIsOpen(false);
    setTaskPaletteOpen(false);
  }, []);
  const closeProjectPalette = useCallback(() => setProjectPaletteOpen(false), []);
  const toggleProjectPalette = useCallback(() => {
    setProjectPaletteOpen((v) => {
      if (!v) {
        setIsOpen(false);
        setTaskPaletteOpen(false);
      }
      return !v;
    });
  }, []);
  const setInWorkspace = useCallback((value: boolean) => setInWorkspaceState(value), []);
  const setPageContext = useCallback((value: CommandPalettePageContext) => setPageContextState(value), []);

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
        toggle,
        getCommands,
        registerGlobalCommands,
        registerPageCommands,
        unregisterPageCommands,
        taskPaletteOpen,
        openTaskPalette,
        closeTaskPalette,
        toggleTaskPalette,
        projectPaletteOpen,
        openProjectPalette,
        closeProjectPalette,
        toggleProjectPalette,
        pageContext,
        setPageContext,
        inWorkspace,
        setInWorkspace,
      }}
    >
      {children}
    </CommandPaletteContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useCommandPalette() {
  const context = useContext(CommandPaletteContext);
  if (!context) {
    throw new Error("useCommandPalette must be used within CommandPaletteProvider");
  }
  return context;
}
