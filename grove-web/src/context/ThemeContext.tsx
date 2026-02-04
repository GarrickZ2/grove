import { createContext, useContext, useState, useEffect } from "react";
import type { ReactNode } from "react";

// Theme definitions matching TUI themes
export interface ThemeColors {
  bg: string;
  bgSecondary: string;
  bgTertiary: string;
  border: string;
  text: string;
  textMuted: string;
  highlight: string;
  accent: string;
  success: string;
  warning: string;
  error: string;
  info: string;
}

export interface Theme {
  id: string;
  name: string;
  colors: ThemeColors;
}

export const themes: Theme[] = [
  {
    id: "dark",
    name: "Dark",
    colors: {
      bg: "#0a0a0b",
      bgSecondary: "#141416",
      bgTertiary: "#1c1c1f",
      border: "#27272a",
      text: "#fafafa",
      textMuted: "#71717a",
      highlight: "#10b981",
      accent: "#06b6d4",
      success: "#10b981",
      warning: "#f59e0b",
      error: "#ef4444",
      info: "#3b82f6",
    },
  },
  {
    id: "light",
    name: "Light",
    colors: {
      bg: "#fafafa",
      bgSecondary: "#f4f4f5",
      bgTertiary: "#e4e4e7",
      border: "#d4d4d8",
      text: "#18181b",
      textMuted: "#71717a",
      highlight: "#059669",
      accent: "#0891b2",
      success: "#059669",
      warning: "#d97706",
      error: "#dc2626",
      info: "#2563eb",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    colors: {
      bg: "#282a36",
      bgSecondary: "#343746",
      bgTertiary: "#44475a",
      border: "#44475a",
      text: "#f8f8f2",
      textMuted: "#6272a4",
      highlight: "#ff79c6",
      accent: "#bd93f9",
      success: "#50fa7b",
      warning: "#ffb86c",
      error: "#ff5555",
      info: "#8be9fd",
    },
  },
  {
    id: "nord",
    name: "Nord",
    colors: {
      bg: "#2e3440",
      bgSecondary: "#3b4252",
      bgTertiary: "#434c5e",
      border: "#4c566a",
      text: "#eceff4",
      textMuted: "#4c566a",
      highlight: "#88c0d0",
      accent: "#81a1c1",
      success: "#a3be8c",
      warning: "#ebcb8b",
      error: "#bf616a",
      info: "#88c0d0",
    },
  },
  {
    id: "gruvbox",
    name: "Gruvbox",
    colors: {
      bg: "#282828",
      bgSecondary: "#3c3836",
      bgTertiary: "#504945",
      border: "#504945",
      text: "#ebdbb2",
      textMuted: "#928374",
      highlight: "#fabd2f",
      accent: "#fe8019",
      success: "#b8bb26",
      warning: "#fabd2f",
      error: "#fb4934",
      info: "#83a598",
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    colors: {
      bg: "#1a1b26",
      bgSecondary: "#24283b",
      bgTertiary: "#292e42",
      border: "#292e42",
      text: "#c0caf5",
      textMuted: "#565f89",
      highlight: "#7dcfff",
      accent: "#bb9af7",
      success: "#9ece6a",
      warning: "#e0af68",
      error: "#f7768e",
      info: "#7dcfff",
    },
  },
  {
    id: "catppuccin",
    name: "Catppuccin",
    colors: {
      bg: "#1e1e2e",
      bgSecondary: "#313244",
      bgTertiary: "#45475a",
      border: "#45475a",
      text: "#cdd6f4",
      textMuted: "#7f849c",
      highlight: "#f5c2e7",
      accent: "#cba6f7",
      success: "#a6e3a1",
      warning: "#f9e2af",
      error: "#f38ba8",
      info: "#89b4fa",
    },
  },
];

interface ThemeContextType {
  theme: Theme;
  setTheme: (themeId: string) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(themes[0]);

  useEffect(() => {
    const savedTheme = localStorage.getItem("grove-theme");
    if (savedTheme) {
      const found = themes.find((t) => t.id === savedTheme);
      if (found) setThemeState(found);
    }
  }, []);

  useEffect(() => {
    // Apply CSS variables to root
    const root = document.documentElement;
    const colors = theme.colors;
    root.style.setProperty("--color-bg", colors.bg);
    root.style.setProperty("--color-bg-secondary", colors.bgSecondary);
    root.style.setProperty("--color-bg-tertiary", colors.bgTertiary);
    root.style.setProperty("--color-border", colors.border);
    root.style.setProperty("--color-text", colors.text);
    root.style.setProperty("--color-text-muted", colors.textMuted);
    root.style.setProperty("--color-highlight", colors.highlight);
    root.style.setProperty("--color-accent", colors.accent);
    root.style.setProperty("--color-success", colors.success);
    root.style.setProperty("--color-warning", colors.warning);
    root.style.setProperty("--color-error", colors.error);
    root.style.setProperty("--color-info", colors.info);
  }, [theme]);

  const setTheme = (themeId: string) => {
    const found = themes.find((t) => t.id === themeId);
    if (found) {
      setThemeState(found);
      localStorage.setItem("grove-theme", themeId);
    }
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
