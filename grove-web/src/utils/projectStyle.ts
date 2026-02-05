import {
  Folder,
  Box,
  Code2,
  Cpu,
  Database,
  Flame,
  Gem,
  Globe,
  Heart,
  Hexagon,
  Layers,
  Leaf,
  Lightbulb,
  Mountain,
  Music,
  Palette,
  Rocket,
  Shield,
  Sparkles,
  Star,
  Sun,
  Zap,
  type LucideIcon,
} from "lucide-react";

// Color palette for project icons
export const PROJECT_COLORS = [
  { bg: "#ef4444", fg: "#ffffff" }, // Red
  { bg: "#f97316", fg: "#ffffff" }, // Orange
  { bg: "#f59e0b", fg: "#ffffff" }, // Amber
  { bg: "#eab308", fg: "#ffffff" }, // Yellow
  { bg: "#84cc16", fg: "#ffffff" }, // Lime
  { bg: "#22c55e", fg: "#ffffff" }, // Green
  { bg: "#10b981", fg: "#ffffff" }, // Emerald
  { bg: "#14b8a6", fg: "#ffffff" }, // Teal
  { bg: "#06b6d4", fg: "#ffffff" }, // Cyan
  { bg: "#0ea5e9", fg: "#ffffff" }, // Sky
  { bg: "#3b82f6", fg: "#ffffff" }, // Blue
  { bg: "#6366f1", fg: "#ffffff" }, // Indigo
  { bg: "#8b5cf6", fg: "#ffffff" }, // Violet
  { bg: "#a855f7", fg: "#ffffff" }, // Purple
  { bg: "#d946ef", fg: "#ffffff" }, // Fuchsia
  { bg: "#ec4899", fg: "#ffffff" }, // Pink
  { bg: "#f43f5e", fg: "#ffffff" }, // Rose
];

// Icons for projects
export const PROJECT_ICONS: LucideIcon[] = [
  Folder, Box, Code2, Cpu, Database, Flame, Gem, Globe,
  Heart, Hexagon, Layers, Leaf, Lightbulb, Mountain, Music,
  Palette, Rocket, Shield, Sparkles, Star, Sun, Zap,
];

// FNV-1a hash - better distribution for similar strings
function fnv1aHash(str: string): number {
  let hash = 2166136261; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619); // FNV prime
  }
  return hash >>> 0; // Convert to unsigned 32-bit
}

// Secondary hash using different seed for more variation
function secondaryHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 7) - hash + char * (i + 1)) | 0;
  }
  return Math.abs(hash);
}

// Convert hex color to rgba with alpha
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Get consistent color and icon for a project
// When accentPalette is provided, uses theme-aware colors instead of fixed colors
export function getProjectStyle(projectId: string, accentPalette?: string[]) {
  // Use two different hash functions for color and icon
  // This ensures similar project names get different colors AND icons
  const colorHash = fnv1aHash(projectId);
  const iconHash = secondaryHash(projectId + "_icon"); // Add suffix for more variation

  const iconIndex = iconHash % PROJECT_ICONS.length;

  let color: { bg: string; fg: string };

  if (accentPalette && accentPalette.length > 0) {
    const colorIndex = colorHash % accentPalette.length;
    const fg = accentPalette[colorIndex];
    color = { bg: hexToRgba(fg, 0.15), fg };
  } else {
    const colorIndex = colorHash % PROJECT_COLORS.length;
    color = PROJECT_COLORS[colorIndex];
  }

  return {
    color,
    Icon: PROJECT_ICONS[iconIndex],
  };
}
