import { apiClient } from "../api/client";
import type { ThemeConfig } from "../api/config";
import { builtInThemes, type Theme } from "../context/ThemeContext";
import { appIconAssetUrl, normalizeAppIconStyle } from "../data/appIcons";

/** What the launch page needs from the user's appearance settings. */
export interface LaunchLook {
  isLight: boolean;
  /** The configured application icon, in the variant for this light/dark. */
  iconUrl: string;
  /** The aura's three hues, from the theme's highlight, accent and info colors. */
  aura: [string, string, string];
  /** Wordmark color. */
  text: string;
}

/** Don't hold the launch for a slow config: past this, fall back to the system look. */
const CONFIG_TIMEOUT_MS = 400;

function systemIsDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
}

function customThemes(config: Partial<ThemeConfig>): Theme[] {
  return (config.custom_themes ?? []).map((ct) => ({
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
}

/** Resolve the active theme the same way ThemeProvider does. */
export function resolveLaunchLook(config: Partial<ThemeConfig> | null): LaunchLook {
  const dark = systemIsDark();
  const mode = config?.mode ?? "auto";
  const useDark = mode === "auto" ? dark : mode === "dark";
  const targetId = useDark ? (config?.dark_theme ?? "dark") : (config?.light_theme ?? "light");
  const all = [...builtInThemes, ...(config ? customThemes(config) : [])];
  const theme = all.find((t) => t.id === targetId)
    ?? builtInThemes.find((t) => t.id === (useDark ? "dark" : "light"))!;
  const style = normalizeAppIconStyle(config?.app_icon);
  const iconUrl = style === "classic"
    ? (theme.isLight ? "/favicon-light.svg" : "/favicon.svg")
    : appIconAssetUrl(style, theme.isLight);
  const { accent, highlight, info } = theme.colors;
  return { isLight: theme.isLight, iconUrl, aura: [highlight, accent, info], text: theme.colors.text };
}

export async function loadLaunchLook(): Promise<LaunchLook> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), CONFIG_TIMEOUT_MS);
  try {
    const config = await apiClient.get<{ theme?: Partial<ThemeConfig> }>("/api/v1/config", controller.signal);
    return resolveLaunchLook(config.theme ?? null);
  } catch {
    return resolveLaunchLook(null);
  } finally {
    window.clearTimeout(timer);
  }
}

/** Apply the look as CSS variables (and the icon) before the animation starts. */
export function applyLaunchLook(look: LaunchLook, stage: HTMLElement): void {
  const style = stage.style;
  style.setProperty("--gl-a1", look.aura[0]);
  style.setProperty("--gl-a2", look.aura[1]);
  style.setProperty("--gl-a3", look.aura[2]);
  style.setProperty("--gl-text", look.text);
  style.setProperty("--gl-icon", `url("${look.iconUrl}")`);
  stage.classList.toggle("is-light", look.isLight);
  stage.querySelector<HTMLImageElement>(".gl-mark img")?.setAttribute("src", look.iconUrl);
}
