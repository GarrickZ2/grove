import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { getTerminalTheme, type TerminalTheme } from "./terminalThemes";
import { patchConfig } from "../api/config";

interface TerminalThemeContextValue {
  terminalTheme: TerminalTheme;
  setTerminalTheme: (id: string) => void;
}

const TerminalThemeContext = createContext<TerminalThemeContextValue | null>(null);

const STORAGE_KEY = "grove-terminal-theme";

export function TerminalThemeProvider({ children }: { children: ReactNode }) {
  const [terminalTheme, setTerminalThemeState] = useState<TerminalTheme>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return getTerminalTheme(saved || "dracula");
  });

  const setTerminalTheme = useCallback((id: string) => {
    const theme = getTerminalTheme(id);
    setTerminalThemeState(theme);
    localStorage.setItem(STORAGE_KEY, id);
    patchConfig({ web: { terminal_theme: id } }).catch(() =>
      console.error("Failed to save terminal theme")
    );
  }, []);

  return (
    <TerminalThemeContext.Provider value={{ terminalTheme, setTerminalTheme }}>
      {children}
    </TerminalThemeContext.Provider>
  );
}

export function useTerminalTheme() {
  const ctx = useContext(TerminalThemeContext);
  if (!ctx) {
    throw new Error("useTerminalTheme must be used within a TerminalThemeProvider");
  }
  return ctx;
}
