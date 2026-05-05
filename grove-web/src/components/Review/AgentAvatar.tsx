// Agent avatar component — delegates to resolveAgentIcon() from agentIcon.ts
// so icon resolution is unified across TaskGraph, TaskChat, and Review panels.
// Unknown agents get a Boring Avatars marble pattern instead of the generic Bot icon.

import { type CSSProperties, useMemo } from 'react';
import Avatar from 'boring-avatars';
import { Bot } from 'lucide-react';
import { resolveAgentIcon } from '../../utils/agentIcon';

// Boring-Avatars renders into SVG `fill` attributes, so CSS vars don't resolve there —
// we hash a name to one of these fixed palettes. Hues are picked to look acceptable on
// both light and dark themes; not theme-tinted by design.
const MARBLE_PALETTES: string[][] = [
  ['#6366f1', '#8b5cf6', '#a78bfa', '#c4b5fd'],
  ['#f43f5e', '#ec4899', '#f472b6', '#f9a8d4'],
  ['#f97316', '#f59e0b', '#fbbf24', '#fcd34d'],
  ['#22c55e', '#14b8a6', '#2dd4bf', '#5eead4'],
  ['#3b82f6', '#06b6d4', '#22d3ee', '#67e8f9'],
  ['#8b5cf6', '#d946ef', '#e879f9', '#f0abfc'],
  ['#ef4444', '#f97316', '#fb923c', '#fdba74'],
  ['#0ea5e9', '#6366f1', '#818cf8', '#a5b4fc'],
];

function hashPalette(name: string): string[] {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return MARBLE_PALETTES[Math.abs(h) % MARBLE_PALETTES.length];
}

interface AgentAvatarProps {
  agent: string;
  size: number;
  className?: string;
  style?: CSSProperties;
}

export function AgentAvatar({ agent, size, className, style }: AgentAvatarProps) {
  const info = resolveAgentIcon(agent);
  const isFallback = info.Component === Bot;

  const colors = useMemo(() => hashPalette(agent || 'unknown'), [agent]);

  return (
    <span
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        overflow: 'hidden',
        ...style,
      }}
    >
      {isFallback ? (
        <Avatar variant="beam" name={agent || 'unknown'} colors={colors} size={size} square={false} />
      ) : (
        <info.Component size={Math.round(size * 0.8)} />
      )}
    </span>
  );
}

/** Mini version for gutter — returns just the icon or initial, sized for gutter */
export function GutterAvatar({ agent }: { agent: string }) {
  return <AgentAvatar agent={agent} size={18} className="diff-gutter-avatar" />;
}
