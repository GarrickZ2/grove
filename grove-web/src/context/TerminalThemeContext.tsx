import { createContext, useContext, useMemo, useCallback, type ReactNode } from "react";
import { type TerminalTheme } from "./terminalThemes";
import { useTheme } from "./ThemeContext";

interface TerminalThemeContextValue {
  terminalTheme: TerminalTheme;
  setTerminalTheme: (id: string) => void;
}

const TerminalThemeContext = createContext<TerminalThemeContextValue | null>(null);

function isDarkColor(hex: string): boolean {
  const normalized = hex.replace("#", "");
  const value = normalized.length === 3
    ? normalized.split("").map((c) => c + c).join("")
    : normalized;
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.5;
}

export function TerminalThemeProvider({ children }: { children: ReactNode }) {
  const { theme } = useTheme();

  const terminalTheme = useMemo<TerminalTheme>(() => {
    const colors = theme.colors;
    const dark = isDarkColor(colors.bg);
    return {
      id: `system-${theme.id}`,
      name: `${theme.name} Terminal`,
      colors: {
        background: colors.bg,
        foreground: colors.text,
        cursor: colors.text,
        cursorAccent: colors.bg,
        selectionBackground: colors.bgTertiary,
        black: dark ? "#1f2430" : "#4b5563",
        red: colors.error,
        green: colors.success,
        yellow: colors.warning,
        blue: colors.info,
        magenta: colors.accent,
        cyan: colors.highlight,
        white: colors.textMuted,
        brightBlack: colors.textMuted,
        brightRed: colors.error,
        brightGreen: colors.success,
        brightYellow: colors.warning,
        brightBlue: colors.info,
        brightMagenta: colors.accent,
        brightCyan: colors.highlight,
        brightWhite: colors.text,
      },
    };
  }, [theme]);

  const setTerminalTheme = useCallback((_id: string) => {
    // Terminal theme now follows the app theme.
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
