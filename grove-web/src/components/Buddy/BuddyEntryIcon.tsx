import { useContext } from "react";
import { Sprout } from "lucide-react";
import { BuddyLaunchContext } from "./buddyLaunchContext";
export function BuddyEntryIcon({ className }: { className?: string }) {
  const { items } = useContext(BuddyLaunchContext);
  return <span className="relative inline-flex"><Sprout size={16} strokeWidth={1.6} className={className} />{items.some(item => item.status === "waiting") && <span aria-label="Buddies need approval" className="absolute -right-0.5 -top-0.5 h-[7px] w-[7px] rounded-full bg-[var(--color-warning)]" />}</span>;
}
export function BuddyWaitingCount() {
  const { items } = useContext(BuddyLaunchContext);
  const count = items.filter(item => item.status === "waiting").length;
  return count ? <span className="ml-auto rounded px-1.5 text-xs bg-[var(--color-warning)]/15 text-[var(--color-warning)]">{count}</span> : null;
}
