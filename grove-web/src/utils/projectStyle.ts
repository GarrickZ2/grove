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

// Get consistent color and icon for a project
export function getProjectStyle(projectId: string) {
  // Use two different hash functions for color and icon
  // This ensures similar project names get different colors AND icons
  const colorHash = fnv1aHash(projectId);
  const iconHash = secondaryHash(projectId + "_icon"); // Add suffix for more variation

  const colorIndex = colorHash % PROJECT_COLORS.length;
  const iconIndex = iconHash % PROJECT_ICONS.length;

  return {
    color: PROJECT_COLORS[colorIndex],
    Icon: PROJECT_ICONS[iconIndex],
  };
}
