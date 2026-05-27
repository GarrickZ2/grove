import { createContext, useContext, useState, useEffect, useMemo, useCallback } from "react";
import type { ReactNode } from "react";
import { apiClient } from "../api/client";

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
  isLight: boolean;
  isCustom?: boolean;
}

// eslint-disable-next-line react-refresh/only-export-components
export const builtInThemes: Theme[] = [
  // ─── Light Themes ──────────────────────────────────────────────────────────
  {
    id: "light",
    name: "Light",
    isLight: true,
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
    accentPalette: ["#dc5050", "#e68c3c", "#c8aa28", "#3caa5a", "#28a0a0", "#3282c8"],
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    isLight: true,
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
    accentPalette: ["#dc322f", "#cb4b16", "#b58900", "#859900", "#2aa198", "#268bd2"],
  },
  {
    id: "github-light",
    name: "GitHub Light",
    isLight: true,
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
    accentPalette: ["#cf222e", "#bc4c00", "#9a6700", "#1a7f37", "#087d8b", "#0969da"],
  },
  {
    id: "rose-pine-dawn",
    name: "Rosé Pine Dawn",
    isLight: true,
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
    accentPalette: ["#b4637a", "#d7827e", "#ea9d34", "#286983", "#56949f", "#907aa9"],
  },
  {
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    isLight: true,
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
    accentPalette: ["#d20f39", "#fe640b", "#df8e1d", "#40a02b", "#179299", "#1e66f5"],
  },
  {
    id: "one-light",
    name: "One Light",
    isLight: true,
    colors: {
      bg: "#fafafa",
      bgSecondary: "#f0f0f0",
      bgTertiary: "#e5e5e6",
      border: "#dbdbdc",
      text: "#383a42",
      textMuted: "#a0a1a7",
      highlight: "#0184bc",
      accent: "#4078f2",
      success: "#50a14f",
      warning: "#986801",
      error: "#e45649",
      info: "#4078f2",
    },
    accentPalette: ["#e45649", "#986801", "#50a14f", "#0184bc", "#4078f2", "#a626a4"],
  },
  {
    id: "ayu-light",
    name: "Ayu Light",
    isLight: true,
    colors: {
      bg: "#fafafa",
      bgSecondary: "#f3f3f3",
      bgTertiary: "#ededed",
      border: "#e0e0e0",
      text: "#5c6773",
      textMuted: "#abb0b6",
      highlight: "#ff9940",
      accent: "#36a3d9",
      success: "#86b300",
      warning: "#f29718",
      error: "#ff3333",
      info: "#36a3d9",
    },
    accentPalette: ["#ff3333", "#f29718", "#86b300", "#36a3d9", "#ff9940", "#a37acc"],
  },
  {
    id: "everforest-light",
    name: "Everforest Light",
    isLight: true,
    colors: {
      bg: "#fdf6e3",
      bgSecondary: "#f3ead3",
      bgTertiary: "#e9e0ca",
      border: "#d3c6aa",
      text: "#5c6a72",
      textMuted: "#939f91",
      highlight: "#8da101",
      accent: "#dfa000",
      success: "#8da101",
      warning: "#dfa000",
      error: "#f85552",
      info: "#35a775",
    },
    accentPalette: ["#f85552", "#dfa000", "#8da101", "#35a775", "#3a94c5", "#df69ba"],
  },

  // ─── Dark Themes ───────────────────────────────────────────────────────────
  {
    id: "dark",
    name: "Dark",
    isLight: false,
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
    accentPalette: ["#eb8282", "#f0aa73", "#e6c869", "#82cd91", "#6ec6c3", "#78afe1"],
  },
  {
    id: "dracula",
    name: "Dracula",
    isLight: false,
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
    accentPalette: ["#ff5555", "#ffb86c", "#f1fa8c", "#50fa7b", "#8be9fd", "#6272a4"],
  },
  {
    id: "nord",
    name: "Nord",
    isLight: false,
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
    accentPalette: ["#bf616a", "#d08770", "#ebcb8b", "#a3be8c", "#8fbcbb", "#88c0d0"],
  },
  {
    id: "gruvbox",
    name: "Gruvbox",
    isLight: false,
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
    accentPalette: ["#fb4934", "#fe8019", "#fabd2f", "#b8bb26", "#83a598", "#458588"],
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    isLight: false,
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
    accentPalette: ["#f7768e", "#e0af68", "#e0dc8c", "#9ece6a", "#73daca", "#7dcfff"],
  },
  {
    id: "catppuccin",
    name: "Catppuccin",
    isLight: false,
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
    accentPalette: ["#f38ba8", "#fab387", "#f9e2af", "#a6e3a1", "#94e2d5", "#89b4fa"],
  },
  {
    id: "one-dark",
    name: "One Dark",
    isLight: false,
    colors: {
      bg: "#282c34",
      bgSecondary: "#21252b",
      bgTertiary: "#181a1f",
      border: "#181a1f",
      text: "#abb2bf",
      textMuted: "#5c6370",
      highlight: "#61afef",
      accent: "#c678dd",
      success: "#98c379",
      warning: "#d19a66",
      error: "#e06c75",
      info: "#61afef",
    },
    accentPalette: ["#e06c75", "#d19a66", "#98c379", "#61afef", "#c678dd", "#56b6c2"],
  },
  {
    id: "night-owl",
    name: "Night Owl",
    isLight: false,
    colors: {
      bg: "#011627",
      bgSecondary: "#0b2942",
      bgTertiary: "#010e17",
      border: "#1d3b53",
      text: "#d6deeb",
      textMuted: "#5f7e97",
      highlight: "#82aaff",
      accent: "#c792ea",
      success: "#addb67",
      warning: "#ecc48d",
      error: "#ef5350",
      info: "#82aaff",
    },
    accentPalette: ["#ef5350", "#ecc48d", "#addb67", "#82aaff", "#c792ea", "#7fdbca"],
  },
];

export type ThemeMode = "auto" | "light" | "dark";

interface ThemeContextType {
  theme: Theme; // Current effective theme
  mode: ThemeMode;
  lightThemeId: string;
  darkThemeId: string;
  customThemes: Theme[];
  themes: Theme[]; // All available themes (built-in + custom)
  setAppearance: (params: { mode?: ThemeMode; lightThemeId?: string; darkThemeId?: string; customThemes?: Theme[] }) => Promise<void>;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

// Helper to detect system dark mode
function getSystemIsDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>("auto");
  const [lightThemeId, setLightThemeId] = useState("light");
  const [darkThemeId, setDarkThemeId] = useState("dark");
  const [customThemes, setCustomThemes] = useState<Theme[]>([]);
  const [systemIsDark, setSystemIsDark] = useState<boolean>(getSystemIsDark);

  const allThemes = useMemo(() => [...builtInThemes, ...customThemes], [customThemes]);

  // Load theme from backend config on mount and on focus regain.
  useEffect(() => {
    const loadTheme = async () => {
      try {
        const config = await apiClient.get<{ theme?: { mode: string; light_theme: string; dark_theme: string; custom_themes?: any[] } }>("/api/v1/config");
        const t = config.theme;
        if (t) {
          if (t.mode) setMode(t.mode as ThemeMode);
          if (t.light_theme) setLightThemeId(t.light_theme);
          if (t.dark_theme) setDarkThemeId(t.dark_theme);
          if (t.custom_themes) {
            const parsed: Theme[] = t.custom_themes.map(ct => ({
              id: ct.id,
              name: ct.name,
              colors: {
                bg: ct.colors.bg,
                bgSecondary: ct.colors.bg_secondary,
                bgTertiary: ct.colors.bg_tertiary,
                border: ct.colors.border,
                text: ct.colors.text,
                textMuted: ct.colors.text_muted,
                highlight: ct.colors.highlight,
                accent: ct.colors.accent,
                success: ct.colors.success,
                warning: ct.colors.warning,
                error: ct.colors.error,
                info: ct.colors.info,
              },
              accentPalette: ct.accent_palette,
              isLight: ct.is_light,
              isCustom: true,
            }));
            setCustomThemes(parsed);
          }
        }
      } catch (error) {
        console.error("Failed to load theme from config:", error);
      }
    };

    loadTheme();
    window.addEventListener("focus", loadTheme);
    return () => window.removeEventListener("focus", loadTheme);
  }, []);

  // Listen for system theme changes
  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (e: MediaQueryListEvent) => setSystemIsDark(e.matches);
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  // Resolve the actual theme to use
  const theme = useMemo<Theme>(() => {
    const targetId = mode === "auto" 
      ? (systemIsDark ? darkThemeId : lightThemeId)
      : (mode === "dark" ? darkThemeId : lightThemeId);
    
    return allThemes.find(t => t.id === targetId) || (systemIsDark ? builtInThemes.find(t => t.id === "dark")! : builtInThemes.find(t => t.id === "light")!);
  }, [mode, lightThemeId, darkThemeId, systemIsDark, allThemes]);

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
    root.style.setProperty("--grove-text", colors.text);
    root.style.setProperty("--grove-bg", colors.bg);
    root.style.setProperty("--color-highlight", colors.highlight);
    root.style.setProperty("--color-accent", colors.accent);
    root.style.setProperty("--color-success", colors.success);
    root.style.setProperty("--color-warning", colors.warning);
    root.style.setProperty("--color-error", colors.error);
    root.style.setProperty("--color-info", colors.info);
  }, [theme]);

  const setAppearance = useCallback(async (params: { mode?: ThemeMode; lightThemeId?: string; darkThemeId?: string; customThemes?: Theme[] }) => {
    if (params.mode !== undefined) setMode(params.mode);
    if (params.lightThemeId !== undefined) setLightThemeId(params.lightThemeId);
    if (params.darkThemeId !== undefined) setDarkThemeId(params.darkThemeId);
    if (params.customThemes !== undefined) setCustomThemes(params.customThemes);

    // Persist to backend
    try {
      await apiClient.patch("/api/v1/config", {
        theme: {
          mode: params.mode,
          light_theme: params.lightThemeId,
          dark_theme: params.darkThemeId,
          custom_themes: params.customThemes?.map(ct => ({
            id: ct.id,
            name: ct.name,
            colors: {
              bg: ct.colors.bg,
              bg_secondary: ct.colors.bgSecondary,
              bg_tertiary: ct.colors.bgTertiary,
              border: ct.colors.border,
              text: ct.colors.text,
              text_muted: ct.colors.textMuted,
              highlight: ct.colors.highlight,
              accent: ct.colors.accent,
              success: ct.colors.success,
              warning: ct.colors.warning,
              error: ct.colors.error,
              info: ct.colors.info,
            },
            accent_palette: ct.accentPalette,
            is_light: ct.isLight,
          }))
        }
      });
    } catch (error) {
      console.error("Failed to save appearance to backend:", error);
    }
  }, []);

  return (
    <ThemeContext.Provider value={{ 
      theme, 
      mode, 
      lightThemeId, 
      darkThemeId, 
      customThemes, 
      themes: allThemes,
      setAppearance 
    }}>
      {children}
    </ThemeContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within ThemeProvider");
  return context;
}
