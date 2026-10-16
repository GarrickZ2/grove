import { Server } from 'lucide-react';

/** Compact title-row entry; server actions live on the management page. */
export function IosServerMenu() {
  return (
    <a href="/_grove/" aria-label="Manage servers" title="Manage servers"
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]">
      <Server className="h-4 w-4" />
    </a>
  );
}
