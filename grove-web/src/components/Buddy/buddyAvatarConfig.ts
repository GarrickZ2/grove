export const BUDDY_AVATAR_SHAPES = ["circle", "blob", "squircle", "drop"] as const;
export const BUDDY_AVATAR_COLORS = ["#10b981", "#14b8a6", "#3b82f6", "#6366f1", "#8b5cf6", "#f59e0b", "#ef4444"] as const;
export type BuddyAvatarShape = typeof BUDDY_AVATAR_SHAPES[number];
export type BuddyAvatarColor = typeof BUDDY_AVATAR_COLORS[number];
export interface BuddyAvatarValue { shape: BuddyAvatarShape; color: BuddyAvatarColor }
export const BUDDY_AVATAR_RADIUS: Record<BuddyAvatarShape, string> = {
  circle: "50%", blob: "58% 42% 52% 48% / 48% 56% 44% 52%", squircle: "32%", drop: "50% 50% 50% 14%",
};
/** Avatars saved by the interim "forest friends" builds stored `{kind, color}` with named colors. */
const LEGACY_SHAPES: Record<string, BuddyAvatarShape> = { mushroom: "circle", acorn: "blob", leaf: "drop", sprout: "squircle", pot: "squircle" };
const LEGACY_COLORS: Record<string, BuddyAvatarColor> = { sun: "#f59e0b", blossom: "#ef4444", berry: "#8b5cf6", lagoon: "#14b8a6", leaf: "#10b981", dusk: "#6366f1" };
export function resolveBuddyAvatar(id: string, avatar?: string | null): BuddyAvatarValue {
  try {
    const value = JSON.parse(avatar || "null") as { shape?: string; kind?: string; color?: string } | null;
    const shape = value?.shape ?? (value?.kind ? LEGACY_SHAPES[value.kind] : undefined);
    const color = value?.color && (LEGACY_COLORS[value.color] ?? value.color);
    if (BUDDY_AVATAR_SHAPES.includes(shape as BuddyAvatarShape) && BUDDY_AVATAR_COLORS.includes(color as BuddyAvatarColor)) {
      return { shape: shape as BuddyAvatarShape, color: color as BuddyAvatarColor };
    }
  } catch { /* Unreadable values use the stable fallback. */ }
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619) >>> 0;
  return { shape: BUDDY_AVATAR_SHAPES[hash % 4], color: BUDDY_AVATAR_COLORS[Math.floor(hash / 4) % 7] };
}
