interface KeyBadgeProps {
  children: string;
  className?: string;
}

export function KeyBadge({ children, className = "" }: KeyBadgeProps) {
  return (
    <kbd
      className={`
        inline-flex items-center justify-center
        px-1 py-0.5 min-w-[18px]
        text-[10px] font-mono leading-none
        rounded border
        bg-[var(--color-bg)] border-[var(--color-border)]
        text-[var(--color-text-muted)]
        ${className}
      `}
    >
      {children}
    </kbd>
  );
}
