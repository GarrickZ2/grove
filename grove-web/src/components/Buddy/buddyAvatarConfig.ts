import type { CSSProperties } from "react";
export const BUDDY_AVATAR_SHAPES = ["circle", "blob", "squircle", "drop", "egg", "pebble", "leaf", "hexagon", "flower", "heart", "ghost", "star"] as const;
/** Fallback avatars hash into the original four shapes so existing Buddies keep their look. */
const FALLBACK_SHAPE_COUNT = 4;
export const BUDDY_AVATAR_COLORS = ["#10b981", "#14b8a6", "#3b82f6", "#6366f1", "#8b5cf6", "#f59e0b", "#ef4444"] as const;
export type BuddyAvatarShape = typeof BUDDY_AVATAR_SHAPES[number];
export type BuddyAvatarColor = typeof BUDDY_AVATAR_COLORS[number];
export interface BuddyAvatarValue { shape: BuddyAvatarShape; color: BuddyAvatarColor }
/** Rounded-corner shapes. */
export const BUDDY_AVATAR_RADIUS: Partial<Record<BuddyAvatarShape, string>> = {
  circle: "50%", blob: "58% 42% 52% 48% / 48% 56% 44% 52%", squircle: "32%", drop: "50% 50% 50% 14%",
  egg: "50% 50% 50% 50% / 58% 58% 42% 42%", pebble: "42% 58% 64% 36% / 46% 40% 60% 54%", leaf: "60% 10% 60% 10%",
};
/** Shapes a border radius can't draw, as SVG masks on a 100×100 box. Round stroke joins soften polygon corners. */
const svg = (body: string) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>${body}</svg>`)}")`;
const BUDDY_AVATAR_MASKS: Partial<Record<BuddyAvatarShape, string>> = {
  hexagon: svg("<polygon points='50,8 88,30 88,70 50,92 12,70 12,30' stroke='black' stroke-width='12' stroke-linejoin='round'/>"),
  flower: svg("<circle cx='50.0' cy='23.0' r='22'/><circle cx='73.4' cy='36.5' r='22'/><circle cx='73.4' cy='63.5' r='22'/><circle cx='50.0' cy='77.0' r='22'/><circle cx='26.6' cy='63.5' r='22'/><circle cx='26.6' cy='36.5' r='22'/><circle cx='50' cy='50' r='30'/>"),
  heart: svg("<path d='M50 92C22 72 4 56 4 34 4 17 17 6 31 6c8 0 15 4 19 11 4-7 11-11 19-11 14 0 27 11 27 28 0 22-18 38-46 58z'/>"),
  ghost: svg("<path d='M10 48C10 24 28 6 50 6s40 18 40 42v44c-6 0-8-8-13.3-8S70 92 63.3 92 56.7 84 50 84s-6.7 8-13.3 8S30 84 23.3 84 16 92 10 92z'/>"),
  star: svg("<polygon points='50.0,11.0 65.9,31.2 89.9,40.0 75.7,61.3 74.7,87.0 50.0,80.0 25.3,87.0 24.3,61.3 10.1,40.0 34.1,31.2' stroke='black' stroke-width='12' stroke-linejoin='round'/>"),
};
/** Inline style for a shape at any size. Masked shapes lose the inset edge shading, so they get a soft highlight instead. */
export function buddyAvatarShapeStyle(shape: BuddyAvatarShape, color: string): CSSProperties {
  const mask = BUDDY_AVATAR_MASKS[shape];
  if (!mask) return { borderRadius: BUDDY_AVATAR_RADIUS[shape], background: color };
  return { background: `radial-gradient(circle at 34% 26%, rgba(255,255,255,.3), transparent 52%), linear-gradient(transparent 55%, rgba(0,0,0,.14)), ${color}`, WebkitMask: `${mask} center / 100% 100% no-repeat`, mask: `${mask} center / 100% 100% no-repeat` };
}
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
  return { shape: BUDDY_AVATAR_SHAPES[hash % FALLBACK_SHAPE_COUNT], color: BUDDY_AVATAR_COLORS[Math.floor(hash / 4) % 7] };
}
