import { createContext, useContext, useState, useEffect, useMemo } from "react";
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
  accentPalette: string[]; // Per-theme accent colors for project icons
  isAuto?: boolean; // Marker for auto theme
}

// Auto theme placeholder - colors will be resolved dynamically
const autoTheme: Theme = {
  id: "auto",
  name: "Auto",
  colors: {} as ThemeColors, // Will be resolved to dark/light
  accentPalette: [], // Will be resolved to dark/light
  isAuto: true,
};

export const themes: Theme[] = [
  autoTheme,
  // Light themes first
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
    accentPalette: [
      "#dc5050", "#e68c3c", "#c8aa28", "#3caa5a", "#28a0a0",
      "#3282c8", "#6464d2", "#965ac8", "#be5096", "#d25a6e",
    ],
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    colors: {
      bg: "#fdf6e3",
      bgSecondary: "#eee8d5",
      bgTertiary: "#e4ddc8",
      border: "#d3cbb8",
      text: "#657b83",
      textMuted: "#93a1a1",
      highlight: "#2aa198",
      accent: "#268bd2",
      success: "#859900",
      warning: "#b58900",
      error: "#dc322f",
      info: "#268bd2",
    },
    accentPalette: [
      "#dc322f", "#cb4b16", "#b58900", "#859900", "#2aa198",
      "#268bd2", "#6c71c4", "#d33682", "#93a1a1", "#657b83",
    ],
  },
  {
    id: "github-light",
    name: "GitHub Light",
    colors: {
      bg: "#ffffff",
      bgSecondary: "#f6f8fa",
      bgTertiary: "#eaeef2",
      border: "#d0d7de",
      text: "#1f2328",
      textMuted: "#656d76",
      highlight: "#0969da",
      accent: "#8250df",
      success: "#1a7f37",
      warning: "#9a6700",
      error: "#cf222e",
      info: "#0969da",
    },
    accentPalette: [
      "#cf222e", "#bc4c00", "#9a6700", "#1a7f37", "#087d8b",
      "#0969da", "#8250df", "#bf3989", "#656d76", "#1f2328",
    ],
  },
  {
    id: "rose-pine-dawn",
    name: "Rosé Pine Dawn",
    colors: {
      bg: "#faf4ed",
      bgSecondary: "#f2e9de",
      bgTertiary: "#e4dfd8",
      border: "#dfdad9",
      text: "#575279",
      textMuted: "#9893a5",
      highlight: "#d7827e",
      accent: "#907aa9",
      success: "#286983",
      warning: "#ea9d34",
      error: "#b4637a",
      info: "#286983",
    },
    accentPalette: [
      "#b4637a", "#d7827e", "#ea9d34", "#286983", "#56949f",
      "#907aa9", "#9893a5", "#797593", "#c88a8a", "#575279",
    ],
  },
  {
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    colors: {
      bg: "#eff1f5",
      bgSecondary: "#dce0e8",
      bgTertiary: "#ccd0da",
      border: "#bcc0cc",
      text: "#4c4f69",
      textMuted: "#8c8fa1",
      highlight: "#ea76cb",
      accent: "#8839ef",
      success: "#40a02b",
      warning: "#df8e1d",
      error: "#d20f39",
      info: "#1e66f5",
    },
    accentPalette: [
      "#d20f39", "#fe640b", "#df8e1d", "#40a02b", "#179299",
      "#1e66f5", "#209fb5", "#8839ef", "#ea76cb", "#dd7878",
    ],
  },
  // Dark themes
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
    accentPalette: [
      "#eb8282", "#f0aa73", "#e6c869", "#82cd91", "#6ec6c3",
      "#78afe1", "#969be6", "#b994e1", "#dc94c3", "#e696a0",
    ],
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
    accentPalette: [
      "#ff5555", "#ffb86c", "#f1fa8c", "#50fa7b", "#8be9fd",
      "#6272a4", "#bd93f9", "#ff79c6", "#f8f8f2", "#ff9696",
    ],
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
    accentPalette: [
      "#bf616a", "#d08770", "#ebcb8b", "#a3be8c", "#8fbcbb",
      "#88c0d0", "#81a1c1", "#b48ead", "#d2a0aa", "#c88278",
    ],
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
    accentPalette: [
      "#fb4934", "#fe8019", "#fabd2f", "#b8bb26", "#83a598",
      "#458588", "#689d6a", "#d3869b", "#ebdbb2", "#d65d0e",
    ],
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
    accentPalette: [
      "#f7768e", "#e0af68", "#e0dc8c", "#9ece6a", "#73daca",
      "#7dcfff", "#7aa2f7", "#bb9af7", "#f5c2e7", "#ff9eaa",
    ],
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
    accentPalette: [
      "#f38ba8", "#fab387", "#f9e2af", "#a6e3a1", "#94e2d5",
      "#89b4fa", "#74c7ec", "#cba6f7", "#f5c2e7", "#f2cdcd",
    ],
  },
];

interface ThemeContextType {
  theme: Theme;
  setTheme: (themeId: string) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

// Helper to detect system dark mode
function getSystemIsDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
}

// Get the dark theme definition
function getDarkTheme(): Theme {
  return themes.find((t) => t.id === "dark") || themes[1];
}

// Get the light theme definition
function getLightTheme(): Theme {
  return themes.find((t) => t.id === "light") || themes[2];
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Store the selected theme ID (could be "auto")
  const [selectedThemeId, setSelectedThemeId] = useState<string>("auto");
  // Track system dark mode for auto theme
  const [systemIsDark, setSystemIsDark] = useState<boolean>(getSystemIsDark);

  // Load theme from backend config on mount
  useEffect(() => {
    const loadTheme = async () => {
      try {
        const response = await fetch("/api/v1/config");
        if (response.ok) {
          const config = await response.json();
          if (config.theme?.theme) {
            const themeId = config.theme.theme.toLowerCase();
            const found = themes.find((t) => t.id === themeId);
            if (found) {
              setSelectedThemeId(themeId);
              return;
            }
          }
        }
      } catch (error) {
        console.error("Failed to load theme from config:", error);
      }

      // Fallback to localStorage if API fails
      const savedTheme = localStorage.getItem("grove-theme");
      if (savedTheme) {
        const found = themes.find((t) => t.id === savedTheme);
        if (found) setSelectedThemeId(savedTheme);
      }
    };

    loadTheme();
  }, []);

  // Listen for system theme changes
  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (e: MediaQueryListEvent) => {
      setSystemIsDark(e.matches);
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  // Resolve the actual theme to use
  const theme = useMemo<Theme>(() => {
    if (selectedThemeId === "auto") {
      // Return auto theme with resolved colors and palette
      const resolvedTheme = systemIsDark ? getDarkTheme() : getLightTheme();
      return {
        ...autoTheme,
        colors: resolvedTheme.colors,
        accentPalette: resolvedTheme.accentPalette,
      };
    }
    return themes.find((t) => t.id === selectedThemeId) || getDarkTheme();
  }, [selectedThemeId, systemIsDark]);

  // Apply CSS variables when theme changes
  useEffect(() => {
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
      setSelectedThemeId(themeId);
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
