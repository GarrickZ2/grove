import { useMemo } from "react";
import BoringAvatar from "boring-avatars";
import { UserRound } from "lucide-react";
import type { BoardMember } from "./types";

const PALETTES: string[][] = [
  ["#6366f1", "#8b5cf6", "#a78bfa", "#c4b5fd"],
  ["#f43f5e", "#ec4899", "#f472b6", "#f9a8d4"],
  ["#f97316", "#f59e0b", "#fbbf24", "#fcd34d"],
  ["#22c55e", "#14b8a6", "#2dd4bf", "#5eead4"],
  ["#3b82f6", "#06b6d4", "#22d3ee", "#67e8f9"],
  ["#8b5cf6", "#d946ef", "#e879f9", "#f0abfc"],
  ["#ef4444", "#f97316", "#fb923c", "#fdba74"],
  ["#0ea5e9", "#6366f1", "#818cf8", "#a5b4fc"],
];

function hashPalette(seed: string): string[] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return PALETTES[Math.abs(h) % PALETTES.length];
}

interface AvatarProps {
  member?: BoardMember;
  size?: number;
  ringClass?: string;
}

export function Avatar({ member, size = 22, ringClass }: AvatarProps) {
  const seed = member?.email ?? "unassigned";
  const colors = useMemo(() => hashPalette(seed), [seed]);

  if (!member) {
    return (
      <span
        className={`inline-flex items-center justify-center rounded-full border border-dashed border-[var(--color-border)] text-[var(--color-text-muted)] flex-shrink-0 ${ringClass ?? ""}`}
        style={{ width: size, height: size }}
        title="Unassigned"
      >
        <UserRound style={{ width: size * 0.5, height: size * 0.5 }} />
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center justify-center flex-shrink-0 overflow-hidden ${ringClass ?? ""}`}
      style={{ width: size, height: size, borderRadius: "50%" }}
      title={`${member.name} · ${member.email}`}
    >
      <BoringAvatar variant="beam" name={seed} colors={colors} size={size} square={false} />
    </span>
  );
}
