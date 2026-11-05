import { useEffect, useMemo, useState } from "react";
import { listReachableBuddies, type BuddySummary } from "../../api/buddies";
import { useOptionalConfig } from "../../context/ConfigContext";

const REFRESH_MS = 30_000;

/** Buddies on the connected machines, for @-mentions. Off with the machine switcher. */
export function useReachableBuddies(others: BuddySummary[]): BuddySummary[] {
  // The mini window can run without the config provider; it just stays on this machine.
  const enabled = useOptionalConfig()?.config?.web?.multi_machine === true;
  const [reachable, setReachable] = useState<BuddySummary[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () => { void listReachableBuddies().then((buddies) => { if (live) setReachable(buddies); }).catch(() => undefined); };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [enabled]);
  return useMemo(() => enabled && reachable.length ? [...others, ...reachable] : others, [enabled, others, reachable]);
}
